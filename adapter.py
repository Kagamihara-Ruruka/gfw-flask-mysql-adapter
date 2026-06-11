from __future__ import annotations

import argparse
import datetime as dt
import decimal
import json
import os
import re
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

import duckdb
import pymysql
from flask import Flask, jsonify, render_template, request
from pymysql.cursors import DictCursor

ROOT = Path(__file__).resolve().parent
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


# 這份轉接頭刻意維持單檔：同時負責匯入、Flask API、MySQL 查詢，讓人類維護者能沿著一個檔案看完整 pipeline。
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
    if "mysql" not in config or "datasets" not in config:
        raise ValueError("config must contain mysql and datasets")
    backend = config.get("sql_backend", {})
    if backend.get("kind", "mysql") != "mysql" or backend.get("driver", "pymysql") != "pymysql":
        raise ValueError("this MVP currently supports only sql_backend kind=mysql driver=pymysql")
    policy = query_policy(config)
    if policy["default_limit"] > policy["max_limit"]:
        raise ValueError("query_policy.default_limit must not exceed query_policy.max_limit")
    server = server_settings(config)
    if server["default_command"] != "serve":
        raise ValueError("server.default_command currently supports only serve")
    for dataset_id, dataset in config["datasets"].items():
        validate_identifier(dataset_id, "dataset id")
        for key in ["mysql_table", "time_column", "lat_column", "lon_column"]:
            validate_identifier(dataset[key], key)
        for key in ["display_columns", "metric_columns", "category_columns"]:
            for column in dataset.get(key, []):
                validate_identifier(column, f"{dataset_id}.{key}")


def validate_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_RE.match(value):
        raise ValueError(f"invalid {label}: {value!r}")
    return value


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


# 查詢容量邊界集中在 config，避免前端或 API 偷偷把大表整批拉回 Python 或瀏覽器。
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


def port_is_busy(host: str, port: int) -> bool:
    probe_host = "127.0.0.1" if host in {"0.0.0.0", ""} else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((probe_host, port)) == 0


def windows_pids_listening_on_port(port: int) -> set[int]:
    output = subprocess.check_output(
        ["netstat", "-ano", "-p", "tcp"],
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    pids: set[int] = set()
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        local_address, state, pid_text = parts[1], parts[3].upper(), parts[4]
        if state != "LISTENING" or not local_address.endswith(f":{port}"):
            continue
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid != os.getpid():
            pids.add(pid)
    return pids


def free_configured_port_if_needed(host: str, port: int, *, enabled: bool) -> None:
    if not enabled or not port_is_busy(host, port):
        return
    if sys.platform != "win32":
        raise RuntimeError(f"port {port} is busy; automatic port cleanup is only implemented on Windows")

    # 給 IDE 使用：反覆按 Run 時常會留下上一個 Flask；這裡只殺掉正在 LISTENING 同一個 port 的 PID。
    pids = windows_pids_listening_on_port(port)
    if not pids:
        raise RuntimeError(f"port {port} is busy, but no listening PID was found")
    for pid in sorted(pids):
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], check=True)
    time.sleep(0.5)
    if port_is_busy(host, port):
        raise RuntimeError(f"port {port} is still busy after killing PID(s): {sorted(pids)}")


