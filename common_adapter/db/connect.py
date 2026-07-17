from __future__ import annotations

import os
import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

import duckdb
import pymysql
from pymysql.cursors import DictCursor

from common_adapter.config.contracts import load_assembled_config
from common_adapter.config.paths import runtime_config_path
from common_adapter.query.builtins import register_builtin_query_adapters
from common_adapter.query.registry import UnsupportedQueryOperation, instantiate_query_adapter
from common_adapter.query.serialization import json_ready, rows_json_ready
from common_adapter.query.identity import dataset_cache_namespace
from common_adapter.query.sampled_grid import (
    canonicalize_sampled_grid_packet,
    canonicalize_sampled_grid_range_packet,
    canonicalize_sampled_grid_schema_packet,
    canonicalize_sampled_grid_time_series_packet,
    sampled_grid_render_columns,
    sampled_grid_source_fields,
)

ROOT = Path(__file__).resolve().parents[2]
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DEFAULT_MYSQL_CONNECTION_REF = "local_mysql"
SUPPORTED_CONNECTION_KINDS = {"mysql", "hive", "spark", "postgresql", "mongodb", "duckdb", "custom"}
SUPPORTED_SQL_BACKENDS = {"mysql", "hive", "spark"}


def default_config_path() -> Path:
    config_path = runtime_config_path()
    if config_path is not None:
        return config_path
    return ROOT / "config" / "examples" / "runtime" / "adapter.example.json"


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    config_path = Path(path) if path else default_config_path()
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    config = load_assembled_config(config_path)
    validate_config(config)
    return config


def validate_config(config: dict[str, Any]) -> None:
    datasets = config.setdefault("datasets", {})
    if not isinstance(datasets, dict):
        raise ValueError("config datasets must be an object")
    has_connections = bool(config.get("connections"))
    if datasets and not has_connections:
        raise ValueError("database datasets require connections")
    backend = config.get("sql_backend", {})
    if datasets and backend.get("kind", "mysql") not in SUPPORTED_SQL_BACKENDS:
        raise ValueError(f"sql_backend.kind must be one of: {', '.join(sorted(SUPPORTED_SQL_BACKENDS))}")
    if has_connections:
        validate_connections(config)
    policy = query_policy(config)
    if (
        policy["default_limit"] is not None
        and policy["max_limit"] is not None
        and policy["default_limit"] > policy["max_limit"]
    ):
        raise ValueError("query_policy.default_limit must not exceed query_policy.max_limit")
    server = server_settings(config)
    if server["default_command"] != "serve":
        raise ValueError("server.default_command currently supports only serve")
    for dataset_id, dataset in datasets.items():
        validate_identifier(dataset_id, "dataset id")
        dataset_backend_info(config, dataset)
        for key in ["time_column", "lat_column", "lon_column"]:
            validate_identifier(dataset[key], key)
        if dataset_backend_kind(config, dataset) == "mysql":
            validate_identifier(mysql_dataset_table(dataset), f"{dataset_id}.mysql table")
        for key in ["display_columns", "metric_columns", "category_columns"]:
            for column in dataset.get(key, []):
                validate_identifier(column, f"{dataset_id}.{key}")


def validate_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_RE.match(value):
        raise ValueError(f"invalid {label}: {value!r}")
    return value


