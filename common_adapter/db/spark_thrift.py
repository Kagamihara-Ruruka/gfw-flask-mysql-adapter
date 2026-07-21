from __future__ import annotations

import atexit
import datetime as dt
import decimal
import math
import re
import threading
import time
from collections.abc import Callable
from typing import Any


IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SparkThriftConfigError(RuntimeError):
    pass


_RETRYABLE_CONNECTION_MESSAGES = (
    "broken pipe",
    "connection refused",
    "connection reset",
    "could not connect",
    "eof",
    "invalid session handle",
    "invalid sessionhandle",
    "not connected",
    "session is closed",
    "transport",
    "tsocket read 0 bytes",
)

_NON_RETRYABLE_SERVER_MESSAGES = (
    "outofmemoryerror",
    "unable to create native thread",
)


def _is_retryable_connection_error(exc: Exception) -> bool:
    if isinstance(exc, (ConnectionError, EOFError, OSError)):
        return True
    message = str(exc).lower()
    if any(token in message for token in _NON_RETRYABLE_SERVER_MESSAGES):
        return False
    return any(token in message for token in _RETRYABLE_CONNECTION_MESSAGES)


class SparkThriftConnectionManager:
    """Own one lazy PyHive connection and serialize access to it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._connection: Any | None = None
        self._connection_key: tuple[Any, ...] | None = None

    def _discard_locked(self) -> None:
        connection = self._connection
        self._connection = None
        self._connection_key = None
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass

    def close(self) -> None:
        with self._lock:
            self._discard_locked()

    def _connection_for(
        self,
        connection_factory: Callable[..., Any],
        connection_key: tuple[Any, ...],
        connection_kwargs: dict[str, Any],
    ) -> tuple[Any, bool]:
        if self._connection is not None and self._connection_key == connection_key:
            return self._connection, True

        self._discard_locked()
        connection = connection_factory(**connection_kwargs)
        self._connection = connection
        self._connection_key = connection_key
        return connection, False

    def execute(
        self,
        connection_factory: Callable[..., Any],
        connection_key: tuple[Any, ...],
        connection_kwargs: dict[str, Any],
        sql: str,
    ) -> dict[str, Any]:
        g_mark = time.perf_counter_ns()
        reconnect_count = 0

        with self._lock:
            while True:
                cursor = None
                try:
                    connection, connection_reused = self._connection_for(
                        connection_factory,
                        connection_key,
                        connection_kwargs,
                    )
                    h_mark = time.perf_counter_ns()
                    cursor = connection.cursor()
                    i_mark = time.perf_counter_ns()
                    cursor.execute(sql)
                    j_mark = time.perf_counter_ns()
                    columns = [
                        str(item[0]).split(".")[-1]
                        for item in cursor.description or []
                    ]
                    raw_rows = cursor.fetchall()
                    k_mark = time.perf_counter_ns()
                except Exception as exc:
                    if cursor is not None:
                        try:
                            cursor.close()
                        except Exception:
                            pass

                    retryable = _is_retryable_connection_error(exc)
                    if retryable:
                        self._discard_locked()
                    if reconnect_count == 0 and retryable:
                        reconnect_count = 1
                        continue
                    raise
                else:
                    try:
                        cursor.close()
                    except Exception:
                        self._discard_locked()
                    break

        rows = [
            {column: json_ready(value) for column, value in zip(columns, row)}
            for row in raw_rows
        ]
        l_mark = time.perf_counter_ns()

        return {
            "rows": rows,
            "row_count": len(rows),
            "connection": {
                "reused": connection_reused,
                "reconnect_count": reconnect_count,
            },
            "timing": {
                "gh_ms": elapsed_ms(g_mark, h_mark),
                "hi_ms": elapsed_ms(h_mark, i_mark),
                "ij_ms": elapsed_ms(i_mark, j_mark),
                "jk_ms": elapsed_ms(j_mark, k_mark),
                "kl_ms": elapsed_ms(k_mark, l_mark),
                "query_ms": elapsed_ms(g_mark, l_mark),
            },
        }


_CONNECTION_MANAGER = SparkThriftConnectionManager()


def close_spark_thrift_connection() -> None:
    _CONNECTION_MANAGER.close()


atexit.register(close_spark_thrift_connection)


def elapsed_ms(started_ns: int, finished_ns: int) -> float:
    return round((finished_ns - started_ns) / 1_000_000, 3)


def json_ready(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        as_int = int(value)
        return as_int if value == as_int else float(value)
    return value


def spark_thrift_settings(config: dict[str, Any]) -> dict[str, Any]:
    direct = config.get("spark_thrift")
    if isinstance(direct, dict) and direct:
        return dict(direct)

    connections = config.get("connections") or {}
    ref = str(config.get("default_connection_ref") or "spark_thrift")
    if ref in connections:
        return dict(connections[ref])
    if "spark_thrift" in connections:
        return dict(connections["spark_thrift"])
    raise SparkThriftConfigError("missing spark_thrift connection config")


def spark_defaults(config: dict[str, Any]) -> dict[str, Any]:
    defaults = config.get("defaults")
    if isinstance(defaults, dict):
        return defaults
    return {
        "date": "2024-01-01",
        "aoi": "taiwan",
        "product": "SST",
        "metric": "sea_temperature",
        "resolution": 4,
        "heatmap_limit": 20000,
        "grid_features_limit": 1000,
    }


def dataset_table(config: dict[str, Any], dataset_id: str, fallback: str) -> str:
    tables = config.get("tables")
    if isinstance(tables, dict) and tables.get(dataset_id):
        return validate_table_ref(str(tables[dataset_id]))
    datasets = config.get("datasets")
    if isinstance(datasets, dict):
        dataset = datasets.get(dataset_id)
        if isinstance(dataset, dict):
            full = dataset.get("full_table_name")
            if full:
                return validate_table_ref(str(full))
            catalog = str(dataset.get("catalog") or "lake")
            schema = str(dataset.get("schema") or "ocean")
            table = str(dataset.get("table") or fallback.split(".")[-1])
            return validate_table_ref(f"{catalog}.{schema}.{table}")
    return validate_table_ref(fallback)


def validate_identifier(value: str, label: str) -> str:
    text = str(value or "").strip()
    if not IDENTIFIER_RE.match(text):
        raise ValueError(f"invalid {label}: {value!r}")
    return text


def validate_table_ref(value: str) -> str:
    parts = [part.strip() for part in str(value).split(".") if part.strip()]
    if len(parts) not in {1, 2, 3}:
        raise ValueError(f"invalid table reference: {value!r}")
    return ".".join(validate_identifier(part, "table identifier") for part in parts)


def validate_date(value: str) -> str:
    text = str(value or "").strip()
    if not DATE_RE.match(text):
        raise ValueError(f"invalid date: {value!r}")
    try:
        dt.date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"invalid date: {value!r}") from exc
    return text


def sql_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def effective_limit(value: Any, *, default: int, max_limit: int = 100000) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, max_limit))


def global_index_window(
    bbox: tuple[float, float, float, float],
    *,
    resolution: int,
    geometry: dict[str, Any],
) -> dict[str, int]:
    """Return the inclusive source-index window intersecting a geographic bbox."""

    west, south, east, north = (float(value) for value in bbox)
    if west >= east or south >= north:
        raise ValueError("bbox ranges are invalid")
    try:
        origin_lat = float(geometry["origin_lat"])
        origin_lon = float(geometry["origin_lon"])
        units_per_degree = float(geometry["index_units_per_degree"])
        base_resolution = float(geometry["base_resolution_km"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("global-index bbox query requires complete geometry") from exc
    if units_per_degree <= 0 or base_resolution <= 0 or resolution <= 0:
        raise ValueError("global-index geometry values must be positive")

    index_span = (float(resolution) / base_resolution)
    return {
        "min_grid_row": math.floor((origin_lat - north) * units_per_degree - index_span) + 1,
        "max_grid_row": math.ceil((origin_lat - south) * units_per_degree) - 1,
        "min_grid_col": math.floor((west - origin_lon) * units_per_degree - index_span) + 1,
        "max_grid_col": math.ceil((east - origin_lon) * units_per_degree) - 1,
    }


def execute_query(config: dict[str, Any], sql: str) -> dict[str, Any]:
    try:
        from pyhive import hive
    except ImportError as exc:
        raise RuntimeError("PyHive is not installed in this Flask image") from exc

    settings = spark_thrift_settings(config)
    host = str(settings.get("host") or "dtadm")
    port = int(settings.get("port") or 10000)
    username = str(settings.get("username") or settings.get("user") or "bigred")
    auth = str(settings.get("auth") or "NONE")
    password = settings.get("password")

    conn_kwargs: dict[str, Any] = {
        "host": host,
        "port": port,
        "username": username,
        "auth": auth,
    }
    if password:
        conn_kwargs["password"] = str(password)

    connection_key = (host, port, username, auth, str(password or ""))
    packet = _CONNECTION_MANAGER.execute(
        hive.Connection,
        connection_key,
        conn_kwargs,
        sql,
    )
    packet["endpoint"] = {"host": host, "port": port, "auth": auth}
    return packet


def heatmap_packet(
    config: dict[str, Any],
    *,
    date: str,
    aoi: str,
    product: str,
    metric: str,
    resolution: int,
    limit: int | None = None,
    bbox: tuple[float, float, float, float] | None = None,
    geometry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    f_mark = time.perf_counter_ns()
    table = dataset_table(config, "gold_map_metric", "lake.ocean.gold_map_metric")
    date = validate_date(date)
    aoi = validate_identifier(aoi, "aoi")
    product = validate_identifier(product, "product")
    metric = validate_identifier(metric, "metric")
    resolution = int(resolution)
    resolved_limit = None if limit is None else effective_limit(limit, default=20000)
    limit_clause = "" if resolved_limit is None else f"\nLIMIT {resolved_limit}"
    grid_window = None
    bbox_clause = ""
    if bbox is not None:
        grid_window = global_index_window(
            bbox,
            resolution=resolution,
            geometry=geometry or {},
        )
        bbox_clause = (
            f"\n  AND grid_row BETWEEN {grid_window['min_grid_row']} AND {grid_window['max_grid_row']}"
            f"\n  AND grid_col BETWEEN {grid_window['min_grid_col']} AND {grid_window['max_grid_col']}"
        )
    sql = f"""