@contextmanager
def mysql_connection(config: dict[str, Any], database: str | None = None, *, dict_cursor: bool = False):
    # 目前只實作 MySQL/PyMySQL；未來若湖倉提供 Trino、Spark SQL 或 Databricks SQL，只替換這一層與查詢函式。
    mysql = config["mysql"]
    kwargs = {
        "host": mysql.get("host", "127.0.0.1"),
        "port": int(mysql.get("port", 3306)),
        "user": mysql.get("user", "root"),
        "password": mysql.get("password", ""),
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


def ensure_database(config: dict[str, Any]) -> None:
    database = validate_identifier(config["mysql"]["database"], "database")
    with mysql_connection(config, database=None) as conn, conn.cursor() as cur:
        cur.execute(
            f"CREATE DATABASE IF NOT EXISTS {mysql_quote(database)} "
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
    column_defs = []
    for column, duck_type in schema:
        column_defs.append(f"{mysql_quote(column)} {mysql_type(duck_type)} NULL")
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
    source_table = dataset["duckdb_source_table"]
    target_table = dataset["mysql_table"]
    if not source.exists():
        raise FileNotFoundError(source)

    # 匯入必須用 chunk streaming，不能把完整資料集塞進 pandas/DataFrame，否則更大資料集會直接 OOM。
    ensure_database(config)
    started = time.perf_counter()
    duck_con = duckdb.connect(str(source), read_only=True)
    try:
        schema = duckdb_schema(duck_con, source_table)
        columns = [name for name, _ in schema]
        column_sql = ", ".join(duckdb_quote(column) for column in columns)
        limit_sql = f" LIMIT {int(row_limit)}" if row_limit is not None else ""
        query = f"SELECT {column_sql} FROM {duckdb_table_sql(source_table)}{limit_sql}"

        with mysql_connection(config, config["mysql"]["database"]) as mysql_conn:
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
    return {"rows": total, "seconds": round(time.perf_counter() - started, 3)}


def schema_packet(config: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    table = dataset["mysql_table"]
    time_column = dataset["time_column"]
    lat_column = dataset["lat_column"]
    lon_column = dataset["lon_column"]
    started = time.perf_counter()
    with mysql_connection(config, config["mysql"]["database"], dict_cursor=True) as conn, conn.cursor() as cur:
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
    return {
        "columns": columns,
        "row_count": row_count,
        "bounds": bounds,
        "dates": dates,
        "timing": {"query_ms": elapsed_ms(started)},
    }


def records_packet(
    config: dict[str, Any],
    dataset: dict[str, Any],
    *,
    date_value: str | None,
    bbox: tuple[float, float, float, float] | None,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    table = dataset["mysql_table"]
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
    with mysql_connection(config, config["mysql"]["database"], dict_cursor=True) as conn, conn.cursor() as cur:
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


def create_app(config: dict[str, Any]) -> Flask:
    app = Flask(__name__)

    def get_dataset(dataset_id: str) -> dict[str, Any]:
        if dataset_id not in config["datasets"]:
            raise ValueError(f"unknown dataset: {dataset_id}")
        return config["datasets"][dataset_id]

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/favicon.ico")
    def favicon():
        # Chrome 會自動要求 favicon；MVP 不提供圖示時回 204，避免驗收 console 出現無意義 404。
        return "", 204

    @app.get("/api/health")
    def health():
        started = time.perf_counter()
        try:
            with mysql_connection(config, config["mysql"]["database"], dict_cursor=True) as conn, conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                ok = cur.fetchone()["ok"] == 1
            return jsonify(
                {
                    "status": "ok" if ok else "degraded",
                    "backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                    "datasets": sorted(config["datasets"].keys()),
                    "timing": {"db_ping_ms": elapsed_ms(started)},
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 503

    @app.get("/api/datasets")
    def datasets():
        safe = {}
        policy = query_policy(config)
        for dataset_id, dataset in config["datasets"].items():
            safe[dataset_id] = {
                "label": dataset.get("label", dataset_id),
                "time_column": dataset["time_column"],
                "lat_column": dataset["lat_column"],
                "lon_column": dataset["lon_column"],
                "display_columns": dataset["display_columns"],
                "metric_columns": dataset.get("metric_columns", []),
                "category_columns": dataset.get("category_columns", []),
            }
        return jsonify(
            {
                "default_dataset": config.get("default_dataset"),
                "sql_backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                "query_policy": policy,
                "datasets": safe,
            }
        )

    @app.get("/api/datasets/<dataset_id>/schema")
    def schema(dataset_id: str):
        try:
            dataset = get_dataset(dataset_id)
            packet = schema_packet(config, dataset)
            packet["dataset_id"] = dataset_id
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/datasets/<dataset_id>/records")
    def records(dataset_id: str):
        request_start = time.perf_counter()
        try:
            dataset = get_dataset(dataset_id)
            packet = records_packet(
                config,
                dataset,
                date_value=request.args.get("date"),
                bbox=parse_bbox(request.args.get("bbox")),
                limit=int(request.args.get("limit", str(query_policy(config)["default_limit"]))),
                offset=int(request.args.get("offset", "0")),
            )
            packet["dataset_id"] = dataset_id
            packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    return app


def command_import(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    dataset_id = args.dataset or config.get("default_dataset")
    result = import_duckdb_to_mysql(
        config,
        dataset_id=dataset_id,
        source=Path(args.source),
        replace=args.replace,
        row_limit=args.row_limit,
        chunk_size=args.chunk_size,
    )
    print(json.dumps({"status": "import_complete", **result}, ensure_ascii=False))
    return 0


def command_serve(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    server = server_settings(config)
    host = args.host or server["host"]
    port = args.port if args.port is not None else server["port"]
    debug = args.debug if args.debug is not None else server["debug"]
    free_configured_port_if_needed(host, port, enabled=server["kill_port_if_busy"])
    app = create_app(config)
    app.run(host=host, port=port, debug=debug, use_reloader=False)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="GFW Flask/PyMySQL adapter.")
    parser.add_argument("--config", default=None, help="Path to adapter config JSON.")
    subparsers = parser.add_subparsers(dest="command")

    import_parser = subparsers.add_parser("import", help="Import DuckDB table into MySQL.")
    import_parser.add_argument("--source", required=True, help="Path to source DuckDB file.")
    import_parser.add_argument("--dataset", default=None)
    import_parser.add_argument("--replace", action="store_true")
    import_parser.add_argument("--row-limit", type=int, default=None)
    import_parser.add_argument("--chunk-size", type=int, default=5000)
    import_parser.set_defaults(func=command_import)

    serve_parser = subparsers.add_parser("serve", help="Start the Flask server.")
    serve_parser.add_argument("--host", default=None)
    serve_parser.add_argument("--port", type=int, default=None)
    serve_parser.add_argument("--debug", action="store_true", default=None)
    serve_parser.set_defaults(func=command_serve)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command is None:
        # IDE 直接按 Run 時通常不會帶參數；此時讀設定檔，自動啟動 Flask。
        args.command = "serve"
        args.func = command_serve
        args.host = None
        args.port = None
        args.debug = None
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
