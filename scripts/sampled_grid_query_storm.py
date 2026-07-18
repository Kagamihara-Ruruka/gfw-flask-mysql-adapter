"""Exercise sampled-grid request coalescing and mixed-provider load."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from typing import Any
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.sampled_grid_batch_benchmark import (  # noqa: E402
    batch_envelope,
    fetch_batch,
    fetch_json,
)


DEFAULT_DATASETS = (
    "pipeline_iceberg.chlor_a",
    "pipeline_iceberg.fishing_hours",
    "pipeline_iceberg.ocean_productivity_score",
    "pipeline_iceberg.sea_temperature",
    "pipeline_iceberg.sustainability_pressure",
)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return round(ordered[index], 3)


def distribution(values: list[float]) -> dict[str, float]:
    return {
        "p50": round(statistics.median(values), 3),
        "p95": percentile(values, 0.95),
        "max": round(max(values), 3),
    }


def operation(
    base_url: str,
    *,
    dataset_id: str,
    date: str,
    bbox: str,
    resolution: float,
    timeout: float,
    sequence: int,
    start_event: Event,
) -> dict[str, Any]:
    start_event.wait()
    result = fetch_batch(
        base_url,
        batch_envelope(
            dataset_id,
            [date],
            sequence=sequence,
            bbox=bbox,
            resolution=resolution,
        ),
        timeout,
    )
    event = (result.get("results") or [{}])[0]
    packet = event.get("packet") if isinstance(event.get("packet"), dict) else {}
    timing = packet.get("timing") if isinstance(packet.get("timing"), dict) else {}
    return {
        "dataset_id": dataset_id,
        "date": date,
        "ok": result.get("status") == 200 and event.get("status") == "ok",
        "elapsed_ms": float(result.get("elapsed_ms") or 0),
        "row_count": int(packet.get("row_count") or 0),
        "source_request_count": int(timing.get("source_request_count") or 0),
        "cache_hit": bool(timing.get("cache_hit")),
        "cache_waited": bool(timing.get("cache_waited")),
        "canonicalize_rows_ms": float(timing.get("canonicalize_rows_ms") or 0),
        "source_capacity_wait_ms": float(timing.get("source_capacity_wait_ms") or 0),
        "error": result.get("error") or event.get("error"),
    }


def run_storm(
    base_url: str,
    jobs: list[tuple[str, str]],
    *,
    clients: int,
    bbox: str,
    resolution: float,
    timeout: float,
    sequence_start: int,
) -> tuple[list[dict[str, Any]], float]:
    start_event = Event()
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=clients) as executor:
        futures = [
            executor.submit(
                operation,
                base_url,
                dataset_id=dataset_id,
                date=date,
                bbox=bbox,
                resolution=resolution,
                timeout=timeout,
                sequence=sequence_start + index,
                start_event=start_event,
            )
            for index, (dataset_id, date) in enumerate(jobs)
        ]
        start_event.set()
        results = [future.result() for future in futures]
    return results, (time.perf_counter() - started) * 1000


def summarize(results: list[dict[str, Any]], wall_ms: float) -> dict[str, Any]:
    completed = sum(bool(item["ok"]) for item in results)
    return {
        "requests": len(results),
        "completed": completed,
        "failed": len(results) - completed,
        "wall_ms": round(wall_ms, 3),
        "throughput_fps": round(completed / max(wall_ms / 1000, 1e-9), 3),
        "latency_ms": distribution([float(item["elapsed_ms"]) for item in results]),
        "canonicalize_rows_ms": distribution([
            float(item["canonicalize_rows_ms"])
            for item in results
        ]),
        "source_capacity_wait_ms": distribution([
            float(item["source_capacity_wait_ms"])
            for item in results
        ]),
        "source_request_count": sum(int(item["source_request_count"]) for item in results),
        "cache_hits": sum(bool(item["cache_hit"]) for item in results),
        "cache_waited": sum(bool(item["cache_waited"]) for item in results),
        "row_counts": sorted({int(item["row_count"]) for item in results}),
        "failures": [
            {
                "dataset_id": item["dataset_id"],
                "date": item["date"],
                "error": item["error"],
            }
            for item in results
            if not item["ok"]
        ],
    }


def dates_for(base_url: str, dataset_id: str, timeout: float) -> list[str]:
    schema = fetch_json(
        f"{base_url.rstrip('/')}/api/datasets/{quote(dataset_id, safe='')}/schema",
        timeout,
    )
    return sorted(str(value) for value in schema.get("dates") or [] if str(value))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5083")
    parser.add_argument("--bbox", default="125,25,130,30")
    parser.add_argument("--resolution", type=float, default=4)
    parser.add_argument("--duplicate-clients", type=int, default=12)
    parser.add_argument("--mixed-clients", type=int, default=10)
    parser.add_argument("--dates-per-dataset", type=int, default=3)
    parser.add_argument("--minimum-throughput", type=float, default=0.86)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if min(args.duplicate_clients, args.mixed_clients, args.dates_per_dataset) < 1:
        parser.error("client and date counts must be positive")
    return args


def main() -> int:
    args = parse_args()
    available = {
        dataset_id: dates_for(args.base_url, dataset_id, args.timeout)
        for dataset_id in DEFAULT_DATASETS
    }
    minimum_dates = args.dates_per_dataset + 1
    missing = [
        dataset_id
        for dataset_id, dates in available.items()
        if len(dates) < minimum_dates
    ]
    if missing:
        raise SystemExit(f"datasets do not expose enough dates: {', '.join(missing)}")

    duplicate_dataset = "pipeline_iceberg.sea_temperature"
    duplicate_date = available[duplicate_dataset][0]
    duplicate_jobs = [
        (duplicate_dataset, duplicate_date)
        for _index in range(args.duplicate_clients)
    ]
    duplicate_results, duplicate_wall_ms = run_storm(
        args.base_url,
        duplicate_jobs,
        clients=args.duplicate_clients,
        bbox=args.bbox,
        resolution=args.resolution,
        timeout=args.timeout,
        sequence_start=10_000,
    )

    mixed_jobs = [
        (dataset_id, date)
        for dataset_id in DEFAULT_DATASETS
        for date in available[dataset_id][1 : args.dates_per_dataset + 1]
    ]
    mixed_results, mixed_wall_ms = run_storm(
        args.base_url,
        mixed_jobs,
        clients=args.mixed_clients,
        bbox=args.bbox,
        resolution=args.resolution,
        timeout=args.timeout,
        sequence_start=20_000,
    )

    duplicate = summarize(duplicate_results, duplicate_wall_ms)
    mixed = summarize(mixed_results, mixed_wall_ms)
    checks = {
        "duplicate_all_succeeded": duplicate["failed"] == 0,
        "duplicate_single_source_request": duplicate["source_request_count"] == 1,
        "mixed_all_succeeded": mixed["failed"] == 0,
        "mixed_one_source_request_per_frame": (
            mixed["source_request_count"] == len(mixed_jobs)
        ),
        "mixed_throughput_meets_floor": (
            mixed["throughput_fps"] >= args.minimum_throughput
        ),
    }
    report = {
        "schema": "rrkal.sampled_grid_query_storm.v1",
        "base_url": args.base_url,
        "bbox": args.bbox,
        "resolution_km": args.resolution,
        "minimum_throughput_fps": args.minimum_throughput,
        "duplicate_frame_storm": duplicate,
        "mixed_dataset_storm": mixed,
        "checks": checks,
        "passed": all(checks.values()),
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8", newline="\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
