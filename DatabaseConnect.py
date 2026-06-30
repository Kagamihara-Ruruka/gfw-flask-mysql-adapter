from __future__ import annotations

import datetime as dt
import decimal
import json
import os
import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

import duckdb
import pymysql
from pymysql.cursors import DictCursor

from database.registry import UnsupportedBackendOperation, database_backend, instantiate_backend

ROOT = Path(__file__).resolve().parent
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DEFAULT_MYSQL_CONNECTION_REF = "local_mysql"


def default_config_path() -> Path:
    local = ROOT / "config" / "adapter.local.json"
    if local.exists():
        return local
    return ROOT / "config" / "adapter.example.json"


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    config_path = Path(path) if path else default_config_path()
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    with config_path.open("r", encoding="utf-8") as fh:
        config = json.load(fh)
    validate_config(config)
    return config


def validate_config(config: dict[str, Any]) -> None:
    if "datasets" not in config:
        raise ValueError("config must contain datasets")
    if "mysql" not in config and "connections" not in config:
        raise ValueError("config must contain mysql or connections")
    backend = config.get("sql_backend", {})
    if backend.get("kind", "mysql") not in {"mysql", "hive"}:
        raise ValueError("sql_backend.kind must be mysql or hive")
    validate_connections(config)
    policy = query_policy(config)
    if policy["default_limit"] > policy["max_limit"]:
        raise ValueError("query_policy.default_limit must not exceed query_policy.max_limit")
    server = server_settings(config)
    if server["default_command"] != "serve":
        raise ValueError("server.default_command currently supports only serve")
    for dataset_id, dataset in config["datasets"].items():
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
    connections: dict[str, dict[str, Any]] = {
        key: dict(value) for key, value in (config.get("connections") or {}).items()
    }
    if "mysql" in config:
        legacy_mysql = {
            "kind": "mysql",
            "driver": "pymysql",
            **dict(config["mysql"]),
        }
        connections.setdefault(DEFAULT_MYSQL_CONNECTION_REF, legacy_mysql)
        connections.setdefault("default_mysql", legacy_mysql)
    return connections


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
        if kind not in {"mysql", "hive"}:
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


def json_ready(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        as_int = int(value)
        return as_int if value == as_int else float(value)
    return value


def rows_json_ready(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{key: json_ready(value) for key, value in row.items()} for row in rows]


def elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def query_policy(config: dict[str, Any]) -> dict[str, Any]:
    policy = config.get("query_policy", {})
    return {
        "default_limit": int(policy.get("default_limit", 1000)),
        "max_limit": int(policy.get("max_limit", 5000)),
        "table_preview_limit": int(policy.get("table_preview_limit", 300)),
        "require_time_or_bbox_filter": bool(policy.get("require_time_or_bbox_filter", True)),
    }


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


@contextmanager
def mysql_connection(
    config: dict[str, Any],
    database: str | None = None,
    *,
    dict_cursor: bool = False,
    connection: dict[str, Any] | None = None,
):
    if connection is not None:
        mysql = dict(connection)
    else:
        connections = connection_configs(config)
        ref = config.get("default_connection_ref") or DEFAULT_MYSQL_CONNECTION_REF
        mysql = dict(connections.get(ref) or connections[DEFAULT_MYSQL_CONNECTION_REF])
    kwargs = {
        "host": mysql.get("host", "127.0.0.1"),
        "port": int(mysql.get("port", 3306)),
        "user": mysql.get("user", "root"),
        "password": setting_secret(mysql.get("password", "")),
        "database": database if database is not None else mysql.get("database"),
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


def create_indexes(conn, table: str, columns: set[str]) -> None:
    specs = []
    if "obs_date" in columns:
        specs.append(("idx_obs_date", ["obs_date"]))
    if {"lat", "lon"}.issubset(columns):
        specs.append(("idx_lat_lon", ["lat", "lon"]))
    if "grid_id" in columns:
        specs.append(("idx_grid_id", ["grid_id"]))
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
        raise UnsupportedBackendOperation(kind, "DuckDB import", "GFW import currently writes only MySQL read models")
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
            create_indexes(mysql_conn, target_table, set(columns))
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
    cache_key = f"{connection_ref}.{database}.{table}"
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
) -> dict[str, Any]:
    table = mysql_dataset_table(dataset)
    database = validate_identifier(dataset.get("database") or connection["database"], "database")
    time_column = dataset["time_column"]
    lat_column = dataset["lat_column"]
    lon_column = dataset["lon_column"]
    columns = dataset["display_columns"]
    policy = query_policy(config)
    limit = max(1, min(int(limit), policy["max_limit"]))
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
    where_sql = "WHERE " + " AND ".join(where_parts) if where_parts else ""
    column_sql = ", ".join(mysql_quote(column) for column in columns)
    order_sql = f"{mysql_quote(time_column)}, {mysql_quote(lat_column)}, {mysql_quote(lon_column)}"
    sql = (
        f"SELECT {column_sql} FROM {mysql_quote(table)} {where_sql} "
        f"ORDER BY {order_sql} LIMIT %s OFFSET %s"
    )
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
    return {
        "rows": rows,
        "row_count": len(rows),
        "limit": limit,
        "offset": offset,
        "query_policy": policy,
        "timing": {
            "query_ms": query_ms,
            "serialize_ms": serialize_ms,
            "server_total_ms": elapsed_ms(total_start),
        },
    }


@database_backend("mysql")
class MySqlReadBackend:
    def __init__(self, config: dict[str, Any], dataset: dict[str, Any]) -> None:
        self.config = config
        self.dataset = dataset
        self.kind, self.connection_ref, self.connection = dataset_backend_info(config, dataset)
        if self.kind != "mysql":
            raise ValueError(f"MySqlReadBackend cannot serve backend {self.kind!r}")

    def schema_packet(self) -> dict[str, Any]:
        packet = _mysql_schema_packet(
            self.config,
            self.dataset,
            connection_ref=self.connection_ref,
            connection=self.connection,
        )
        packet["backend"] = {"kind": self.kind, "connection_ref": self.connection_ref}
        return packet

    def records_packet(
        self,
        *,
        date_value: str | None,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        packet = _mysql_records_packet(
            self.config,
            self.dataset,
            connection=self.connection,
            date_value=date_value,
            bbox=bbox,
            limit=limit,
            offset=offset,
        )
        packet["backend"] = {"kind": self.kind, "connection_ref": self.connection_ref}
        return packet


@database_backend("hive")
class HiveReadBackend:
    def __init__(self, config: dict[str, Any], dataset: dict[str, Any]) -> None:
        self.config = config
        self.dataset = dataset
        self.kind, self.connection_ref, self.connection = dataset_backend_info(config, dataset)

    def schema_packet(self) -> dict[str, Any]:
        raise UnsupportedBackendOperation(
            "hive",
            "schema_packet",
            "define the Hive/Trino read-model contract before enabling this dataset",
        )

    def records_packet(
        self,
        *,
        date_value: str | None,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        raise UnsupportedBackendOperation(
            "hive",
            "records_packet",
            "define the Hive/Trino viewport query contract before enabling this dataset",
        )


def read_backend(config: dict[str, Any], dataset: dict[str, Any]):
    kind = dataset_backend_kind(config, dataset)
    return instantiate_backend(kind, config, dataset)


def schema_packet(config: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    return read_backend(config, dataset).schema_packet()


def records_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    date_value: str | None,
    bbox: tuple[float, float, float, float] | None,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    return read_backend(config, dataset).records_packet(
        date_value=date_value,
        bbox=bbox,
        limit=limit,
        offset=offset,
    )


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