def setting_secret(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    if value.startswith("env:"):
        return os.environ.get(value[4:], "")
    return value


def connection_configs(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        key: dict(value) for key, value in (config.get("connections") or {}).items()
    }


def default_connection_ref(config: dict[str, Any], backend_kind: str) -> str:
    configured = config.get("default_connection_ref")
    if configured:
        return str(configured)
    if backend_kind == "mysql":
        return DEFAULT_MYSQL_CONNECTION_REF
    return ""


def validate_connections(config: dict[str, Any]) -> None:
    connections = connection_configs(config)
    if not connections:
        raise ValueError("no database connections are configured")
    for ref, connection in connections.items():
        validate_identifier(ref, "connection ref")
        kind = str(connection.get("kind", "mysql")).lower()
        if kind not in SUPPORTED_CONNECTION_KINDS:
            raise ValueError(f"unsupported connection kind for {ref}: {kind}")
        if kind == "mysql":
            for key in ["host", "port", "user", "database"]:
                if key not in connection:
                    raise ValueError(f"mysql connection {ref} missing {key}")
            validate_identifier(connection["database"], f"{ref}.database")


def dataset_backend_kind(config: dict[str, Any], dataset: dict[str, Any]) -> str:
    return str(dataset.get("backend") or config.get("sql_backend", {}).get("kind", "mysql")).lower()


def dataset_backend_info(config: dict[str, Any], dataset: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    kind = dataset_backend_kind(config, dataset)
    connection_ref = str(dataset.get("connection_ref") or default_connection_ref(config, kind))
    connections = connection_configs(config)
    if not connection_ref:
        raise ValueError(f"dataset backend {kind!r} requires connection_ref")
    try:
        connection = connections[connection_ref]
    except KeyError as exc:
        raise ValueError(f"unknown connection_ref: {connection_ref}") from exc
    connection_kind = str(connection.get("kind", kind)).lower()
    if connection_kind != kind:
        raise ValueError(
            f"dataset backend {kind!r} does not match connection {connection_ref!r} kind {connection_kind!r}"
        )
    return kind, connection_ref, connection


def mysql_dataset_table(dataset: dict[str, Any]) -> str:
    return validate_identifier(dataset.get("table") or dataset.get("mysql_table"), "mysql table")


def mysql_quote(value: str) -> str:
    return f"`{validate_identifier(value, 'identifier')}`"


def duckdb_quote(value: str) -> str:
    validate_identifier(value, "identifier")
    return f'"{value}"'


def duckdb_table_sql(value: str) -> str:
    parts = value.split(".")
    if not 1 <= len(parts) <= 2:
        raise ValueError(f"invalid DuckDB table: {value!r}")
    return ".".join(duckdb_quote(part) for part in parts)


def dataset_render_columns(dataset: dict[str, Any]) -> list[str]:
    columns: list[str] = []
    for key in ["time_column", "id_column", "lat_column", "lon_column"]:
        value = dataset.get(key)
        if value and value not in columns:
            columns.append(value)
    contract_columns = sampled_grid_render_columns(dataset)
    metric_columns = list(dataset.get("metric_columns") or [])
    for column in [*contract_columns, *metric_columns]:
        if column in dataset.get("display_columns", []) and column not in columns:
            columns.append(column)
    return columns or list(dataset.get("display_columns", []))


def resolve_dataset_columns(dataset: dict[str, Any], column_profile: str | None) -> list[str]:
    if not column_profile or column_profile == "display":
        return list(dataset["display_columns"])
    if column_profile == "render":
        return dataset_render_columns(dataset)
    requested = [part.strip() for part in column_profile.split(",") if part.strip()]
    allowed = set(dataset.get("display_columns", []))
    columns: list[str] = []
    for column in requested:
        validate_identifier(column, "requested column")
        if column not in allowed:
            raise ValueError(f"requested column is not in dataset display_columns: {column}")
        if column not in columns:
            columns.append(column)
    if not columns:
        raise ValueError("requested columns must not be empty")
    return columns


def elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def query_policy(config: dict[str, Any]) -> dict[str, Any]:
    policy = config.get("query_policy", {})
    network_concurrency = max(1, min(16, int(policy.get("network_concurrency", 6))))
    background_network_concurrency = max(
        1,
        min(
            network_concurrency,
            int(policy.get("background_network_concurrency", 3)),
        ),
    )
    snapshot_cache_max_rows = policy.get("snapshot_cache_max_rows", 800000)
    if snapshot_cache_max_rows is not None:
        snapshot_cache_max_rows = max(1, int(snapshot_cache_max_rows))
    batch_max_operations = max(1, min(32, int(policy.get("batch_max_operations", 3))))
    return {
        "default_limit": optional_query_limit(policy.get("default_limit", 1000)),
        "max_limit": optional_query_limit(policy.get("max_limit")),
        "table_preview_limit": int(policy.get("table_preview_limit", 300)),
        "require_time_or_bbox_filter": bool(policy.get("require_time_or_bbox_filter", True)),
        "network_concurrency": network_concurrency,
        "background_network_concurrency": background_network_concurrency,
        "batch_max_operations": batch_max_operations,
        "snapshot_cache_max_rows": snapshot_cache_max_rows,
    }


def optional_query_limit(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str) and value.strip().lower() in {"", "max", "none", "null", "unlimited"}:
        return None
    parsed = int(value)
    return None if parsed <= 0 else parsed


def effective_records_limit(limit: Any, policy: dict[str, Any]) -> int | None:
    parsed = optional_query_limit(limit)
    if parsed is None:
        return policy["max_limit"]
    if policy["max_limit"] is None:
        return parsed
    return min(parsed, policy["max_limit"])


def server_settings(config: dict[str, Any]) -> dict[str, Any]:
    server = config.get("server", {})
    return {
        "default_command": server.get("default_command", "serve"),
        "host": server.get("host", "127.0.0.1"),
        "port": int(server.get("port", 5057)),
        "debug": bool(server.get("debug", False)),
        "kill_port_if_busy": bool(server.get("kill_port_if_busy", True)),
    }


_SCHEMA_CACHE: dict[str, Any] = {}
_RECORDS_CACHE: dict[str, Any] = {}
_RECORDS_CACHE_TTL_SECONDS = 300
_RECORDS_CACHE_MAX_ENTRIES = 96


def _records_cache_key(
    *,
    cache_namespace: str,
    connection: dict[str, Any],
    database: str,
    table: str,
    columns: list[str],
    column_profile: str | None,
    date_value: str | None,
    bbox: tuple[float, float, float, float] | None,
    limit: Any,
    offset: int,
) -> str:
    return "|".join(
        [
            cache_namespace,
            str(connection.get("host", "")),
            str(connection.get("port", "")),
            database,
            table,
            str(column_profile or "display"),
            ",".join(columns),
            str(date_value or ""),
            "" if bbox is None else ",".join(f"{value:.6f}" for value in bbox),
            str(limit),
            str(offset),
        ]
    )


def _range_records_cache_key(
    *,
    cache_namespace: str,
    connection: dict[str, Any],
    database: str,
    table: str,
    columns: list[str],
    column_profile: str | None,
    start_date: str,
    end_date: str,
    bbox: tuple[float, float, float, float] | None,
    limit: Any,
) -> str:
    return "|".join(
        [
            "range",
            cache_namespace,
            str(connection.get("host", "")),
            str(connection.get("port", "")),
            database,
            table,
            str(column_profile or "render"),
            ",".join(columns),
            str(start_date),
            str(end_date),
            "" if bbox is None else ",".join(f"{value:.6f}" for value in bbox),
            str(limit),
        ]
    )


def _time_series_cache_key(
    *,
    cache_namespace: str,
    connection: dict[str, Any],
    database: str,
    table: str,
    metric: str,
    aggregation: str,
    start_date: str,
    end_date: str,
    bbox: tuple[float, float, float, float] | None,
    identity_column: str | None,
    identity_value: str | None,
) -> str:
    return "|".join(
        [
            "time-series",
            cache_namespace,
            str(connection.get("host", "")),
            str(connection.get("port", "")),
            database,
            table,
            metric,
            aggregation,
            str(start_date),
            str(end_date),
            "" if bbox is None else ",".join(f"{value:.6f}" for value in bbox),
            identity_column or "",
            "" if identity_value is None else str(identity_value),
        ]
    )


def _remember_records_packet(key: str, packet: dict[str, Any]) -> None:
    _RECORDS_CACHE.pop(key, None)
    _RECORDS_CACHE[key] = {"created_at": time.time(), "packet": packet}
    while len(_RECORDS_CACHE) > _RECORDS_CACHE_MAX_ENTRIES:
        _RECORDS_CACHE.pop(next(iter(_RECORDS_CACHE)))


def _cached_records_packet(
    key: str,
    *,
    zero_timing_keys: Iterable[str] = ("query_ms", "serialize_ms", "server_total_ms"),
) -> dict[str, Any] | None:
    cached = _RECORDS_CACHE.get(key)
    if not cached:
        return None
    if time.time() - cached["created_at"] > _RECORDS_CACHE_TTL_SECONDS:
        _RECORDS_CACHE.pop(key, None)
        return None
    packet = dict(cached["packet"])
    packet["timing"] = dict(packet["timing"])
    packet["timing"]["cache_hit"] = True
    for timing_key in zero_timing_keys:
        if timing_key in packet["timing"]:
            packet["timing"][timing_key] = 0
    packet["query_policy"] = dict(packet["query_policy"])
    return packet


def resolve_time_series_metric(dataset: dict[str, Any], metric: str | None) -> str:
    metric_columns = list(dataset.get("metric_columns") or [])
    display_columns = list(dataset.get("display_columns") or [])
    role_columns = {
        dataset.get("time_column"),
        dataset.get("id_column"),
        dataset.get("lat_column"),
        dataset.get("lon_column"),
    }
    fallback_columns = [
        column
        for column in display_columns
        if column not in role_columns and column not in metric_columns
    ]
    allowed = [*metric_columns, *fallback_columns]
    source_fields = sampled_grid_source_fields(dataset)
    selected = source_fields.get("value") if metric == "value" else metric
    selected = selected or (allowed[0] if allowed else None)
    if not selected:
        raise ValueError("dataset has no metric column for time series")
    validate_identifier(selected, "time series metric")
    if selected not in allowed:
        raise ValueError(f"time series metric is not declared by this dataset: {selected}")
    return selected


def normalize_time_series_aggregation(value: str | None) -> str:
    normalized = str(value or "sum").strip().lower()
    if normalized not in {"sum", "avg", "min", "max", "count"}:
        raise ValueError(f"unsupported time series aggregation: {value}")
    return normalized


def resolve_time_series_identity_filter(
    dataset: dict[str, Any],
    identity_column: str | None,
    identity_value: str | None,
) -> tuple[str, str] | None:
    if not identity_column and identity_value in {None, ""}:
        return None
    if not identity_column or identity_value in {None, ""}:
        raise ValueError("time series identity filter requires both identity_column and identity_value")
    source_fields = sampled_grid_source_fields(dataset)
    source_identity_column = source_fields.get("id") if identity_column == "cell_id" else identity_column
    validate_identifier(source_identity_column, "time series identity column")
    allowed = set(dataset.get("display_columns") or [])
    for role_key in ("time_column", "id_column", "lat_column", "lon_column"):
        role_column = dataset.get(role_key)
        if role_column:
            allowed.add(role_column)
    for metric_column in dataset.get("metric_columns") or []:
        allowed.add(metric_column)
    if source_identity_column not in allowed:
        raise ValueError(f"time series identity column is not declared by this dataset: {identity_column}")
    return source_identity_column, str(identity_value)


@contextmanager
def mysql_connection(
    config: dict[str, Any],
    database: str | None = None,
    *,
    dict_cursor: bool = False,
    connection: dict[str, Any] | None = None,
    use_connection_database: bool = True,
):
    if connection is not None:
        mysql = dict(connection)
    else:
        connections = connection_configs(config)
        ref = config.get("default_connection_ref") or DEFAULT_MYSQL_CONNECTION_REF
        mysql = dict(connections.get(ref) or connections[DEFAULT_MYSQL_CONNECTION_REF])
    database_name = database
    if database_name is None and use_connection_database:
        database_name = mysql.get("database")
    kwargs = {
        "host": mysql.get("host", "127.0.0.1"),
        "port": int(mysql.get("port", 3306)),
        "user": mysql.get("user", "root"),
        "password": setting_secret(mysql.get("password", "")),
        "database": database_name,
        "charset": "utf8mb4",
        "autocommit": True,
    }
    if dict_cursor:
        kwargs["cursorclass"] = DictCursor
    conn = pymysql.connect(**kwargs)
    try:
        yield conn
    finally:
        conn.close()


def ensure_database(
    config: dict[str, Any],
    *,
    connection: dict[str, Any] | None = None,
    database: str | None = None,
) -> None:
    mysql = dict(connection) if connection is not None else connection_configs(config)[DEFAULT_MYSQL_CONNECTION_REF]
    database_name = validate_identifier(database or mysql["database"], "database")
    with mysql_connection(config, database=None, connection=mysql) as conn, conn.cursor() as cur:
        cur.execute(
            f"CREATE DATABASE IF NOT EXISTS {mysql_quote(database_name)} "
            "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )


def mysql_type(duckdb_type: str) -> str:
    kind = duckdb_type.upper()
    if kind == "DATE":
        return "DATE"
    if "TIMESTAMP" in kind:
        return "DATETIME"
    if kind in {"TINYINT", "SMALLINT", "INTEGER", "BIGINT", "UBIGINT"}:
        return "BIGINT"
    if kind == "HUGEINT":
        return "DECIMAL(38,0)"
    if kind in {"REAL", "FLOAT", "DOUBLE"} or kind.startswith("DECIMAL"):
        return "DOUBLE"
    if kind == "BOOLEAN":
        return "BOOLEAN"
    return "TEXT"


def duckdb_schema(con: duckdb.DuckDBPyConnection, source_table: str) -> list[tuple[str, str]]:
    return [(row[0], row[1]) for row in con.execute(f"DESCRIBE {duckdb_table_sql(source_table)}").fetchall()]


def create_mysql_table(conn, table: str, schema: list[tuple[str, str]], *, replace: bool) -> None:
    column_defs = [f"{mysql_quote(column)} {mysql_type(duck_type)} NULL" for column, duck_type in schema]
    with conn.cursor() as cur:
        if replace:
            cur.execute(f"DROP TABLE IF EXISTS {mysql_quote(table)}")
        cur.execute(
            f"CREATE TABLE IF NOT EXISTS {mysql_quote(table)} "
            f"({', '.join(column_defs)}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )


def create_indexes(conn, table: str, columns: set[str], dataset: dict[str, Any]) -> None:
    fields = sampled_grid_source_fields(dataset)
    specs = []
    time_column = fields.get("time")
    lat_column = fields.get("lat")
    lon_column = fields.get("lon")
    id_column = fields.get("id")
    if time_column in columns:
        specs.append(("idx_time", [time_column]))
    if lat_column in columns and lon_column in columns:
        specs.append(("idx_location", [lat_column, lon_column]))
    if id_column in columns:
        specs.append(("idx_identity", [id_column]))
    with conn.cursor() as cur:
        for index_name, index_columns in specs:
            column_sql = ", ".join(mysql_quote(column) for column in index_columns)
            try:
                cur.execute(f"CREATE INDEX {mysql_quote(index_name)} ON {mysql_quote(table)} ({column_sql})")
            except pymysql.err.OperationalError as exc:
                if exc.args and exc.args[0] == 1061:
                    continue
                raise


def import_duckdb_to_mysql(
    config: dict[str, Any],
    *,
    dataset_id: str,
    source: Path,
    replace: bool,
    row_limit: int | None,
    chunk_size: int,
) -> dict[str, Any]:
    dataset = config["datasets"][dataset_id]
    kind, connection_ref, connection = dataset_backend_info(config, dataset)
    if kind != "mysql":
        raise UnsupportedQueryOperation(kind, "DuckDB import", "DuckDB import currently writes only MySQL read models")
    source_table = dataset["duckdb_source_table"]
    target_table = mysql_dataset_table(dataset)
    database = validate_identifier(dataset.get("database") or connection["database"], "database")
    if not source.exists():
        raise FileNotFoundError(source)

    ensure_database(config, connection=connection, database=database)
    started = time.perf_counter()
    duck_con = duckdb.connect(str(source), read_only=True)
    try:
        schema = duckdb_schema(duck_con, source_table)
        columns = [name for name, _ in schema]
        column_sql = ", ".join(duckdb_quote(column) for column in columns)
        limit_sql = f" LIMIT {int(row_limit)}" if row_limit is not None else ""
        query = f"SELECT {column_sql} FROM {duckdb_table_sql(source_table)}{limit_sql}"

        with mysql_connection(config, database, connection=connection) as mysql_conn:
            create_mysql_table(mysql_conn, target_table, schema, replace=replace)
            insert_columns = ", ".join(mysql_quote(column) for column in columns)
            placeholders = ", ".join(["%s"] * len(columns))
            insert_sql = (
                f"INSERT INTO {mysql_quote(target_table)} ({insert_columns}) "
                f"VALUES ({placeholders})"
            )
            cursor = duck_con.execute(query)
            total = 0
            with mysql_conn.cursor() as cur:
                while True:
                    rows = cursor.fetchmany(chunk_size)
                    if not rows:
                        break
                    cur.executemany(insert_sql, rows)
                    total += len(rows)
                    print(f"imported_rows={total}", flush=True)
            create_indexes(mysql_conn, target_table, set(columns), dataset)
    finally:
        duck_con.close()
    return {
        "rows": total,
        "seconds": round(time.perf_counter() - started, 3),
        "backend": kind,
        "connection_ref": connection_ref,
    }


def _mysql_schema_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    connection_ref: str,
    connection: dict[str, Any],
) -> dict[str, Any]:
    table = mysql_dataset_table(dataset)
    database = validate_identifier(dataset.get("database") or connection["database"], "database")
    cache_key = f"{dataset_cache_namespace(dataset)}|{connection_ref}.{database}.{table}"
    cached = _SCHEMA_CACHE.get(cache_key)
    if cached and time.time() - cached["created_at"] < 300:
        packet = dict(cached["packet"])
        packet["timing"] = dict(packet["timing"])
        packet["timing"]["cache_hit"] = True
        return packet

    time_column = dataset["time_column"]
    lat_column = dataset["lat_column"]
    lon_column = dataset["lon_column"]
    started = time.perf_counter()
    with mysql_connection(config, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
        cur.execute(f"SHOW COLUMNS FROM {mysql_quote(table)}")
        columns = rows_json_ready(cur.fetchall())
        cur.execute(f"SELECT COUNT(*) AS row_count FROM {mysql_quote(table)}")
        row_count = int(cur.fetchone()["row_count"])
        cur.execute(
            f"SELECT MIN({mysql_quote(lat_column)}) AS min_lat, MAX({mysql_quote(lat_column)}) AS max_lat, "
            f"MIN({mysql_quote(lon_column)}) AS min_lon, MAX({mysql_quote(lon_column)}) AS max_lon "
            f"FROM {mysql_quote(table)}"
        )
        bounds = {key: json_ready(value) for key, value in cur.fetchone().items()}
        cur.execute(
            f"SELECT DISTINCT {mysql_quote(time_column)} AS value FROM {mysql_quote(table)} "
            f"WHERE {mysql_quote(time_column)} IS NOT NULL ORDER BY {mysql_quote(time_column)} LIMIT 370"
        )
        dates = [json_ready(row["value"]) for row in cur.fetchall()]
    packet = {
        "columns": columns,
        "row_count": row_count,
        "bounds": bounds,
        "dates": dates,
        "timing": {"query_ms": elapsed_ms(started), "cache_hit": False},
    }
    _SCHEMA_CACHE[cache_key] = {"created_at": time.time(), "packet": packet}
    return packet


def _mysql_records_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    connection: dict[str, Any],
    date_value: str | None,
    bbox: tuple[float, float, float, float] | None,
    limit: int,
    offset: int,
    column_profile: str | None = None,
) -> dict[str, Any]:
    table = mysql_dataset_table(dataset)
    database = validate_identifier(dataset.get("database") or connection["database"], "database")
    time_column = dataset["time_column"]
    lat_column = dataset["lat_column"]
    lon_column = dataset["lon_column"]
    columns = resolve_dataset_columns(dataset, column_profile)
    policy = query_policy(config)
    limit = effective_records_limit(limit, policy)
    offset = max(0, int(offset))
    if policy["require_time_or_bbox_filter"] and not date_value and not bbox:
        raise ValueError("records query requires date or bbox filter")
    where_parts = []
    params: list[Any] = []
    if date_value:
        where_parts.append(f"{mysql_quote(time_column)} = %s")
        params.append(date_value)
    if bbox:
        west, south, east, north = bbox
        where_parts.append(f"{mysql_quote(lon_column)} BETWEEN %s AND %s")
        params.extend([west, east])
        where_parts.append(f"{mysql_quote(lat_column)} BETWEEN %s AND %s")
        params.extend([south, north])
    cache_key = _records_cache_key(
        cache_namespace=dataset_cache_namespace(dataset),
        connection=connection,
        database=database,
        table=table,
        columns=columns,
        column_profile=column_profile,
        date_value=date_value,
        bbox=bbox,
        limit=limit,
        offset=offset,
    )
    cached = _cached_records_packet(cache_key)
    if cached:
        return cached
    where_sql = "WHERE " + " AND ".join(where_parts) if where_parts else ""
    column_sql = ", ".join(mysql_quote(column) for column in columns)
    order_sql = f"{mysql_quote(time_column)}, {mysql_quote(lat_column)}, {mysql_quote(lon_column)}"
    sql = f"SELECT {column_sql} FROM {mysql_quote(table)} {where_sql} ORDER BY {order_sql}"
    if limit is None:
        if offset:
            sql += " LIMIT 18446744073709551615 OFFSET %s"
            params.append(offset)
    else:
        sql += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])

    total_start = time.perf_counter()
    query_start = time.perf_counter()
    with mysql_connection(config, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        raw_rows = cur.fetchall()
    query_ms = elapsed_ms(query_start)
    serialize_start = time.perf_counter()
    rows = rows_json_ready(raw_rows)
    serialize_ms = elapsed_ms(serialize_start)
    packet = {
        "rows": rows,
        "row_count": len(rows),
        "limit": limit,
        "limit_mode": "unlimited" if limit is None else "limited",
        "offset": offset,
        "column_profile": column_profile or "display",
        "columns": columns,
        "query_policy": policy,
        "timing": {
            "query_ms": query_ms,
            "serialize_ms": serialize_ms,
            "server_total_ms": elapsed_ms(total_start),
        },
    }
    _remember_records_packet(cache_key, packet)
    return packet


def _mysql_records_range_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    connection: dict[str, Any],
    start_date: str,
    end_date: str,
    bbox: tuple[float, float, float, float] | None,
    limit: Any,
    column_profile: str | None = None,
) -> dict[str, Any]:
    from common_adapter.services.snapshot_split import split_rows_by_date

    table = mysql_dataset_table(dataset)
    database = validate_identifier(dataset.get("database") or connection["database"], "database")
    time_column = dataset["time_column"]
    lat_column = dataset["lat_column"]
    lon_column = dataset["lon_column"]
    columns = resolve_dataset_columns(dataset, column_profile or "render")
    policy = query_policy(config)
    limit = effective_records_limit(limit, policy)
    if not start_date or not end_date:
        raise ValueError("range records query requires start and end")
    if start_date > end_date:
        start_date, end_date = end_date, start_date

    cache_key = _range_records_cache_key(
        cache_namespace=dataset_cache_namespace(dataset),
        connection=connection,
        database=database,
        table=table,
        columns=columns,
        column_profile=column_profile,
        start_date=start_date,
        end_date=end_date,
        bbox=bbox,
        limit=limit,
    )
    cached = _cached_records_packet(
        cache_key,
        zero_timing_keys=("query_ms", "split_ms", "serialize_ms", "server_total_ms"),
    )
    if cached:
        return cached

    where_parts = [f"{mysql_quote(time_column)} BETWEEN %s AND %s"]
    params: list[Any] = [start_date, end_date]
    if bbox:
        west, south, east, north = bbox
        where_parts.append(f"{mysql_quote(lon_column)} BETWEEN %s AND %s")
        params.extend([west, east])
        where_parts.append(f"{mysql_quote(lat_column)} BETWEEN %s AND %s")
        params.extend([south, north])

    where_sql = "WHERE " + " AND ".join(where_parts)
    column_sql = ", ".join(mysql_quote(column) for column in columns)
    order_sql = f"{mysql_quote(time_column)}, {mysql_quote(lat_column)}, {mysql_quote(lon_column)}"
    if limit is None:
        sql = f"SELECT {column_sql} FROM {mysql_quote(table)} {where_sql} ORDER BY {order_sql}"
        limit_mode = "unlimited"
    else:
        # Range playback preheat needs one capped snapshot per date. A single global
        # LIMIT makes early dates consume the whole range budget and forces the
        # browser back into slow per-day fallback requests.
        rank_column = "__rrkal_snapshot_rank"
        sql = (
            f"SELECT {column_sql} FROM ("
            f"SELECT {column_sql}, "
            f"ROW_NUMBER() OVER (PARTITION BY {mysql_quote(time_column)} ORDER BY {order_sql}) AS {mysql_quote(rank_column)} "
            f"FROM {mysql_quote(table)} {where_sql}"
            f") AS ranked "
            f"WHERE {mysql_quote(rank_column)} <= %s "
            f"ORDER BY {order_sql}"
        )
        params.append(limit)
        limit_mode = "per_snapshot"

    total_start = time.perf_counter()
    query_start = time.perf_counter()
    with mysql_connection(config, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        raw_rows = cur.fetchall()
    query_ms = elapsed_ms(query_start)
    split = split_rows_by_date(raw_rows, date_column=time_column)
    row_count = int(split["row_count"])
    packet = {
        "start": start_date,
        "end": end_date,
        "snapshots": split["snapshots"],
        "dates": split["dates"],
        "snapshot_count": int(split["snapshot_count"]),
        "row_count": row_count,
        "truncated": False if limit is None else any(len(snapshot_rows) >= limit for snapshot_rows in split["snapshots"].values()),
        "limit": limit,
        "limit_mode": limit_mode,
        "column_profile": column_profile or "render",
        "columns": columns,
        "query_policy": policy,
        "splitter": split["engine"],
        "worker_hint": split["worker_hint"],
        "timing": {
            "cache_hit": False,
            "query_ms": query_ms,
            "split_ms": split["split_ms"],
            "serialize_ms": 0,
            "server_total_ms": elapsed_ms(total_start),
        },
    }
    _remember_records_packet(cache_key, packet)
    return packet


def _mysql_time_series_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    connection: dict[str, Any],
    start_date: str,
    end_date: str,
    bbox: tuple[float, float, float, float] | None,
    metric: str | None = None,
    aggregation: str | None = None,
    identity_column: str | None = None,
    identity_value: str | None = None,
) -> dict[str, Any]:
    table = mysql_dataset_table(dataset)
    database = validate_identifier(dataset.get("database") or connection["database"], "database")
    time_column = dataset["time_column"]
    lat_column = dataset["lat_column"]
    lon_column = dataset["lon_column"]
    metric_column = resolve_time_series_metric(dataset, metric)
    sampled_fields = sampled_grid_source_fields(dataset)
    metric_role = (
        "value"
        if dataset.get("sampled_grid") and metric_column == sampled_fields.get("value")
        else metric_column
    )
    aggregate = normalize_time_series_aggregation(aggregation)
    identity_filter = resolve_time_series_identity_filter(dataset, identity_column, identity_value)
    if not start_date or not end_date:
        raise ValueError("time series query requires start and end")
    if start_date > end_date:
        start_date, end_date = end_date, start_date

    cache_key = _time_series_cache_key(
        cache_namespace=dataset_cache_namespace(dataset),
        connection=connection,
        database=database,
        table=table,
        metric=metric_column,
        aggregation=aggregate,
        start_date=start_date,
        end_date=end_date,
        bbox=bbox,
        identity_column=identity_filter[0] if identity_filter else None,
        identity_value=identity_filter[1] if identity_filter else None,
    )
    cached = _cached_records_packet(cache_key)
    if cached:
        return cached

    where_parts = [f"{mysql_quote(time_column)} BETWEEN %s AND %s"]
    params: list[Any] = [start_date, end_date]
    if bbox:
        west, south, east, north = bbox
        where_parts.append(f"{mysql_quote(lon_column)} BETWEEN %s AND %s")
        params.extend([west, east])
        where_parts.append(f"{mysql_quote(lat_column)} BETWEEN %s AND %s")
        params.extend([south, north])
    if identity_filter:
        where_parts.append(f"{mysql_quote(identity_filter[0])} = %s")
        params.append(identity_filter[1])

    metric_sql = mysql_quote(metric_column)
    if aggregate == "count":
        value_sql = "COUNT(*)"
    elif aggregate == "avg":
        value_sql = f"AVG({metric_sql})"
    elif aggregate == "min":
        value_sql = f"MIN({metric_sql})"
    elif aggregate == "max":
        value_sql = f"MAX({metric_sql})"
    else:
        value_sql = f"SUM({metric_sql})"
    time_sql = mysql_quote(time_column)
    where_sql = "WHERE " + " AND ".join(where_parts)
    sql = (
        f"SELECT {time_sql} AS bucket, {value_sql} AS value, COUNT(*) AS row_count "
        f"FROM {mysql_quote(table)} {where_sql} "
        f"GROUP BY {time_sql} ORDER BY {time_sql}"
    )

    total_start = time.perf_counter()
    query_start = time.perf_counter()
    with mysql_connection(config, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        raw_rows = cur.fetchall()
    query_ms = elapsed_ms(query_start)
    points = [
        {
            "date": json_ready(row["bucket"]),
            "value": json_ready(row["value"]),
            "row_count": int(row["row_count"] or 0),
        }
        for row in raw_rows
    ]
    packet = {
        "start": start_date,
        "end": end_date,
        "metric": metric_role,
        "source_metric": metric_column,
        "aggregation": aggregate,
        "points": points,
        "point_count": len(points),
        "row_count": sum(point["row_count"] for point in points),
        "bbox": None if bbox is None else {
            "west": bbox[0],
            "south": bbox[1],
            "east": bbox[2],
            "north": bbox[3],
        },
        "identity": None if identity_filter is None else {
            "column": (
                "cell_id"
                if dataset.get("sampled_grid") and identity_filter[0] == sampled_fields.get("id")
                else identity_filter[0]
            ),
            "value": identity_filter[1],
        },
        "query_policy": query_policy(config),
        "timing": {
            "cache_hit": False,
            "query_ms": query_ms,
            "serialize_ms": 0,
            "server_total_ms": elapsed_ms(total_start),
        },
    }
    _remember_records_packet(cache_key, packet)
    return packet


def read_backend(config: dict[str, Any], dataset: dict[str, Any]):
    register_builtin_query_adapters()
    kind = dataset_backend_kind(config, dataset)
    return instantiate_query_adapter(kind, config, dataset)


def schema_packet(config: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    packet = read_backend(config, dataset).schema_packet()
    return canonicalize_sampled_grid_schema_packet(packet, dataset)


def records_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    date_value: str | None,
    bbox: tuple[float, float, float, float] | None,
    limit: int,
    offset: int,
    column_profile: str | None = None,
    query_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    packet = read_backend(config, dataset).records_packet(
        date_value=date_value,
        bbox=bbox,
        limit=limit,
        offset=offset,
        column_profile=column_profile,
        query_context=query_context,
    )
    return canonicalize_sampled_grid_packet(packet, dataset)


def records_range_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    start_date: str,
    end_date: str,
    bbox: tuple[float, float, float, float] | None,
    limit: int,
    column_profile: str | None = None,
    query_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    backend = read_backend(config, dataset)
    if not hasattr(backend, "records_range_packet"):
        raise UnsupportedQueryOperation(
            dataset_backend_kind(config, dataset),
            "records_range_packet",
            "range preheat is not supported by this backend",
        )
    packet = backend.records_range_packet(
        start_date=start_date,
        end_date=end_date,
        bbox=bbox,
        limit=limit,
        column_profile=column_profile,
        query_context=query_context,
    )
    return canonicalize_sampled_grid_range_packet(packet, dataset)


def time_series_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    start_date: str,
    end_date: str,
    bbox: tuple[float, float, float, float] | None,
    metric: str | None = None,
    aggregation: str | None = None,
    identity_column: str | None = None,
    identity_value: str | None = None,
    query_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    backend = read_backend(config, dataset)
    if not hasattr(backend, "time_series_packet"):
        raise UnsupportedQueryOperation(
            dataset_backend_kind(config, dataset),
            "time_series_packet",
            "time-series aggregation is not supported by this backend",
        )
    packet = backend.time_series_packet(
        start_date=start_date,
        end_date=end_date,
        bbox=bbox,
        metric=metric,
        aggregation=aggregation,
        identity_column=identity_column,
        identity_value=identity_value,
        query_context=query_context,
    )
    return canonicalize_sampled_grid_time_series_packet(packet, dataset)


def parse_bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if not value:
        return None
    parts = [float(part) for part in value.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be west,south,east,north")
    west, south, east, north = parts
    if west > east or south > north:
        raise ValueError("bbox ranges are invalid")
    return west, south, east, north