SELECT
  grid_id,
  grid_row,
  grid_col,
  resolution_km,
  metric_value,
  relative_score,
  display_level,
  data_coverage
FROM {table}
WHERE event_date = DATE {sql_literal(date)}
  AND aoi_id = {sql_literal(aoi)}
  AND product_id = {sql_literal(product)}
  AND metric_id = {sql_literal(metric)}
  AND resolution_km = {resolution}{bbox_clause}{limit_clause}
""".strip()
    g_mark = time.perf_counter_ns()
    packet = execute_query(config, sql)
    packet["timing"] = {
        "fg_ms": elapsed_ms(f_mark, g_mark),
        **packet["timing"],
    }
    return {
        "status": "ok",
        "kind": "heatmap",
        "table": table,
        "params": {
            "date": date,
            "aoi": aoi,
            "product": product,
            "metric": metric,
            "resolution": resolution,
            "limit": resolved_limit,
            "bbox": None if bbox is None else list(bbox),
            "grid_window": grid_window,
        },
        **packet,
    }


def availability_packet(
    config: dict[str, Any],
    *,
    start_date: str,
    end_date: str,
    aoi: str,
    product: str,
    metric: str,
    resolution: int,
) -> dict[str, Any]:
    """Return the dates that exist for one sampled-grid dataset."""

    f_mark = time.perf_counter_ns()
    table = dataset_table(config, "gold_map_metric", "lake.ocean.gold_map_metric")
    start_date = validate_date(start_date)
    end_date = validate_date(end_date)
    if start_date > end_date:
        raise ValueError("start_date must not be after end_date")
    aoi = validate_identifier(aoi, "aoi")
    product = validate_identifier(product, "product")
    metric = validate_identifier(metric, "metric")
    resolution = int(resolution)
    sql = f"""
