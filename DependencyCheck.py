from __future__ import annotations

from pathlib import Path
from typing import Any

import psycopg

from SpatialOverlay import overlay_settings, postgis_dsn, validate_identifier


class DependencyCheckError(RuntimeError):
    pass


def _table_has_rows(cursor: psycopg.Cursor[Any], table: str) -> bool:
    safe_table = validate_identifier(table, "PostGIS dependency table")
    cursor.execute(f"SELECT EXISTS (SELECT 1 FROM {safe_table} LIMIT 1)")
    return bool(cursor.fetchone()[0])


def check_eez_postgis_dependency(config: dict[str, Any]) -> dict[str, Any]:
    settings = overlay_settings(config)
    if not settings.get("enabled", True):
        return {"enabled": False, "provider": settings.get("provider"), "checked": False}
    if settings.get("provider") != "postgis":
        return {"enabled": True, "provider": settings.get("provider"), "checked": False}

    pg = settings.get("postgis") or {}
    if not pg:
        raise DependencyCheckError("EEZ is configured for PostGIS, but overlays.eez.postgis is missing.")

    base_table = validate_identifier(pg.get("table", "eez_v12"), "PostGIS EEZ table")
    tile_table = validate_identifier(pg.get("tile_table", f"{base_table}_tile"), "PostGIS EEZ tile table")
    boundary_table = validate_identifier(
        pg.get("boundary_table", f"{base_table}_boundary"),
        "PostGIS EEZ boundary table",
    )
    expected_tables = [base_table, tile_table, boundary_table]

    try:
        with psycopg.connect(postgis_dsn(pg), connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT PostGIS_Version()")
                postgis_version = cur.fetchone()[0]
                missing: list[str] = []
                empty: list[str] = []
                for table in expected_tables:
                    cur.execute("SELECT to_regclass(%s)", (table,))
                    if cur.fetchone()[0] is None:
                        missing.append(table)
                    elif not _table_has_rows(cur, table):
                        empty.append(table)
    except Exception as exc:
        raise DependencyCheckError(
            "EEZ requires a reachable PostgreSQL/PostGIS service. "
            "Start it with `docker compose up -d postgis`, then run `python core.py bootstrap-eez`."
        ) from exc

    if missing or empty:
        config_path = config.get("__config_path") or "config/adapter.local.json"
        gpkg_path = settings.get("full_gpkg_path") or "data/eez/eez_v12.gpkg"
        gpkg_hint = ""
        if gpkg_path and not Path(str(gpkg_path)).exists():
            gpkg_hint = f" Also make sure `{gpkg_path}` exists; run `python core.py --config {config_path} bootstrap-eez` first."
        raise DependencyCheckError(
            "EEZ PostGIS dependency is not ready. "
            f"Missing tables: {missing or 'none'}; empty tables: {empty or 'none'}. "
            f"Run `python core.py --config {config_path} bootstrap-eez`."
            f"{gpkg_hint}"
        )

    return {
        "enabled": True,
        "provider": "postgis",
        "checked": True,
        "postgis_version": postgis_version,
        "tables": expected_tables,
    }


def check_runtime_dependencies(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "eez_postgis": check_eez_postgis_dependency(config),
    }
