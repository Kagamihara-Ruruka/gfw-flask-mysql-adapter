from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from common_adapter.db.connect import (
    connection_configs,
    mysql_connection,
    validate_identifier,
)
from common_adapter.endpoint.client import EndpointHttpClient, EndpointRequestError
from common_adapter.query.serialization import json_ready


PROFILE_VERSION = "rrkal.schema_profile.relational.v1"
_PROFILE_CACHE: dict[str, dict[str, Any]] = {}
_PROFILE_CACHE_TTL_SECONDS = 60


def _route_ref(config_ref: str, route_config: dict[str, Any]) -> str:
    return str(route_config.get("name") or route_config.get("id") or Path(config_ref).stem).strip()


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
    numeric_types = {
        "float", "float4", "float8", "real", "double", "decimal", "numeric",
        "int", "integer", "bigint", "smallint", "tinyint",
    }
    if data_type.lower() in numeric_types:
        hints.append("numeric_candidate")
    if data_type.lower() in {"float", "float4", "float8", "real", "double", "decimal", "numeric"}:
        hints.append("continuous_candidate")
    return hints


def _value_semantics_candidate(name: str, data_type: str, hints: list[str]) -> dict[str, Any]:
    normalized_type = str(data_type or "").strip().lower()
    return {
        "kind": "continuous" if "continuous_candidate" in hints else "unknown",
        "provenance": "source_scout",
        "evidence": {
            "source_field": str(name or ""),
            "data_type": normalized_type or "unknown",
            "semantic_hints": list(hints),
        },
    }


