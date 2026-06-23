from __future__ import annotations

import os
import time
from contextlib import contextmanager
from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from DatabaseConnect import elapsed_ms, json_ready, mysql_connection, mysql_quote, query_policy, validate_identifier


def ais_live_settings(config: dict[str, Any]) -> dict[str, Any]:
    settings = config.get("live", {}).get("ais", {})
    if not settings:
        return {"enabled": False}
    policy = query_policy(config)
    configured_limit = settings.get("limit", min(5000, policy["max_limit"]))
    limit = policy["max_limit"] if configured_limit == "max" else int(configured_limit)
    return {
        "enabled": bool(settings.get("enabled", False)),
        "connection": settings.get("connection", {}),
        "database": settings.get("database") or config["mysql"]["database"],
        "table": settings.get("table", ""),
        "time_column": settings.get("time_column", "timestamp"),
        "lat_column": settings.get("lat_column", "lat"),
        "lon_column": settings.get("lon_column", "lon"),
        "mmsi_column": settings.get("mmsi_column", "mmsi"),
        "speed_column": settings.get("speed_column"),
        "course_column": settings.get("course_column"),
        "heading_column": settings.get("heading_column"),
        "name_column": settings.get("name_column"),
        "max_age_minutes": int(settings.get("max_age_minutes", 60)),
        "limit": limit,
    }


def _setting_secret(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    if value.startswith("env:"):
        return os.environ.get(value[4:], "")
    return value


@contextmanager
def _ais_mysql_connection(config: dict[str, Any], settings: dict[str, Any], database: str):
    connection = settings.get("connection") or {}
    if not connection:
        with mysql_connection(config, database, dict_cursor=True) as conn:
            yield conn
        return
    kwargs = {
        "host": connection.get("host", "127.0.0.1"),
        "port": int(connection.get("port", 3306)),
        "user": connection.get("user", "root"),
        "password": _setting_secret(connection.get("password", "")),
        "database": database,
        "charset": "utf8mb4",
        "autocommit": True,
        "cursorclass": DictCursor,
    }
    conn = pymysql.connect(**kwargs)
    try:
        yield conn
    finally:
        conn.close()


def _optional_column(settings: dict[str, Any], key: str) -> str | None:
    value = settings.get(key)
    if not value:
        return None
    return validate_identifier(value, key)


def ais_live_packet(
    config: dict[str, Any],
    *,
    bbox: tuple[float, float, float, float] | None,
) -> dict[str, Any]:
    settings = ais_live_settings(config)
    if not settings.get("enabled"):
        return {
            "status": "not_configured",
            "message": "AIS live source is not configured.",
            "rows": [],
            "row_count": 0,
        }

    table = validate_identifier(settings["table"], "live.ais.table")
    database = validate_identifier(settings["database"], "live.ais.database")
    time_column = validate_identifier(settings["time_column"], "live.ais.time_column")
    lat_column = validate_identifier(settings["lat_column"], "live.ais.lat_column")
    lon_column = validate_identifier(settings["lon_column"], "live.ais.lon_column")
    mmsi_column = validate_identifier(settings["mmsi_column"], "live.ais.mmsi_column")
    optional_columns = {
        "speed": _optional_column(settings, "speed_column"),
        "course": _optional_column(settings, "course_column"),
        "heading": _optional_column(settings, "heading_column"),
        "name": _optional_column(settings, "name_column"),
    }
    limit = max(1, min(int(settings["limit"]), query_policy(config)["max_limit"]))
    max_age_minutes = max(1, int(settings["max_age_minutes"]))

    select_parts = [
        f"{mysql_quote(mmsi_column)} AS mmsi",
        f"{mysql_quote(time_column)} AS event_time",
        f"{mysql_quote(lat_column)} AS lat",
        f"{mysql_quote(lon_column)} AS lon",
    ]
    for alias, column in optional_columns.items():
        if column:
            select_parts.append(f"{mysql_quote(column)} AS {mysql_quote(alias)}")

    where_parts = [
        f"{mysql_quote(time_column)} >= (UTC_TIMESTAMP() - INTERVAL %s MINUTE)",
        f"{mysql_quote(lat_column)} IS NOT NULL",
        f"{mysql_quote(lon_column)} IS NOT NULL",
    ]
    params: list[Any] = [max_age_minutes]
    if bbox:
        west, south, east, north = bbox
        where_parts.append(f"{mysql_quote(lon_column)} BETWEEN %s AND %s")
        params.extend([west, east])
        where_parts.append(f"{mysql_quote(lat_column)} BETWEEN %s AND %s")
        params.extend([south, north])

    sql = (
        f"SELECT {', '.join(select_parts)} FROM {mysql_quote(table)} "
        f"WHERE {' AND '.join(where_parts)} "
        f"ORDER BY {mysql_quote(time_column)} DESC LIMIT %s"
    )
    params.append(limit)

    started = time.perf_counter()
    with _ais_mysql_connection(config, settings, database) as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = [{key: json_ready(value) for key, value in row.items()} for row in cur.fetchall()]
    return {
        "status": "ok",
        "rows": rows,
        "row_count": len(rows),
        "limit": limit,
        "max_age_minutes": max_age_minutes,
        "timing": {"query_ms": elapsed_ms(started)},
    }
