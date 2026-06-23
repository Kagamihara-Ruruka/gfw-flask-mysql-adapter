from __future__ import annotations

import time
import json
from dataclasses import dataclass
from typing import Any

import psycopg

from SpatialOverlay import elapsed_ms, overlay_settings, postgis_dsn, validate_identifier


@dataclass(frozen=True)
class LodSource:
    table: str
    lod: str


def eez_lod_source(config: dict[str, Any], zoom: float | int | None) -> LodSource:
    settings = overlay_settings(config)
    pg = settings.get("postgis") or {}
    z = int(zoom) if zoom is not None else 0
    if z <= 3 and pg.get("tile_low_table"):
        table = pg["tile_low_table"]
        lod = "low"
    elif z <= 5 and pg.get("tile_mid_table"):
        table = pg["tile_mid_table"]
        lod = "mid"
    else:
        table = pg.get("tile_table") or pg.get("table", "eez_v12")
        lod = "full" if z > 5 else "full_fallback"
    return LodSource(table=validate_identifier(table, "postgis LOD table"), lod=lod)


def validate_eez_postgis_settings(config: dict[str, Any]) -> dict[str, Any]:
    settings = overlay_settings(config)
    if not settings["enabled"]:
        raise ValueError("EEZ overlay is disabled")
    if settings.get("provider") != "postgis":
        raise ValueError("EEZ LOD service requires overlays.eez.provider=postgis")
    pg = settings.get("postgis") or {}
    if not pg:
        raise ValueError("overlays.eez.postgis is required")
    return pg


def eez_mvt_tile_packet(
    config: dict[str, Any],
    *,
    z: int,
    x: int,
    y: int,
) -> tuple[bytes, dict[str, Any]]:
    pg = validate_eez_postgis_settings(config)
    source = eez_lod_source(config, z)
    geom_col = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
    layer = validate_identifier(pg.get("mvt_layer", "eez"), "mvt layer")
    started = time.perf_counter()
    sql = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        mvtgeom AS (
            SELECT
                fid,
                iso3,
                name,
                sovereign,
                area_km2,
                ST_AsMVTGeom(
                    ST_Transform(source.{geom_col}, 3857),
                    bounds.geom,
                    extent => 8192,
                    buffer => 128,
                    clip_geom => true
                ) AS geom
            FROM {source.table} AS source, bounds
            WHERE source.{geom_col} && ST_Transform(bounds.geom, 4326)
        )
        SELECT ST_AsMVT(mvtgeom.*, %s, 8192, 'geom') AS tile
        FROM mvtgeom
    """
    with psycopg.connect(postgis_dsn(pg)) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (z, x, y, layer))
            tile = cur.fetchone()[0] or b""
    meta = {
        "source": "postgis",
        "format": "mvt",
        "layer": layer,
        "lod": source.lod,
        "table": source.table,
        "z": z,
        "x": x,
        "y": y,
        "bytes": len(tile),
        "timing": {"tile_ms": elapsed_ms(started)},
    }
    return bytes(tile), meta


def eez_boundary_mvt_tile_packet(
    config: dict[str, Any],
    *,
    z: int,
    x: int,
    y: int,
) -> tuple[bytes, dict[str, Any]]:
    pg = validate_eez_postgis_settings(config)
    base_table = pg.get("table", "eez_v12")
    boundary_table = validate_identifier(
        pg.get("boundary_table", f"{base_table}_boundary"),
        "postgis EEZ boundary table",
    )
    geom_col = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
    layer = validate_identifier(f"{pg.get('mvt_layer', 'eez')}_boundary", "mvt boundary layer")
    started = time.perf_counter()
    sql = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        mvtgeom AS (
            SELECT
                fid,
                iso3,
                name,
                sovereign,
                area_km2,
                ST_AsMVTGeom(
                    ST_Transform(source.{geom_col}, 3857),
                    bounds.geom,
                    extent => 8192,
                    buffer => 128,
                    clip_geom => true
                ) AS geom
            FROM {boundary_table} AS source, bounds
            WHERE source.{geom_col} && ST_Transform(bounds.geom, 4326)
        )
        SELECT ST_AsMVT(mvtgeom.*, %s, 8192, 'geom') AS tile
        FROM mvtgeom
    """
    with psycopg.connect(postgis_dsn(pg)) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (z, x, y, layer))
            tile = cur.fetchone()[0] or b""
    meta = {
        "source": "postgis",
        "format": "mvt",
        "layer": layer,
        "lod": "boundary",
        "table": boundary_table,
        "z": z,
        "x": x,
        "y": y,
        "bytes": len(tile),
        "timing": {"tile_ms": elapsed_ms(started)},
    }
    return bytes(tile), meta


def eez_geojson_packet(
    config: dict[str, Any],
    *,
    bbox: tuple[float, float, float, float] | None,
    zoom: float | int | None,
    limit: int = 3000,
) -> dict[str, Any]:
    pg = validate_eez_postgis_settings(config)
    source_table = validate_identifier(pg.get("table", "eez_v12"), "postgis EEZ source table")
    geom_col = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
    row_limit = max(1, min(int(limit), 500))
    started = time.perf_counter()

    where_sql = ""
    params: list[Any] = []
    if bbox is not None:
        west, south, east, north = bbox
        where_sql = f"WHERE source.{geom_col} && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"
        params.extend([west, south, east, north])
    params.append(row_limit)

    sql = f"""
        SELECT
            fid,
            iso3,
            name,
            sovereign,
            area_km2,
            ST_AsGeoJSON(source.{geom_col}) AS geometry
        FROM {source_table} AS source
        {where_sql}
        ORDER BY fid
        LIMIT %s
    """
    with psycopg.connect(postgis_dsn(pg)) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

    features = [
        {
            "type": "Feature",
            "properties": {
                "fid": row[0],
                "iso3": row[1],
                "name": row[2],
                "sovereign": row[3],
                "area_km2": row[4],
            },
            "geometry": json.loads(row[5]),
        }
        for row in rows
    ]
    return {
        "type": "FeatureCollection",
        "source": "postgis",
        "format": "geojson",
        "lod": "source_geometry",
        "table": source_table,
        "feature_count": len(features),
        "total_feature_count": len(features),
        "detail": "source_geometry",
        "limit": row_limit,
        "features": features,
        "timing": {"query_ms": elapsed_ms(started)},
    }