SELECT DISTINCT
  event_date
FROM {table}
WHERE event_date BETWEEN DATE {sql_literal(start_date)} AND DATE {sql_literal(end_date)}
  AND aoi_id = {sql_literal(aoi)}
  AND product_id = {sql_literal(product)}
  AND metric_id = {sql_literal(metric)}
  AND resolution_km = {resolution}
ORDER BY event_date
""".strip()
    g_mark = time.perf_counter_ns()
    packet = execute_query(config, sql)
    packet["timing"] = {
        "fg_ms": elapsed_ms(f_mark, g_mark),
        **packet["timing"],
    }
    dates = [str(row.get("event_date")) for row in packet["rows"] if row.get("event_date")]
    return {
        "status": "ok",
        "kind": "availability",
        "table": table,
        "params": {
            "start_date": start_date,
            "end_date": end_date,
            "aoi": aoi,
            "product": product,
            "metric": metric,
            "resolution": resolution,
        },
        "dates": dates,
        "date_count": len(dates),
        **packet,
    }


def summary_packet(
    config: dict[str, Any],
    *,
    date: str,
    aoi: str,
    product: str,
    metric: str,
    resolution: int,
) -> dict[str, Any]:
    f_mark = time.perf_counter_ns()
    table = dataset_table(config, "gold_daily_metric_summary", "lake.ocean.gold_daily_metric_summary")
    date = validate_date(date)
    aoi = validate_identifier(aoi, "aoi")
    product = validate_identifier(product, "product")
    metric = validate_identifier(metric, "metric")
    resolution = int(resolution)
    sql = f"""
