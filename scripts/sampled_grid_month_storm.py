"""Exercise the sampled-grid calendar-month playback query contract."""

from __future__ import annotations

import argparse
import calendar
import json
import math
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from threading import Event
from typing import Any
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.sampled_grid_batch_benchmark import fetch_batch, fetch_json  # noqa: E402


DEFAULT_DATASETS = (
    "pipeline_iceberg.chlor_a",
    "pipeline_iceberg.fishing_hours",
    "pipeline_iceberg.ocean_productivity_score",
    "pipeline_iceberg.sea_temperature",
    "pipeline_iceberg.sustainability_pressure",
)


@dataclass(frozen=True)
class DateRange:
    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def month_keys(self) -> tuple[str, ...]:
        cursor = self.start.replace(day=1)
        last = self.end.replace(day=1)
        keys: list[str] = []
        while cursor <= last:
            keys.append(cursor.strftime("%Y-%m"))
            cursor = (
                cursor.replace(year=cursor.year + 1, month=1)
                if cursor.month == 12
                else cursor.replace(month=cursor.month + 1)
            )
        return tuple(keys)

    def iso_dates(self) -> list[str]:
        return [
            (self.start + timedelta(days=offset)).isoformat()
            for offset in range(self.days)
        ]


def calendar_month(value: str) -> DateRange:
    try:
        year_text, month_text = value.split("-", 1)
        year = int(year_text)
        month = int(month_text)
        last_day = calendar.monthrange(year, month)[1]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid calendar month: {value!r}") from exc
    return DateRange(date(year, month, 1), date(year, month, last_day))


def explicit_range(start: str, end: str) -> DateRange:
    try:
        result = DateRange(date.fromisoformat(start), date.fromisoformat(end))
    except (TypeError, ValueError) as exc:
        raise ValueError("start and end must use YYYY-MM-DD") from exc
    if result.end < result.start:
        raise ValueError("end must not precede start")
    return result


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return round(ordered[index], 3)


def distribution(values: list[float]) -> dict[str, float]:
    if not values:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0}
    return {
        "p50": round(statistics.median(values), 3),
        "p95": percentile(values, 0.95),
        "max": round(max(values), 3),
    }


def range_envelope(
    dataset_id: str,
    selected: DateRange,
    *,
    sequence: int,
    bbox: str,
    resolution: float,
) -> dict[str, Any]:
    return {
        "schema": "query_batch.v1",
        "batch_id": f"month-storm-{sequence}",
        "operations": [{
            "operation_id": f"month-storm-{sequence}-range",
            "kind": "sampled_grid.records_range",
            "dataset_id": dataset_id,
            "params": {
                "start": selected.start.isoformat(),
                "end": selected.end.isoformat(),
                "bbox": bbox,
                "limit": "max",
                "columns": "render",
                "resolution": resolution,
            },
        }],
    }


def schema_dates(base_url: str, dataset_id: str, timeout: float) -> set[str]:
    schema = fetch_json(
        f"{base_url.rstrip('/')}/api/datasets/{quote(dataset_id, safe='')}/schema",
        timeout,
    )
    return {str(value) for value in schema.get("dates") or [] if str(value)}


def validate_availability(
    available: dict[str, set[str]],
    selected: DateRange,
) -> dict[str, list[str]]:
    required = set(selected.iso_dates())
    return {
        dataset_id: sorted(required - dates)
        for dataset_id, dates in available.items()
        if required - dates
    }


def range_operation(
    base_url: str,
    *,
    dataset_id: str,
    selected: DateRange,
    bbox: str,
    resolution: float,
    timeout: float,
    sequence: int,
    start_event: Event,
) -> dict[str, Any]:
    start_event.wait()
    result = fetch_batch(
        base_url,
        range_envelope(
            dataset_id,
            selected,
            sequence=sequence,
            bbox=bbox,
            resolution=resolution,
        ),
        timeout,
    )
    event = (result.get("results") or [{}])[0]
    packet = event.get("packet") if isinstance(event.get("packet"), dict) else {}
    raw_snapshots = packet.get("snapshots")
    snapshots = raw_snapshots if isinstance(raw_snapshots, (dict, list)) else {}
    timing = packet.get("timing") if isinstance(packet.get("timing"), dict) else {}
    declared_dates = packet.get("dates") if isinstance(packet.get("dates"), list) else []
    if isinstance(snapshots, dict):
        snapshot_dates = {str(value) for value in snapshots}
    else:
        snapshot_dates = {
            str(snapshot.get("date") or snapshot.get("snapshot_date") or "")
            for snapshot in snapshots
            if isinstance(snapshot, dict)
        }
    snapshot_count = int(packet.get("snapshot_count") or len(snapshots))
    cache_hit = bool(timing.get("cache_hit"))
    return {
        "dataset_id": dataset_id,
        "ok": result.get("status") == 200 and event.get("status") == "ok",
        "elapsed_ms": float(result.get("elapsed_ms") or 0),
        "wire_bytes": int(result.get("wire_bytes") or 0),
        "snapshot_count": snapshot_count,
        "snapshot_dates": sorted(
            {str(value) for value in declared_dates if str(value)}
            or {value for value in snapshot_dates if value}
        ),
        "source_request_count": int(timing.get("source_request_count") or 0),
        "source_query": not cache_hit,
        "cache_hit": cache_hit,
        "cache_waited": bool(timing.get("cache_waited")),
        "error": result.get("error") or event.get("error"),
    }


