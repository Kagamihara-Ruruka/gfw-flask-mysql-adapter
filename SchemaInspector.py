from __future__ import annotations

import time
from typing import Any

from DatabaseConnect import (
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


def _legacy_dataset_refs(route_config: dict[str, Any], table: str, connection_ref: str, database: str) -> list[str]:
    refs: list[str] = []
    datasets = route_config.get("datasets")
    if not isinstance(datasets, dict):
        return refs
    for dataset_id, dataset in datasets.items():
        if not isinstance(dataset, dict):
            continue
        dataset_table = dataset.get("mysql_table") or dataset.get("table")
        dataset_connection_ref = str(dataset.get("connection_ref") or route_config.get("default_connection_ref") or "local_mysql")
        dataset_database = str(dataset.get("database") or database)
        if dataset_table == table and dataset_connection_ref == connection_ref and dataset_database == database:
            refs.append(str(dataset_id))
    return sorted(refs)


def inspect_mysql_route(config_ref: str, route_config: dict[str, Any]) -> list[dict[str, Any]]:
    profiles: list[dict[str, Any]] = []
    for connection_ref, connection in connection_configs(route_config).items():
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
                        "legacy_dataset_refs": _legacy_dataset_refs(route_config, table_name, connection_ref, database),
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
                        "legacy_dataset_refs": _legacy_dataset_refs(route_config, table_name, connection_ref, database),
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
                "legacy_contract": bool(route_config.get("datasets")),
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
                "legacy_contract": bool(route_config.get("datasets")),
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


def inspect_relational_routes(active_routes: list[tuple[str, Any, dict[str, Any]]]) -> list[dict[str, Any]]:
    profiles: list[dict[str, Any]] = []
    for config_ref, _path, route_config in active_routes:
        profiles.extend(inspect_mysql_route(config_ref, route_config))
    return profiles
