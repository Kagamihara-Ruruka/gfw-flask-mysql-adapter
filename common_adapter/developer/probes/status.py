from __future__ import annotations

from typing import Any

import psycopg

from common_adapter.db.connect import mysql_connection
from common_adapter.spatial.overlay import overlay_settings, postgis_dsn, validate_identifier

POSTGIS_CONNECT_TIMEOUT_SECONDS = 5


class RouteProbe:
    """Runtime status probes for source routes."""

    def connection_status_from_config(self, config_ref: str, data: dict[str, Any], active: bool) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        connections = data.get("connections")
        if isinstance(connections, dict) and connections:
            connection_items = [(str(ref), conn) for ref, conn in connections.items() if isinstance(conn, dict)]
        elif isinstance(data.get("mysql"), dict):
            connection_items = [("local_mysql", data["mysql"])]
        else:
            connection_items = []

        for connection_ref, connection in connection_items:
            kind = str(connection.get("kind") or data.get("sql_backend", {}).get("kind") or "mysql").lower()
            connected = False
            detail = "尚未測試"
            if kind == "mysql":
                try:
                    database = connection.get("database")
                    with mysql_connection(data, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
                        cur.execute("SELECT 1 AS ok")
                        connected = bool(cur.fetchone()["ok"])
                    detail = "連線成功" if connected else "連線失敗"
                except Exception as exc:
                    detail = str(exc)
            else:
                detail = f"{kind} 連線測試尚未實作"
            rows.append(
                {
                    "config_path": config_ref,
                    "connection_ref": connection_ref,
                    "backend": kind,
                    "enabled": active,
                    "connected": connected,
                    "detail": detail,
                }
            )
        return rows

    def table_exists_and_has_rows(self, cursor: psycopg.Cursor[Any], table: str) -> tuple[bool, bool]:
        safe_table = validate_identifier(table, "PostGIS table")
        cursor.execute("SELECT to_regclass(%s)", (safe_table,))
        exists = cursor.fetchone()[0] is not None
        if not exists:
            return False, False
        cursor.execute(f"SELECT EXISTS (SELECT 1 FROM {safe_table} LIMIT 1)")
        return True, bool(cursor.fetchone()[0])

    def spatial_status_from_config(self, config_ref: str, data: dict[str, Any]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        settings = overlay_settings(data)
        if settings.get("provider") != "postgis" and not settings.get("postgis"):
            return rows

        pg = settings.get("postgis") or {}
        base_table = str(pg.get("table") or "eez_v12")
        tile_table = str(pg.get("tile_table") or f"{base_table}_tile")
        boundary_table = str(pg.get("boundary_table") or f"{base_table}_boundary")
        expected_tables = [base_table, tile_table, boundary_table]
        enabled = bool(settings.get("enabled", True))
        connected = False
        ready = False
        table_state_records = [
            {"name": table, "status": "unchecked", "ready": False, "label": "未檢查"}
            for table in expected_tables
        ]
        ready_table_count = 0
        table_detail = "-"
        detail = "尚未測試"

        if not pg:
            detail = "overlays.eez.postgis 缺失"
        else:
            try:
                for table in expected_tables:
                    validate_identifier(table, "PostGIS table")
                with psycopg.connect(postgis_dsn(pg), connect_timeout=POSTGIS_CONNECT_TIMEOUT_SECONDS) as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT PostGIS_Version()")
                        postgis_version = cur.fetchone()[0]
                        connected = True
                        next_table_states = []
                        all_ready = True
                        for table in expected_tables:
                            exists, has_rows = self.table_exists_and_has_rows(cur, table)
                            if not exists:
                                next_table_states.append(
                                    {"name": table, "status": "missing", "ready": False, "label": "缺表"}
                                )
                                all_ready = False
                            elif not has_rows:
                                next_table_states.append(
                                    {"name": table, "status": "empty", "ready": False, "label": "空表"}
                                )
                                all_ready = False
                            else:
                                next_table_states.append(
                                    {"name": table, "status": "ok", "ready": True, "label": "就緒"}
                                )
                        ready = all_ready
                        table_state_records = next_table_states
                        ready_table_count = sum(1 for item in table_state_records if item["ready"])
                        table_detail = ", ".join(
                            f"{item['name']}:{item['status']}" for item in table_state_records
                        )
                        detail = f"PostGIS {postgis_version}"
            except Exception as exc:
                detail = str(exc)

        rows.append(
            {
                "config_path": config_ref,
                "overlay_ref": "eez",
                "backend": "postgis",
                "provider": str(settings.get("provider") or "-"),
                "enabled": enabled,
                "connected": connected,
                "ready": ready,
                "tables": table_detail,
                "table_states": table_state_records,
                "ready_table_count": ready_table_count,
                "expected_table_count": len(expected_tables),
                "detail": detail,
            }
        )
        return rows


DEFAULT_ROUTE_PROBE = RouteProbe()


def connection_status_from_config(config_ref: str, data: dict[str, Any], active: bool) -> list[dict[str, Any]]:
    return DEFAULT_ROUTE_PROBE.connection_status_from_config(config_ref, data, active)


def _table_exists_and_has_rows(cursor: psycopg.Cursor[Any], table: str) -> tuple[bool, bool]:
    return DEFAULT_ROUTE_PROBE.table_exists_and_has_rows(cursor, table)


def spatial_status_from_config(config_ref: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    return DEFAULT_ROUTE_PROBE.spatial_status_from_config(config_ref, data)
