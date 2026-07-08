from __future__ import annotations

import time
from typing import Any

from common_adapter.db.connect import (
    connection_configs,
    json_ready,
    mysql_connection,
    validate_identifier,
)


PROFILE_VERSION = "rrkal.schema_profile.relational.v1"
_PROFILE_CACHE: dict[str, dict[str, Any]] = {}
_PROFILE_CACHE_TTL_SECONDS = 60


def _column_hints(name: str, data_type: str) -> list[str]:
    lowered = name.lower()
    hints: list[str] = []
    if lowered in {"lat", "latitude", "y"} or lowered.endswith("_lat"):
        hints.append("latitude_candidate")
    if lowered in {"lon", "lng", "longitude", "x"} or lowered.endswith(("_lon", "_lng")):
        hints.append("longitude_candidate")
    if any(token in lowered for token in ("date", "time", "timestamp", "datetime")):
        hints.append("time_candidate")
    if lowered in {"id", "mmsi", "grid_id"} or lowered.endswith("_id"):
        hints.append("identity_candidate")
    if data_type.lower() in {"float", "double", "decimal", "int", "bigint", "smallint", "tinyint"}:
        hints.append("numeric_candidate")
    return hints


def inspect_mysql_route(
    config_ref: str,
    route_config: dict[str, Any],
    *,
    inspectable_connection_refs: set[str] | None = None,
    router_rows_by_connection: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    profiles: list[dict[str, Any]] = []
    for connection_ref, connection in connection_configs(route_config).items():
        if inspectable_connection_refs is not None and connection_ref not in inspectable_connection_refs:
            continue
        router_row = (router_rows_by_connection or {}).get(connection_ref) or {}
        kind = str(connection.get("kind", "mysql")).lower()
        if kind != "mysql":
            profiles.append(
                {
                    "profile_version": PROFILE_VERSION,
                    "config_path": config_ref,
                    "connection_ref": connection_ref,
                    "backend": kind,
                    "status": "unsupported",
                    "detail": f"{kind} schema inspector is not implemented in the relational first cut",
                    "router_source": {
                        "enabled": bool(router_row.get("enabled")),
                        "connected": bool(router_row.get("connected")),
                        "detail": str(router_row.get("detail") or ""),
                    },
                    "tables": [],
                }
            )
            continue

        started = time.perf_counter()
        database = str(connection.get("database") or "")
        try:
            database = validate_identifier(database, f"{connection_ref}.database")
            cache_key = f"{config_ref}|{connection_ref}|{database}"
            cached = _PROFILE_CACHE.get(cache_key)
            if cached and time.time() - cached["created_at"] < _PROFILE_CACHE_TTL_SECONDS:
                packet = dict(cached["packet"])
                packet["cache_hit"] = True
                packet["router_source"] = {
                    "enabled": bool(router_row.get("enabled")),
                    "connected": bool(router_row.get("connected")),
                    "detail": str(router_row.get("detail") or ""),
                }
                profiles.append(packet)
                continue

            with mysql_connection(route_config, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = %s
                    ORDER BY TABLE_NAME
                    """,
                    (database,),
                )
                table_rows = cur.fetchall()

                cur.execute(
                    """
                    SELECT
                      TABLE_NAME,
                      COLUMN_NAME,
                      ORDINAL_POSITION,
                      COLUMN_TYPE,
                      DATA_TYPE,
                      IS_NULLABLE,
                      COLUMN_KEY,
                      COLUMN_DEFAULT,
                      EXTRA
                    FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = %s
                    ORDER BY TABLE_NAME, ORDINAL_POSITION
                    """,
                    (database,),
                )
                column_rows = cur.fetchall()

            tables: dict[str, dict[str, Any]] = {}
            for row in table_rows:
                table_name = str(row["TABLE_NAME"])
                tables[table_name] = {
                        "name": table_name,
                        "type": row.get("TABLE_TYPE") or "-",
                        "estimated_rows": json_ready(row.get("TABLE_ROWS")),
                        "columns": [],
                    }
            for row in column_rows:
                table_name = str(row["TABLE_NAME"])
                table = tables.setdefault(
                    table_name,
                    {
                        "name": table_name,
                        "type": "-",
                        "estimated_rows": None,
                        "columns": [],
                    },
                )
                column_name = str(row["COLUMN_NAME"])
                data_type = str(row.get("DATA_TYPE") or "")
                table["columns"].append(
                    {
                        "name": column_name,
                        "ordinal": int(row.get("ORDINAL_POSITION") or 0),
                        "column_type": str(row.get("COLUMN_TYPE") or ""),
                        "data_type": data_type,
                        "nullable": str(row.get("IS_NULLABLE") or "").upper() == "YES",
                        "key": str(row.get("COLUMN_KEY") or ""),
                        "default": json_ready(row.get("COLUMN_DEFAULT")),
                        "extra": str(row.get("EXTRA") or ""),
                        "semantic_hints": _column_hints(column_name, data_type),
                    }
                )

            profile = {
                "profile_version": PROFILE_VERSION,
                "config_path": config_ref,
                "connection_ref": connection_ref,
                "backend": "mysql",
                "database": database,
                "status": "ok",
                "detail": "schema inspected",
                "router_source": {
                    "enabled": bool(router_row.get("enabled")),
                    "connected": bool(router_row.get("connected")),
                    "detail": str(router_row.get("detail") or ""),
                },
                "capabilities": {
                    "schema_discovery": True,
                    "field_mapping": True,
                    "viewport_query": True,
                    "time_filter": True,
                },
                "tables": list(tables.values()),
                "timing": {"query_ms": round((time.perf_counter() - started) * 1000, 3)},
                "cache_hit": False,
            }
        except Exception as exc:
            profile = {
                "profile_version": PROFILE_VERSION,
                "config_path": config_ref,
                "connection_ref": connection_ref,
                "backend": "mysql",
                "database": database,
                "status": "error",
                "detail": str(exc),
                "router_source": {
                    "enabled": bool(router_row.get("enabled")),
                    "connected": bool(router_row.get("connected")),
                    "detail": str(router_row.get("detail") or ""),
                },
                "capabilities": {
                    "schema_discovery": False,
                    "field_mapping": False,
                    "viewport_query": False,
                    "time_filter": False,
                },
                "tables": [],
                "timing": {"query_ms": round((time.perf_counter() - started) * 1000, 3)},
                "cache_hit": False,
            }
        if profile["status"] == "ok":
            _PROFILE_CACHE[f"{config_ref}|{connection_ref}|{database}"] = {"created_at": time.time(), "packet": profile}
        profiles.append(profile)
    return profiles


def inspect_relational_routes(
    active_routes: list[tuple[str, Any, dict[str, Any]]],
    *,
    router_rows: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    inspectable_refs_by_config: dict[str, set[str]] | None = None
    router_rows_by_config: dict[str, dict[str, dict[str, Any]]] = {}
    if router_rows is not None:
        inspectable_refs_by_config = {}
        for row in router_rows:
            config_ref = str(row.get("config_path") or "")
            connection_ref = str(row.get("connection_ref") or "")
            if not config_ref or not connection_ref:
                continue
            router_rows_by_config.setdefault(config_ref, {})[connection_ref] = row
            if row.get("schema_inspectable"):
                inspectable_refs_by_config.setdefault(config_ref, set()).add(connection_ref)

    profiles: list[dict[str, Any]] = []
    for config_ref, _path, route_config in active_routes:
        inspectable_refs = inspectable_refs_by_config.get(config_ref, set()) if inspectable_refs_by_config is not None else None
        profiles.extend(
            inspect_mysql_route(
                config_ref,
                route_config,
                inspectable_connection_refs=inspectable_refs,
                router_rows_by_connection=router_rows_by_config.get(config_ref, {}),
            )
        )
    return profiles
