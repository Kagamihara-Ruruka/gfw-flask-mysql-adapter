from __future__ import annotations

import os
import time
from collections import defaultdict
from typing import Any, Iterable

from DatabaseConnect import json_ready, rows_json_ready

try:
    import pandas as pd
except ImportError:  # pragma: no cover - kept as a controlled fallback for partial installs.
    pd = None


def pandas_available() -> bool:
    return pd is not None


def recommended_snapshot_workers(total: int | None = None) -> int:
    cores = os.cpu_count() or 1
    workers = max(1, cores - 1)
    if total is not None:
        workers = min(workers, max(1, int(total)))
    return min(workers, 12)


def split_rows_by_date(
    rows: Iterable[dict[str, Any]],
    *,
    date_column: str,
    allowed_dates: Iterable[str] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    prepared_rows = list(rows)
    allowed = {str(value) for value in allowed_dates} if allowed_dates is not None else None
    if pd is not None and prepared_rows:
        snapshots = _split_with_pandas(prepared_rows, date_column=date_column, allowed_dates=allowed)
        engine = "pandas"
    else:
        snapshots = _split_with_python(prepared_rows, date_column=date_column, allowed_dates=allowed)
        engine = "python"
    return {
        "snapshots": snapshots,
        "dates": sorted(snapshots.keys()),
        "snapshot_count": len(snapshots),
        "row_count": sum(len(snapshot_rows) for snapshot_rows in snapshots.values()),
        "engine": engine,
        "worker_hint": recommended_snapshot_workers(len(snapshots) or None),
        "split_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def _split_with_pandas(
    rows: list[dict[str, Any]],
    *,
    date_column: str,
    allowed_dates: set[str] | None,
) -> dict[str, list[dict[str, Any]]]:
    frame = pd.DataFrame.from_records(rows)
    if date_column not in frame.columns:
        raise ValueError(f"date column is missing from query result: {date_column}")
    date_series = frame[date_column].map(lambda value: str(json_ready(value)))
    frame = frame.assign(__snapshot_date=date_series)
    if allowed_dates is not None:
        frame = frame[frame["__snapshot_date"].isin(allowed_dates)]
    snapshots: dict[str, list[dict[str, Any]]] = {}
    for date_value, group in frame.groupby("__snapshot_date", sort=True):
        output = group.drop(columns=["__snapshot_date"]).to_dict(orient="records")
        snapshots[str(date_value)] = rows_json_ready(output)
    return snapshots


def _split_with_python(
    rows: list[dict[str, Any]],
    *,
    date_column: str,
    allowed_dates: set[str] | None,
) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if date_column not in row:
            raise ValueError(f"date column is missing from query result: {date_column}")
        date_value = str(json_ready(row[date_column]))
        if allowed_dates is not None and date_value not in allowed_dates:
            continue
        grouped[date_value].append(row)
    return {date_value: rows_json_ready(snapshot_rows) for date_value, snapshot_rows in grouped.items()}
