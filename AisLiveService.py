from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any

from DatabaseConnect import (
    connection_configs,
    default_connection_ref,
    elapsed_ms,
    json_ready,
    mysql_connection,
    mysql_quote,
    query_policy,
    validate_identifier,
)


def ais_live_settings(config: dict[str, Any]) -> dict[str, Any]:
    settings = config.get("live", {}).get("ais", {})
    if not settings:
        return {"enabled": False}
    policy = query_policy(config)
    configured_limit = settings.get("limit", policy["default_limit"])
    limit = None if configured_limit in {None, "max", "all", "unbounded"} else int(configured_limit)
    connection_ref = str(settings.get("connection_ref") or "")
    database = settings.get("database") or _default_ais_database(config, settings, connection_ref)
    return {
        "enabled": bool(settings.get("enabled", False)),
        "connection_ref": connection_ref,
        "connection": settings.get("connection", {}),
        "database": database,
        "table": settings.get("table", ""),
        "time_column": settings.get("time_column", "timestamp"),
        "lat_column": settings.get("lat_column", "lat"),
        "lon_column": settings.get("lon_column", "lon"),
        "mmsi_column": settings.get("mmsi_column", "mmsi"),
        "speed_column": settings.get("speed_column"),
        "course_column": settings.get("course_column"),
        "heading_column": settings.get("heading_column"),
        "name_column": settings.get("name_column"),
        "source_column": settings.get("source_column"),
        "include_sources": settings.get("include_sources", []),
        "max_age_minutes": int(settings.get("max_age_minutes", 60)),
        "limit": limit,
    }


def _default_ais_database(config: dict[str, Any], settings: dict[str, Any], connection_ref: str) -> str:
    connections = connection_configs(config)
    if connection_ref and connection_ref in connections:
        return str(connections[connection_ref].get("database") or "")
    inline_database = (settings.get("connection") or {}).get("database")
    if inline_database:
        return str(inline_database)
    ref = default_connection_ref(config, "mysql")
    if ref and ref in connections:
        return str(connections[ref].get("database") or "")
    return str((config.get("mysql") or {}).get("database") or "")


def ais_mysql_connection_info(
    config: dict[str, Any],
    settings: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    connection_ref = str(settings.get("connection_ref") or "")
    if connection_ref:
        connections = connection_configs(config)
        if connection_ref not in connections:
            raise ValueError(f"unknown live.ais.connection_ref: {connection_ref}")
        connection = dict(connections[connection_ref])
        if str(connection.get("kind", "mysql")).lower() != "mysql":
            raise ValueError(f"live.ais.connection_ref must point to mysql: {connection_ref}")
        return connection_ref, connection

    inline = settings.get("connection") or {}
    if inline:
        connection = {
            "kind": "mysql",
            "driver": "pymysql",
            "host": inline.get("host", "127.0.0.1"),
            "port": int(inline.get("port", 3306)),
            "user": inline.get("user", "root"),
            "password": inline.get("password", ""),
            "database": settings.get("database") or inline.get("database") or _default_ais_database(config, settings, ""),
        }
        return "live.ais.connection", connection

    ref = default_connection_ref(config, "mysql")
    connections = connection_configs(config)
    if ref not in connections:
        raise ValueError(f"unknown default mysql connection_ref: {ref}")
    return ref, dict(connections[ref])


@contextmanager
def _ais_mysql_connection(config: dict[str, Any], settings: dict[str, Any], database: str):
    _connection_ref, connection = ais_mysql_connection_info(config, settings)
    with mysql_connection(config, database, dict_cursor=True, connection=connection) as conn:
        yield conn


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
        "source": _optional_column(settings, "source_column"),
    }
    limit = None if settings["limit"] is None else max(1, int(settings["limit"]))
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
    source_column = optional_columns.get("source")
    include_sources = [str(value) for value in settings.get("include_sources", []) if str(value)]
    if source_column and include_sources:
        placeholders = ", ".join(["%s"] * len(include_sources))
        where_parts.append(f"{mysql_quote(source_column)} IN ({placeholders})")
        params.extend(include_sources)
    if bbox:
        west, south, east, north = bbox
        where_parts.append(f"{mysql_quote(lon_column)} BETWEEN %s AND %s")
        params.extend([west, east])
        where_parts.append(f"{mysql_quote(lat_column)} BETWEEN %s AND %s")
        params.extend([south, north])

    limit_sql = ""
    if limit is not None:
        limit_sql = " LIMIT %s"
        params.append(limit)
    sql = (
        f"SELECT {', '.join(select_parts)} FROM {mysql_quote(table)} "
        f"WHERE {' AND '.join(where_parts)} "
        f"ORDER BY {mysql_quote(time_column)} DESC{limit_sql}"
    )

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
        "source_filter": {
            "column": source_column,
            "include_sources": include_sources,
        },
        "timing": {"query_ms": elapsed_ms(started)},
    }


def merged_ais_live_packet(
    config: dict[str, Any],
    *,
    bboxes: list[tuple[float, float, float, float] | None],
) -> dict[str, Any]:
    packets = [ais_live_packet(config, bbox=bbox) for bbox in (bboxes or [None])]
    if any(packet.get("status") != "ok" for packet in packets):
        first = next((packet for packet in packets if packet.get("status") != "ok"), packets[0])
        return {
            "status": first.get("status", "error"),
            "message": first.get("message", "AIS live source failed."),
            "rows": [],
            "row_count": 0,
            "timing": {"query_ms": 0},
        }

    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    query_ms = 0.0
    limit: int | None = 0
    max_age_minutes = 0
    source_filter = {}
    for packet in packets:
        query_ms += float(packet.get("timing", {}).get("query_ms", 0))
        packet_limit = packet.get("limit")
        if packet_limit is None:
            limit = None
        elif limit is not None:
            limit = max(limit, int(packet_limit))
        max_age_minutes = max(max_age_minutes, int(packet.get("max_age_minutes", 0)))
        source_filter = packet.get("source_filter") or source_filter
        for row in packet.get("rows", []):
            key = f"{row.get('mmsi')}|{row.get('event_time')}|{row.get('lat')}|{row.get('lon')}"
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)

    return {
        "status": "ok",
        "rows": rows,
        "row_count": len(rows),
        "limit": limit,
        "max_age_minutes": max_age_minutes,
        "source_filter": source_filter,
        "timing": {"query_ms": query_ms},
    }