SELECT
  event_date,
  aoi_id,
  product_id,
  metric_id,
  resolution_km,
  average_score,
  maximum_score,
  cell_count,
  data_coverage
FROM {table}
WHERE event_date = DATE {sql_literal(date)}
  AND aoi_id = {sql_literal(aoi)}
  AND product_id = {sql_literal(product)}
  AND metric_id = {sql_literal(metric)}
  AND resolution_km = {resolution}
""".strip()
    g_mark = time.perf_counter_ns()
    packet = execute_query(config, sql)
    packet["timing"] = {
        "fg_ms": elapsed_ms(f_mark, g_mark),
        **packet["timing"],
    }
    return {
        "status": "ok",
        "kind": "summary",
        "table": table,
        "params": {
            "date": date,
            "aoi": aoi,
            "product": product,
            "metric": metric,
            "resolution": resolution,
        },
        **packet,
    }


def grid_features_packet(
    config: dict[str, Any],
    *,
    date: str,
    aoi: str,
    limit: int,
) -> dict[str, Any]:
    f_mark = time.perf_counter_ns()
    table = dataset_table(config, "gold_daily_grid_features", "lake.ocean.gold_daily_grid_features")
    date = validate_date(date)
    aoi = validate_identifier(aoi, "aoi")
    limit = effective_limit(limit, default=1000)
    sql = f"""
SELECT
  event_date,
  aoi_id,
  grid_id,
  grid_row,
  grid_col,
  chlor_a,
  sea_temperature_celsius,
  ocean_productivity_score,
  sustainability_pressure,
  fishing_hours,
  data_coverage
FROM {table}
WHERE event_date = DATE {sql_literal(date)}
  AND aoi_id = {sql_literal(aoi)}
LIMIT {limit}
""".strip()
    g_mark = time.perf_counter_ns()
    packet = execute_query(config, sql)
    packet["timing"] = {
        "fg_ms": elapsed_ms(f_mark, g_mark),
        **packet["timing"],
    }
    return {
        "status": "ok",
        "kind": "grid_features",
        "table": table,
        "params": {"date": date, "aoi": aoi, "limit": limit},
        **packet,
    }