def run_jobs(
    base_url: str,
    jobs: list[str],
    *,
    selected: DateRange,
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
                range_operation,
                base_url,
                dataset_id=dataset_id,
                selected=selected,
                bbox=bbox,
                resolution=resolution,
                timeout=timeout,
                sequence=sequence_start + index,
                start_event=start_event,
            )
            for index, dataset_id in enumerate(jobs)
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
        "latency_ms": distribution([float(item["elapsed_ms"]) for item in results]),
        "wire_bytes": sum(int(item["wire_bytes"]) for item in results),
        "source_request_count": sum(int(item["source_request_count"]) for item in results),
        "source_query_count": sum(bool(item["source_query"]) for item in results),
        "cache_hits": sum(bool(item["cache_hit"]) for item in results),
        "cache_waited": sum(bool(item["cache_waited"]) for item in results),
        "datasets": sorted({str(item["dataset_id"]) for item in results}),
        "snapshot_counts": sorted({int(item["snapshot_count"]) for item in results}),
        "failures": [
            {
                "dataset_id": item["dataset_id"],
                "error": item["error"],
            }
            for item in results
            if not item["ok"]
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5185")
    parser.add_argument("--month", default="2024-01")
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--require-cross-month", action="store_true")
    parser.add_argument("--bbox", default="120,20,121,21")
    parser.add_argument("--resolution", type=float, default=4)
    parser.add_argument("--duplicate-clients", type=int, default=4)
    parser.add_argument("--mixed-rounds", type=int, default=2)
    parser.add_argument("--mixed-clients", type=int, default=10)
    parser.add_argument("--maximum-wall-seconds", type=float, default=300)
    parser.add_argument("--timeout", type=float, default=360)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if bool(args.start) != bool(args.end):
        parser.error("--start and --end must be provided together")
    if min(args.duplicate_clients, args.mixed_rounds, args.mixed_clients) < 1:
        parser.error("client and round counts must be positive")
    return args


def main() -> int:
    args = parse_args()
    selected = (
        explicit_range(args.start, args.end)
        if args.start and args.end
        else calendar_month(args.month)
    )
    if args.require_cross_month and len(selected.month_keys) < 2:
        raise SystemExit("cross-month validation requires a range spanning two months")

    available = {
        dataset_id: schema_dates(args.base_url, dataset_id, args.timeout)
        for dataset_id in DEFAULT_DATASETS
    }
    missing = validate_availability(available, selected)
    if missing:
        report = {
            "schema": "rrkal.sampled_grid_month_storm.v1",
            "passed": False,
            "reason": "required_dates_not_materialized",
            "range": {
                "start": selected.start.isoformat(),
                "end": selected.end.isoformat(),
                "days": selected.days,
                "month_keys": list(selected.month_keys),
            },
            "missing_dates": missing,
        }
        rendered = json.dumps(report, ensure_ascii=False, indent=2)
        print(rendered)
        if args.output is not None:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered + "\n", encoding="utf-8", newline="\n")
        return 1

    duplicate_dataset = "pipeline_iceberg.sea_temperature"
    duplicate_results, duplicate_wall_ms = run_jobs(
        args.base_url,
        [duplicate_dataset] * args.duplicate_clients,
        selected=selected,
        clients=args.duplicate_clients,
        bbox=args.bbox,
        resolution=args.resolution,
        timeout=args.timeout,
        sequence_start=10_000,
    )
    mixed_jobs = [
        dataset_id
        for _round in range(args.mixed_rounds)
        for dataset_id in DEFAULT_DATASETS
    ]
    mixed_results, mixed_wall_ms = run_jobs(
        args.base_url,
        mixed_jobs,
        selected=selected,
        clients=min(args.mixed_clients, len(mixed_jobs)),
        bbox=args.bbox,
        resolution=args.resolution,
        timeout=args.timeout,
        sequence_start=20_000,
    )

    duplicate = summarize(duplicate_results, duplicate_wall_ms)
    mixed = summarize(mixed_results, mixed_wall_ms)
    expected_datasets = sorted(DEFAULT_DATASETS)
    checks = {
        "calendar_range_is_complete": True,
        "cross_month_requirement_met": (
            not args.require_cross_month or len(selected.month_keys) >= 2
        ),
        "duplicate_all_succeeded": duplicate["failed"] == 0,
        "duplicate_single_flight": duplicate["source_query_count"] <= 1,
        "duplicate_snapshot_count_matches_range": duplicate["snapshot_counts"] == [selected.days],
        "mixed_all_succeeded": mixed["failed"] == 0,
        "mixed_covers_all_datasets": mixed["datasets"] == expected_datasets,
        "mixed_single_flight_per_dataset": mixed["source_query_count"] <= len(DEFAULT_DATASETS),
        "mixed_snapshot_count_matches_range": mixed["snapshot_counts"] == [selected.days],
        "duplicate_wall_time_within_limit": duplicate_wall_ms <= args.maximum_wall_seconds * 1000,
        "mixed_wall_time_within_limit": mixed_wall_ms <= args.maximum_wall_seconds * 1000,
    }
    report = {
        "schema": "rrkal.sampled_grid_month_storm.v1",
        "base_url": args.base_url,
        "bbox": args.bbox,
        "resolution_km": args.resolution,
        "range": {
            "start": selected.start.isoformat(),
            "end": selected.end.isoformat(),
            "days": selected.days,
            "month_keys": list(selected.month_keys),
        },
        "duplicate_month_storm": duplicate,
        "mixed_dataset_month_storm": mixed,
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
