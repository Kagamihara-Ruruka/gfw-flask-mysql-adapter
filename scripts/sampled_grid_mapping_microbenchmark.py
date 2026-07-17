"""Compare legacy row-graph mapping with the canonical frame bulk mapper."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from common_adapter.db.connect import load_config
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.query.grid_frame import canonical_grid_frame_from_rows
from common_adapter.query.sampled_grid import (
    canonicalize_sampled_grid_row,
    canonicalize_sampled_grid_rows,
    compile_sampled_grid_mapping,
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


def synthetic_global_index_rows(count: int, resolution: float) -> list[dict[str, Any]]:
    width = 144
    north_row = int((90 - 27) * 24)
    west_column = int((118 + 180) * 24)
    rows = []
    for index in range(count):
        local_row, local_column = divmod(index, width)
        grid_row = north_row + local_row
        grid_column = west_column + local_column
        rows.append(
            {
                "grid_id": f"{grid_row}:{grid_column}:{resolution:g}",
                "grid_row": grid_row,
                "grid_col": grid_column,
                "value": float(index % 101),
                "resolution_km": resolution,
                "data_coverage": 1.0,
                "value_source": "observed",
            }
        )
    return rows


def timed_run(
    operation: Callable[[], dict[str, Any]],
    repeats: int,
) -> tuple[dict[str, float], dict[str, Any]]:
    timings = []
    result: dict[str, Any] = {}
    operation()
    for _index in range(repeats):
        started_at = time.perf_counter()
        result = operation()
        timings.append((time.perf_counter() - started_at) * 1000)
    return distribution(timings), result


def encode_transport(transport: dict[str, Any]) -> tuple[bytes, bytes, str]:
    encoded = json.dumps(transport, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(encoded, compresslevel=6)
    return encoded, compressed, hashlib.sha256(encoded).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/runtime/adapter.local.json")
    parser.add_argument("--dataset", default="pipeline_iceberg.sea_temperature")
    parser.add_argument("--rows", type=int, default=24_192)
    parser.add_argument("--resolution", type=float, default=4)
    parser.add_argument("--date", default="2020-01-01")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    if args.rows < 1 or args.repeats < 1:
        parser.error("--rows and --repeats must be positive")
    return args


def main() -> int:
    args = parse_args()
    config = load_config(args.config)
    dataset = RuntimeLayerRegistry(config).get_dataset(args.dataset)
    if dataset is None:
        raise SystemExit(f"unknown runtime dataset: {args.dataset}")
    mapping = compile_sampled_grid_mapping(dataset)
    rows = synthetic_global_index_rows(args.rows, args.resolution)
    context = {"date": args.date, "resolution": args.resolution}

    def legacy() -> dict[str, Any]:
        canonical_rows = [
            canonicalize_sampled_grid_row(row, mapping, context=context)
            for row in rows
        ]
        return canonical_grid_frame_from_rows(canonical_rows).view().transport()

    def bulk() -> dict[str, Any]:
        return canonicalize_sampled_grid_rows(rows, mapping, context=context).view().transport()

    legacy_timing, legacy_transport = timed_run(legacy, args.repeats)
    bulk_timing, bulk_transport = timed_run(bulk, args.repeats)
    if legacy_transport != bulk_transport:
        raise RuntimeError("bulk mapper changed canonical frame transport")
    encoded, compressed, digest = encode_transport(bulk_transport)
    speedup = legacy_timing["p50"] / max(bulk_timing["p50"], 1e-9)
    report = {
        "schema": "rrkal.sampled_grid_mapping_microbenchmark.v1",
        "dataset_id": args.dataset,
        "rows": args.rows,
        "resolution_km": args.resolution,
        "repeats": args.repeats,
        "legacy_row_graph_ms": legacy_timing,
        "bulk_canonical_frame_ms": bulk_timing,
        "p50_speedup": round(speedup, 3),
        "transport_bytes": len(encoded),
        "transport_gzip_bytes": len(compressed),
        "transport_sha256": digest,
        "equivalent": True,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
