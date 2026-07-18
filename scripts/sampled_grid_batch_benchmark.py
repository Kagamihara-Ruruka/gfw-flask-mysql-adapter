"""Compare direct sampled-grid supply with the 5081 batch transport."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return round(ordered[index], 3)


def distribution(values: list[float]) -> dict[str, float | None]:
    return {
        "p50": round(statistics.median(values), 3) if values else None,
        "p95": percentile(values, 0.95),
        "max": round(max(values), 3) if values else None,
    }


def read_response(request: Request, timeout: float) -> tuple[int, bytes, dict[str, str]]:
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), dict(response.headers.items())
    except HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers.items())


def fetch_json(url: str, timeout: float) -> dict[str, Any]:
    status, body, _headers = read_response(
        Request(url, headers={"Accept": "application/json"}),
        timeout,
    )
    payload = json.loads(body.decode("utf-8"))
    if status >= 400 or payload.get("error"):
        raise RuntimeError(payload.get("error") or f"HTTP {status}")
    return payload


def direct_source_snapshot(
    source_base_url: str,
    *,
    date: str,
    aoi: str,
    product: str,
    metric: str,
    resolution: float,
    timeout: float,
) -> dict[str, Any]:
    source_resolution = format(float(resolution), "g")
    query = urlencode(
        {
            "date": date,
            "aoi": aoi,
            "product": product,
            "metric": metric,
            "resolution": source_resolution,
        }
    )
    started_at = time.perf_counter()
    status, body, _headers = read_response(
        Request(f"{source_base_url.rstrip('/')}/gold/daily-grid?{query}"),
        timeout,
    )
    elapsed_ms = (time.perf_counter() - started_at) * 1000
    if status >= 400:
        raise RuntimeError(f"HTTP {status}: {body[:300].decode('utf-8', errors='replace')}")
    return {"date": date, "elapsed_ms": elapsed_ms, "response_bytes": len(body)}


def run_concurrent(
    dates: list[str],
    concurrency: int,
    operation: Callable[[str], dict[str, Any]],
) -> dict[str, Any]:
    started_at = time.perf_counter()
    results: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(operation, date): date for date in dates}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as exc:  # noqa: BLE001 - benchmark records every failure.
                failures.append({"date": futures[future], "error": str(exc)})
    wall_ms = (time.perf_counter() - started_at) * 1000
    return {
        "requested_frames": len(dates),
        "completed_frames": len(results),
        "failed_frames": len(failures),
        "wall_ms": round(wall_ms, 3),
        "throughput_fps": round(len(results) / max(wall_ms / 1000, 1e-9), 3),
        "http_ms": distribution([float(item["elapsed_ms"]) for item in results]),
        "response_bytes": distribution([float(item["response_bytes"]) for item in results]),
        "failures": failures[:10],
    }


def batch_envelope(
    dataset_id: str,
    dates: list[str],
    *,
    sequence: int,
    bbox: str,
    resolution: float,
) -> dict[str, Any]:
    return {
        "schema": "query_batch.v1",
        "batch_id": f"benchmark-{sequence}",
        "operations": [
            {
                "operation_id": f"benchmark-{sequence}-{index}",
                "kind": "sampled_grid.records",
                "dataset_id": dataset_id,
                "params": {
                    "date": date,
                    "bbox": bbox,
                    "limit": "max",
                    "columns": "render",
                    "resolution": resolution,
                },
            }
            for index, date in enumerate(dates)
        ],
    }


def fetch_batch(
    base_url: str,
    envelope: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    request = Request(
        f"{base_url.rstrip('/')}/api/query/batch",
        data=json.dumps(envelope, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/x-ndjson",
            "Accept-Encoding": "gzip",
            "Content-Type": "application/json",
        },
    )
    started_at = time.perf_counter()
    status, body, headers = read_response(request, timeout)
    elapsed_ms = (time.perf_counter() - started_at) * 1000
    if status >= 400:
        detail = json.loads(body.decode("utf-8"))
        return {"status": status, "error": str(detail.get("error") or detail)}
    wire_bytes = len(body)
    if str(headers.get("Content-Encoding") or headers.get("Content-encoding") or "").lower() == "gzip":
        body = gzip.decompress(body)
    events = [json.loads(line) for line in body.decode("utf-8").splitlines() if line]
    results = [event for event in events if event.get("type") == "batch.result"]
    metrics_event = next((event for event in events if event.get("type") == "batch.metrics"), {})
    return {
        "status": status,
        "elapsed_ms": elapsed_ms,
        "wire_bytes": wire_bytes,
        "results": results,
        "metrics": metrics_event.get("metrics") or {},
    }


def summarize_batch_pass(
    base_url: str,
    dataset_id: str,
    dates: list[str],
    *,
    batch_size: int,
    bbox: str,
    resolution: float,
    timeout: float,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    batches = []
    failures = []
    operation_timings: list[dict[str, Any]] = []
    for sequence, offset in enumerate(range(0, len(dates), batch_size), start=1):
        envelope = batch_envelope(
            dataset_id,
            dates[offset : offset + batch_size],
            sequence=sequence,
            bbox=bbox,
            resolution=resolution,
        )
        result = fetch_batch(base_url, envelope, timeout)
        if result.get("status") != 200:
            failures.append({"batch": sequence, "error": result.get("error")})
            continue
        batches.append(result)
        for event in result["results"]:
            if event.get("status") == "ok":
                timing = event.get("packet", {}).get("timing")
                operation_timings.append(timing if isinstance(timing, dict) else {})
            else:
                failures.append({"operation": event.get("operation_id"), "error": event.get("error")})
    wall_ms = (time.perf_counter() - started_at) * 1000
    phase_names = (
        "source_capacity_wait_ms",
        "source_http_ms",
        "source_json_decode_ms",
        "source_response_bytes",
        "canonicalize_rows_ms",
        "canonical_packet_copy_ms",
        "cache_lookup_ms",
        "cache_wait_ms",
        "cache_commit_ms",
        "cache_evict_ms",
        "filter_ms",
        "packet_projection_ms",
        "serialize_ms",
        "api_total_ms",
        "api_accounted_ms",
        "api_unattributed_ms",
    )
    phases = {
        phase: distribution([float(timing.get(phase) or 0) for timing in operation_timings])
        for phase in phase_names
    }
    completed_frames = len(operation_timings)
    api_phase_names = (
        "cache_lookup_ms",
        "cache_wait_ms",
        "source_http_ms",
        "source_json_decode_ms",
        "canonicalize_rows_ms",
        "canonical_packet_copy_ms",
        "cache_commit_ms",
        "cache_evict_ms",
        "filter_ms",
        "packet_projection_ms",
        "serialize_ms",
    )
    reconciliation_errors = []
    reconciliation_percentages = []
    for timing in operation_timings:
        total = float(timing.get("api_total_ms") or 0)
        accounted = sum(float(timing.get(name) or 0) for name in api_phase_names)
        accounted += float(timing.get("api_unattributed_ms") or 0)
        error = abs(total - accounted)
        reconciliation_errors.append(error)
        reconciliation_percentages.append((error / total) * 100 if total > 0 else 0.0)
    return {
        "batch_size": batch_size,
        "requested_frames": len(dates),
        "completed_frames": completed_frames,
        "failed_frames": len(failures),
        "wall_ms": round(wall_ms, 3),
        "throughput_fps": round(completed_frames / max(wall_ms / 1000, 1e-9), 3),
        "batch_http_ms": distribution([float(item["elapsed_ms"]) for item in batches]),
        "batch_wire_bytes": distribution([float(item["wire_bytes"]) for item in batches]),
        "transport_metrics": {
            name: distribution([float(item["metrics"].get(name) or 0) for item in batches])
            for name in (
                "batch_encode_ms",
                "batch_gzip_ms",
                "batch_yield_ms",
                "response_bytes",
                "uncompressed_bytes",
            )
        },
        "operation_phases": phases,
        "timing_reconciliation": {
            "absolute_error_ms": distribution(reconciliation_errors),
            "error_percent": distribution(reconciliation_percentages),
        },
        "cache_hits": sum(bool(timing.get("cache_hit")) for timing in operation_timings),
        "failures": failures[:10],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5081")
    parser.add_argument("--source-base-url", default="http://127.0.0.1:8791/api/v1")
    parser.add_argument("--dataset", default="pipeline_iceberg.sea_temperature")
    parser.add_argument("--aoi", default="taiwan")
    parser.add_argument("--bbox", default="118,20,124,27")
    parser.add_argument("--resolution", type=float, default=4)
    parser.add_argument("--frames", type=int, default=30)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if args.frames < 3:
        parser.error("--frames must be at least 3")
    return args


def main() -> int:
    args = parse_args()
    schema = fetch_json(
        f"{args.base_url.rstrip('/')}/api/datasets/{quote(args.dataset, safe='')}/schema",
        args.timeout,
    )
    dates = [str(value) for value in schema.get("dates") or []]
    if len(dates) < args.frames * 3:
        raise SystemExit("dataset does not have enough disjoint dates for the benchmark")
    catalog = fetch_json(f"{args.source_base_url.rstrip('/')}/catalog", args.timeout)
    metric_id = args.dataset.rsplit(".", 1)[-1]
    metric = next(
        (item for item in catalog.get("metrics") or [] if item.get("metric_id") == metric_id),
        None,
    )
    if metric is None:
        raise SystemExit(f"source catalog does not expose metric {metric_id}")

    direct_dates = dates[: args.frames]
    batch_one_dates = dates[args.frames : args.frames * 2]
    batch_two_dates = dates[args.frames * 2 : args.frames * 3]
    direct_operation = lambda date: direct_source_snapshot(  # noqa: E731
        args.source_base_url,
        date=date,
        aoi=args.aoi,
        product=str(metric["product_id"]),
        metric=metric_id,
        resolution=args.resolution,
        timeout=args.timeout,
    )
    report = {
        "schema": "rrkal.sampled_grid_batch_benchmark.v1",
        "dataset_id": args.dataset,
        "resolution_km": args.resolution,
        "frame_count_per_mode": args.frames,
        "direct_source": {
            "concurrency_1": run_concurrent(direct_dates, 1, direct_operation),
            "concurrency_2": run_concurrent(direct_dates, 2, direct_operation),
        },
        "adapter_5081": {},
    }
    for name, batch_size, selected_dates in (
        ("batch_1", 1, batch_one_dates),
        ("batch_2", 2, batch_two_dates),
    ):
        cold = summarize_batch_pass(
            args.base_url,
            args.dataset,
            selected_dates,
            batch_size=batch_size,
            bbox=args.bbox,
            resolution=args.resolution,
            timeout=args.timeout,
        )
        warm = summarize_batch_pass(
            args.base_url,
            args.dataset,
            selected_dates,
            batch_size=batch_size,
            bbox=args.bbox,
            resolution=args.resolution,
            timeout=args.timeout,
        )
        report["adapter_5081"][name] = {"cold": cold, "warm": warm}

    rejected = fetch_batch(
        args.base_url,
        batch_envelope(
            args.dataset,
            dates[-3:],
            sequence=999,
            bbox=args.bbox,
            resolution=args.resolution,
        ),
        args.timeout,
    )
    report["adapter_5081"]["batch_3_capacity_guard"] = rejected
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    print(encoded)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
