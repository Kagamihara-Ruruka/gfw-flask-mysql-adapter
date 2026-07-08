from __future__ import annotations

import argparse
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

import sys

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from DatabaseConnect import load_config, mysql_connection, mysql_quote  # noqa: E402


PROXY_DATASETS = [
    {"dataset_id": "gfw_effort", "metric": "fish_sum"},
    {"dataset_id": "nasa_chl_chlor_a_daily_4km", "metric": "chlor_a"},
    {"dataset_id": "nasa_flh_nflh_daily_4km", "metric": "nflh"},
    {"dataset_id": "nasa_kd_kd_490_daily_4km", "metric": "kd490"},
    {"dataset_id": "nasa_sst_sst_daily_4km", "metric": "sst"},
]

BBOXES = [
    ("global", -180.0, -80.0, 180.0, 80.0),
    ("taiwan", 118.0, 20.0, 124.0, 27.0),
    ("west_pacific", 110.0, -10.0, 160.0, 35.0),
    ("south_america_pacific", -90.0, -60.0, -65.0, 5.0),
    ("north_atlantic", -80.0, 20.0, -5.0, 65.0),
]


def timed_query(config: dict[str, Any], dataset: dict[str, Any], date_value: str, bbox: tuple[str, float, float, float, float]) -> dict[str, Any]:
    table = config["datasets"]["gfw_full"]["mysql_table"]
    time_col = config["datasets"]["gfw_full"]["time_column"]
    lat_col = config["datasets"]["gfw_full"]["lat_column"]
    lon_col = config["datasets"]["gfw_full"]["lon_column"]
    metric = dataset["metric"]
    bbox_name, west, south, east, north = bbox
    sql = (
        f"SELECT COUNT(*) AS n, AVG({mysql_quote(metric)}) AS avg_value, "
        f"MIN({mysql_quote(metric)}) AS min_value, MAX({mysql_quote(metric)}) AS max_value "
        f"FROM {mysql_quote(table)} "
        f"WHERE {mysql_quote(time_col)}=%s "
        f"AND {mysql_quote(lon_col)} BETWEEN %s AND %s "
        f"AND {mysql_quote(lat_col)} BETWEEN %s AND %s"
    )
    started = time.perf_counter()
    with mysql_connection(config, config["mysql"]["database"], dict_cursor=True) as conn, conn.cursor() as cur:
        cur.execute(sql, (date_value, west, east, south, north))
        row = cur.fetchone()
    elapsed = round((time.perf_counter() - started) * 1000, 3)
    return {
        "dataset_id": dataset["dataset_id"],
        "metric": metric,
        "date": date_value,
        "bbox": bbox_name,
        "elapsed_ms": elapsed,
        "rows": int(row["n"]),
    }


def summarize(samples: list[dict[str, Any]]) -> dict[str, Any]:
    elapsed = [sample["elapsed_ms"] for sample in samples]
    return {
        "count": len(samples),
        "min_ms": round(min(elapsed), 3),
        "median_ms": round(statistics.median(elapsed), 3),
        "p95_ms": round(statistics.quantiles(elapsed, n=20)[18], 3) if len(elapsed) >= 20 else round(max(elapsed), 3),
        "max_ms": round(max(elapsed), 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Pressure test GFW + NASA-proxy SQL query shapes.")
    parser.add_argument("--config", default="config/adapter.local.json")
    parser.add_argument("--date", default="2024-01-15")
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    config = load_config(args.config)
    tasks = []
    for _ in range(args.rounds):
        for proxy in PROXY_DATASETS:
            for bbox in BBOXES:
                tasks.append((proxy, bbox))

    started = time.perf_counter()
    samples: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(timed_query, config, proxy, args.date, bbox) for proxy, bbox in tasks]
        for future in as_completed(futures):
            samples.append(future.result())
    total_ms = round((time.perf_counter() - started) * 1000, 3)

    by_dataset = {}
    for proxy in PROXY_DATASETS:
        group = [sample for sample in samples if sample["dataset_id"] == proxy["dataset_id"]]
        by_dataset[proxy["dataset_id"]] = summarize(group)

    packet = {
        "date": args.date,
        "rounds": args.rounds,
        "workers": args.workers,
        "total_queries": len(samples),
        "wall_ms": total_ms,
        "overall": summarize(samples),
        "by_dataset": by_dataset,
        "samples": samples,
        "boundary": "This test uses existing SQL metrics as NASA proxy query shapes. It does not imply NASA raw files are stored in the consumer app.",
    }
    if args.output:
        output = Path(args.output)
        if not output.is_absolute():
            output = ROOT / output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({key: packet[key] for key in ["total_queries", "wall_ms", "overall", "by_dataset"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