def inspect_mysql_route(
    config_ref: str,
    route_config: dict[str, Any],
    *,
    inspectable_connection_refs: set[str] | None = None,
    router_rows_by_connection: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    profiles: list[dict[str, Any]] = []
    route_ref = _route_ref(config_ref, route_config)
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
                    "route_ref": route_ref,
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
                semantic_hints = _column_hints(column_name, data_type)
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
                        "semantic_hints": semantic_hints,
                        "value_semantics_candidate": _value_semantics_candidate(
                            column_name,
                            data_type,
                            semantic_hints,
                        ),
                    }
                )

            profile = {
                "profile_version": PROFILE_VERSION,
                "config_path": config_ref,
                "route_ref": route_ref,
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
                    "mapping": {
                        "supported": True,
                        "editable": True,
                        "provenance": "source_schema",
                    },
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
                "route_ref": route_ref,
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
                    "mapping": {
                        "supported": False,
                        "editable": False,
                        "provenance": "unavailable",
                    },
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


def _json_data_type(values: list[Any]) -> str:
    non_null = [value for value in values if value is not None]
    if not non_null:
        return "null"
    kinds = {type(value) for value in non_null}
    if kinds <= {bool}:
        return "boolean"
    if kinds <= {int}:
        return "integer"
    if kinds <= {int, float}:
        return "double"
    if kinds <= {str}:
        return "string"
    if kinds <= {dict}:
        return "object"
    if kinds <= {list}:
        return "array"
    return "mixed"


def _catalog_tables(catalog_body: Any) -> list[dict[str, Any]]:
    root = catalog_body if isinstance(catalog_body, dict) else {"catalog": catalog_body}
    tables: list[dict[str, Any]] = []
    for name, value in root.items():
        rows = value if isinstance(value, list) else [value]
        object_rows = [row for row in rows if isinstance(row, dict)]
        if object_rows:
            field_names = sorted({str(field) for row in object_rows for field in row})
            columns = []
            for ordinal, field_name in enumerate(field_names, start=1):
                field_values = [row.get(field_name) for row in object_rows]
                data_type = _json_data_type(field_values)
                semantic_hints = _column_hints(field_name, data_type)
                columns.append(
                    {
                        "name": field_name,
                        "ordinal": ordinal,
                        "column_type": data_type,
                        "data_type": data_type,
                        "nullable": any(value is None for value in field_values),
                        "key": "",
                        "semantic_hints": semantic_hints,
                        "value_semantics_candidate": _value_semantics_candidate(
                            field_name,
                            data_type,
                            semantic_hints,
                        ),
                    }
                )
        else:
            data_type = _json_data_type(rows)
            semantic_hints = _column_hints("value", data_type)
            columns = [
                {
                    "name": "value",
                    "ordinal": 1,
                    "column_type": data_type,
                    "data_type": data_type,
                    "nullable": any(item is None for item in rows),
                    "key": "",
                    "semantic_hints": semantic_hints,
                    "value_semantics_candidate": _value_semantics_candidate(
                        "value",
                        data_type,
                        semantic_hints,
                    ),
                }
            ]
        tables.append(
            {
                "name": str(name),
                "type": "CATALOG_COLLECTION" if isinstance(value, list) else "CATALOG_VALUE",
                "estimated_rows": len(rows),
                "columns": columns,
                "schema_provenance": "source_catalog",
            }
        )
    return tables


def inspect_http_catalog_route(
    config_ref: str,
    path: Any,
    route_config: dict[str, Any],
    *,
    router_row: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    route_ref = _route_ref(config_ref, route_config)
    backend = route_config.get("backend") if isinstance(route_config.get("backend"), dict) else {}
    started = time.perf_counter()
    cache_key = f"{config_ref}|{route_ref}|http_catalog"
    cached = _PROFILE_CACHE.get(cache_key)
    if cached and time.time() - cached["created_at"] < _PROFILE_CACHE_TTL_SECONDS:
        packet = dict(cached["packet"])
        packet["cache_hit"] = True
        packet["router_source"] = {
            "enabled": bool((router_row or {}).get("enabled")),
            "connected": bool((router_row or {}).get("connected")),
            "detail": str((router_row or {}).get("detail") or ""),
        }
        return [packet]

    status = "ok"
    detail = "source catalog inspected"
    catalog_path = ""
    tables: list[dict[str, Any]] = []
    try:
        client = EndpointHttpClient.from_config(route_config)
        catalog_path, catalog_body = client.first_json(client.target.catalog_paths)
        tables = _catalog_tables(catalog_body)
    except (EndpointRequestError, ValueError) as exc:
        status = "error"
        detail = str(exc)
    profile = {
        "profile_version": PROFILE_VERSION,
        "config_path": config_ref,
        "route_ref": route_ref,
        "connection_ref": route_ref,
        "backend": str(backend.get("kind") or "database").lower(),
        "database": route_ref,
        "status": status,
        "detail": detail,
        "catalog_path": catalog_path,
        "router_source": {
            "enabled": bool((router_row or {}).get("enabled")),
            "connected": bool((router_row or {}).get("connected")),
            "detail": str((router_row or {}).get("detail") or ""),
        },
        "capabilities": {
            "schema_discovery": status == "ok",
            "mapping": {
                "supported": True,
                "editable": False,
                "provenance": "mapping_artifact",
            },
            "viewport_query": None,
            "time_filter": None,
        },
        "tables": tables,
        "timing": {"query_ms": round((time.perf_counter() - started) * 1000, 3)},
        "cache_hit": False,
    }
    if status == "ok":
        _PROFILE_CACHE[cache_key] = {"created_at": time.time(), "packet": profile}
    return [profile]


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
    for config_ref, path, route_config in active_routes:
        adapter = route_config.get("adapter") if isinstance(route_config.get("adapter"), dict) else {}
        adapter_kind = str(adapter.get("kind") or "").strip().lower()
        if adapter_kind in {"http", "http_endpoint", "rest"}:
            route_ref = _route_ref(config_ref, route_config)
            route_rows = router_rows_by_config.get(config_ref, {})
            router_row = route_rows.get(route_ref) or next(iter(route_rows.values()), {})
            profiles.extend(
                inspect_http_catalog_route(
                    config_ref,
                    path,
                    route_config,
                    router_row=router_row,
                )
            )
            continue
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
