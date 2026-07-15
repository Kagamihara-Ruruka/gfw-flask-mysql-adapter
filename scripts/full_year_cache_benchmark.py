"""Audit sampled-grid playback and canonical snapshot reuse over full date ranges."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def fetch_json(url: str, timeout: float) -> dict[str, Any]:
    request = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail[:500]}") from exc
    except URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc
    if not isinstance(payload, dict):
        raise RuntimeError("endpoint returned a non-object JSON payload")
    if payload.get("error"):
        raise RuntimeError(str(payload["error"]))
    return payload


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return round(ordered[index], 3)


def record_url(
    base_url: str,
    dataset_id: str,
    *,
    date: str,
    bbox: str,
    resolution: float,
) -> str:
    query = urlencode(
        {
            "date": date,
            "bbox": bbox,
            "limit": "max",
            "columns": "render",
            "resolution": resolution,
        }
    )
    return f"{base_url}/api/datasets/{quote(dataset_id, safe='')}/records?{query}"


def fetch_snapshot(
    base_url: str,
    dataset_id: str,
    *,
    date: str,
    bbox: str,
    resolution: float,
    timeout: float,
) -> dict[str, Any]:
    started = time.perf_counter()
    payload = fetch_json(
        record_url(
            base_url,
            dataset_id,
            date=date,
            bbox=bbox,
            resolution=resolution,
        ),
        timeout,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    timing = payload.get("timing") if isinstance(payload.get("timing"), dict) else {}
    grid = payload.get("grid") if isinstance(payload.get("grid"), dict) else {}
    return {
        "date": date,
        "elapsed_ms": round(elapsed_ms, 3),
        "api_total_ms": float(timing.get("api_total_ms") or 0),
        "query_ms": float(timing.get("query_ms") or 0),
        "cache_hit": bool(timing.get("cache_hit")),
        "cache_namespace_entries": int(timing.get("cache_namespace_entries") or 0),
        "cache_total_entries": int(timing.get("cache_total_entries") or 0),
        "cache_total_rows": int(timing.get("cache_total_rows") or 0),
        "cache_max_rows": timing.get("cache_max_rows"),
        "row_count": len(payload.get("rows") or []),
        "actual_resolution_km": grid.get("actual_resolution_km"),
        "lod_degraded": bool(grid.get("lod_degraded")),
    }


def run_pass(
    base_url: str,
    dataset_id: str,
    dates: list[str],
    *,
    bbox: str,
    resolution: float,
    concurrency: int,
    timeout: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    started = time.perf_counter()
    results: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {
            executor.submit(
                fetch_snapshot,
                base_url,
                dataset_id,
                date=date,
                bbox=bbox,
                resolution=resolution,
                timeout=timeout,
            ): date
            for date in dates
        }
        for future in as_completed(futures):
            date = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:  # noqa: BLE001 - benchmark records every request failure.
                failures.append({"date": date, "error": str(exc)})
    wall_ms = (time.perf_counter() - started) * 1000
    elapsed = [float(row["elapsed_ms"]) for row in results]
    api = [float(row["api_total_ms"]) for row in results]
    summary = {
        "requested": len(dates),
        "completed": len(results),
        "failed": len(failures),
        "wall_ms": round(wall_ms, 3),
        "throughput_dates_per_second": round(len(results) / max(wall_ms / 1000, 1e-9), 3),
        "elapsed_ms": {
            "median": round(statistics.median(elapsed), 3) if elapsed else None,
            "p95": percentile(elapsed, 0.95),
            "max": round(max(elapsed), 3) if elapsed else None,
        },
        "api_total_ms": {
            "median": round(statistics.median(api), 3) if api else None,
            "p95": percentile(api, 0.95),
            "max": round(max(api), 3) if api else None,
        },
        "cache_hits": sum(bool(row["cache_hit"]) for row in results),
        "cache_high_water": {
            "entries": max((int(row["cache_total_entries"]) for row in results), default=0),
            "rows": max((int(row["cache_total_rows"]) for row in results), default=0),
            "max_rows": next(
                (row["cache_max_rows"] for row in results if row["cache_max_rows"] is not None),
                None,
            ),
        },
        "rows": sum(int(row["row_count"]) for row in results),
        "lod_degraded": sum(bool(row["lod_degraded"]) for row in results),
        "actual_resolutions_km": sorted(
            {
                float(row["actual_resolution_km"])
                for row in results
                if row["actual_resolution_km"] is not None
            }
        ),
        "failures": failures[:20],
    }
    return summary, results


def dataset_schema(base_url: str, dataset_id: str, timeout: float) -> dict[str, Any]:
    return fetch_json(
        f"{base_url}/api/datasets/{quote(dataset_id, safe='')}/schema",
        timeout,
    )


def benchmark_dataset(
    base_url: str,
    dataset_id: str,
    dataset: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    schema = dataset_schema(base_url, dataset_id, args.timeout)
    dates = sorted({str(value) for value in schema.get("dates") or [] if str(value)})
    if args.date_limit > 0:
        dates = dates[: args.date_limit]
    resolutions = dataset.get("sampled_grid", {}).get("available_resolutions_km") or []
    resolution = args.resolution or min(float(value) for value in resolutions)
    first_pass, _results = run_pass(
        base_url,
        dataset_id,
        dates,
        bbox=args.bbox,
        resolution=resolution,
        concurrency=args.concurrency,
        timeout=args.timeout,
    )
    warm_dates = dates[-min(len(dates), args.warm_window) :]
    warm_pass, _warm_results = run_pass(
        base_url,
        dataset_id,
        warm_dates,
        bbox=args.bbox,
        resolution=resolution,
        concurrency=args.concurrency,
        timeout=args.timeout,
    )
    anchor = dates[-1] if dates else None
    interaction_probes: dict[str, Any] = {}
    if anchor:
        for name, bbox in {
            "drag_same_coverage": args.drag_bbox,
            "selected_tile": args.selection_bbox,
        }.items():
            interaction_probes[name] = fetch_snapshot(
                base_url,
                dataset_id,
                date=anchor,
                bbox=bbox,
                resolution=resolution,
                timeout=args.timeout,
            )
        coarser = next((float(value) for value in resolutions if float(value) > resolution), None)
        if coarser is not None:
            interaction_probes["coarser_lod_first"] = fetch_snapshot(
                base_url,
                dataset_id,
                date=anchor,
                bbox=args.bbox,
                resolution=coarser,
                timeout=args.timeout,
            )
            interaction_probes["coarser_lod_second"] = fetch_snapshot(
                base_url,
                dataset_id,
                date=anchor,
                bbox=args.bbox,
                resolution=coarser,
                timeout=args.timeout,
            )
    return {
        "dataset_id": dataset_id,
        "date_count": len(dates),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "requested_resolution_km": resolution,
        "bbox": args.bbox,
        "concurrency": args.concurrency,
        "first_pass": first_pass,
        "warm_window_pass": warm_pass,
        "interaction_probes": interaction_probes,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5081")
    parser.add_argument("--dataset", action="append", dest="datasets", default=[])
    parser.add_argument("--bbox", default="120.5,22.5,122,25.5")
    parser.add_argument("--drag-bbox", default="120.75,22.75,122.25,25.75")
    parser.add_argument("--selection-bbox", default="121,23.5,121.041666667,23.541666667")
    parser.add_argument("--resolution", type=float, default=None)
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--warm-window", type=int, default=30)
    parser.add_argument("--date-limit", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error("--concurrency must be positive")
    if args.warm_window < 1:
        parser.error("--warm-window must be positive")
    return args


def main() -> int:
    args = parse_args()
    base_url = args.base_url.rstrip("/")
    catalog = fetch_json(f"{base_url}/api/datasets", args.timeout)
    datasets = catalog.get("datasets") if isinstance(catalog.get("datasets"), dict) else {}
    selected = args.datasets or sorted(datasets)
    unknown = [dataset_id for dataset_id in selected if dataset_id not in datasets]
    if unknown:
        raise SystemExit(f"unknown datasets: {', '.join(unknown)}")
    started = time.perf_counter()
    report = {
        "schema": "rrkal.full_year_cache_benchmark.v1",
        "base_url": base_url,
        "started_at_epoch": time.time(),
        "results": [
            benchmark_dataset(base_url, dataset_id, datasets[dataset_id], args)
            for dataset_id in selected
        ],
    }
    report["wall_ms"] = round((time.perf_counter() - started) * 1000, 3)
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    print(encoded)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
