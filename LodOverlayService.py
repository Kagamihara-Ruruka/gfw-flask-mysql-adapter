from __future__ import annotations

import time
import json
from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock
from typing import Any

import psycopg

from SpatialOverlay import elapsed_ms, overlay_settings, postgis_dsn, validate_identifier


_TILE_CACHE: OrderedDict[tuple[Any, ...], tuple[bytes, dict[str, Any]]] = OrderedDict()
_TILE_CACHE_LOCK = RLock()
_DEFAULT_TILE_CACHE_MAX = 2048


@dataclass(frozen=True)
class LodSource:
    table: str
    lod: str
    extent: int
    buffer: int
    simplify_meters: float


WEB_MERCATOR_WORLD_METERS = 40075016.68557849
LEAFLET_TILE_PIXELS = 256
MVT_EXTENT = 4096
MVT_BUFFER = 64


def mvt_detail_for_zoom(zoom: float | int | None) -> tuple[int, int, float]:
    z = int(zoom) if zoom is not None else 0
    tile_meters = WEB_MERCATOR_WORLD_METERS / (2 ** max(0, z))
    visible_pixel_meters = tile_meters / LEAFLET_TILE_PIXELS
    return MVT_EXTENT, MVT_BUFFER, visible_pixel_meters


def eez_tile_cache_max(config: dict[str, Any]) -> int:
    settings = overlay_settings(config)
    cache_max = settings.get("tile_cache_max", _DEFAULT_TILE_CACHE_MAX)
    try:
        return max(0, int(cache_max))
    except (TypeError, ValueError):
        return _DEFAULT_TILE_CACHE_MAX


def tile_cache_key(
    pg: dict[str, Any],
    *,
    kind: str,
    source: LodSource,
    geom_col: str,
    layer: str,
    z: int,
    x: int,
    y: int,
) -> tuple[Any, ...]:
    return (
        kind,
        pg.get("host"),
        int(pg.get("port", 5432)),
        pg.get("database"),
        pg.get("user"),
        source.table,
        source.lod,
        geom_col,
        layer,
        z,
        x,
        y,
        source.extent,
        source.buffer,
        round(source.simplify_meters, 6),
    )


def cache_get(key: tuple[Any, ...]) -> tuple[bytes, dict[str, Any]] | None:
    with _TILE_CACHE_LOCK:
        cached = _TILE_CACHE.get(key)
        if cached is None:
            return None
        _TILE_CACHE.move_to_end(key)
        tile, meta = cached
        hit_meta = dict(meta)
        hit_meta["cache"] = "hit"
        hit_meta["timing"] = {"tile_ms": 0.0}
        return tile, hit_meta


def cache_set(
    key: tuple[Any, ...],
    value: tuple[bytes, dict[str, Any]],
    *,
    cache_max: int,
) -> None:
    if cache_max <= 0:
        return
    with _TILE_CACHE_LOCK:
        _TILE_CACHE[key] = value
        _TILE_CACHE.move_to_end(key)
        while len(_TILE_CACHE) > cache_max:
            _TILE_CACHE.popitem(last=False)


def eez_lod_source(config: dict[str, Any], zoom: float | int | None) -> LodSource:
    settings = overlay_settings(config)
    pg = settings.get("postgis") or {}
    z = int(zoom) if zoom is not None else 0
    extent, buffer, simplify_meters = mvt_detail_for_zoom(z)
    table = pg.get("tile_table") or pg.get("table", "eez_v12")
    return LodSource(
        table=validate_identifier(table, "postgis tile table"),
        lod=f"web_mercator_z{z}",
        extent=extent,
        buffer=buffer,
        simplify_meters=simplify_meters,
    )


def eez_boundary_lod_source(config: dict[str, Any], zoom: float | int | None) -> LodSource:
    settings = overlay_settings(config)
    pg = settings.get("postgis") or {}
    z = int(zoom) if zoom is not None else 0
    extent, buffer, simplify_meters = mvt_detail_for_zoom(z)
    base_table = pg.get("table", "eez_v12")
    table = pg.get("boundary_table", f"{base_table}_boundary")
    return LodSource(
        table=validate_identifier(table, "postgis boundary table"),
        lod=f"web_mercator_boundary_z{z}",
        extent=extent,
        buffer=buffer,
        simplify_meters=simplify_meters,
    )


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
    key = tile_cache_key(pg, kind="fill", source=source, geom_col=geom_col, layer=layer, z=z, x=x, y=y)
    cached = cache_get(key)
    if cached is not None:
        return cached
    sql = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        source_geom AS (
            SELECT
                fid,
                iso3,
                name,
                sovereign,
                area_km2,
                ST_Transform(source.{geom_col}, 3857) AS geom
            FROM {source.table} AS source, bounds
            WHERE source.{geom_col} && ST_Transform(bounds.geom, 4326)
        ),
        mvtgeom AS (
            SELECT
                fid,
                iso3,
                name,
                sovereign,
                area_km2,
                ST_AsMVTGeom(
                    ST_SimplifyPreserveTopology(source_geom.geom, %s),
                    bounds.geom,
                    extent => %s,
                    buffer => %s,
                    clip_geom => true
                ) AS geom
            FROM source_geom, bounds
        )
        SELECT ST_AsMVT(mvtgeom.*, %s, %s, 'geom') AS tile
        FROM mvtgeom
    """
    with psycopg.connect(postgis_dsn(pg)) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (z, x, y, source.simplify_meters, source.extent, source.buffer, layer, source.extent))
            tile = cur.fetchone()[0] or b""
    meta = {
        "source": "postgis",
        "format": "mvt",
        "layer": layer,
        "lod": source.lod,
        "cache": "miss",
        "table": source.table,
        "z": z,
        "x": x,
        "y": y,
        "extent": source.extent,
        "buffer": source.buffer,
        "simplify_meters": source.simplify_meters,
        "bytes": len(tile),
        "timing": {"tile_ms": elapsed_ms(started)},
    }
    result = bytes(tile), meta
    cache_set(key, result, cache_max=eez_tile_cache_max(config))
    return result


def eez_boundary_mvt_tile_packet(
    config: dict[str, Any],
    *,
    z: int,
    x: int,
    y: int,
) -> tuple[bytes, dict[str, Any]]:
    pg = validate_eez_postgis_settings(config)
    source = eez_boundary_lod_source(config, z)
    geom_col = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
    layer = validate_identifier(f"{pg.get('mvt_layer', 'eez')}_boundary", "mvt boundary layer")
    started = time.perf_counter()
    key = tile_cache_key(pg, kind="boundary", source=source, geom_col=geom_col, layer=layer, z=z, x=x, y=y)
    cached = cache_get(key)
    if cached is not None:
        return cached
    sql = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        source_geom AS (
            SELECT
                fid,
                iso3,
                name,
                sovereign,
                area_km2,
                ST_Transform(source.{geom_col}, 3857) AS geom
            FROM {source.table} AS source, bounds
            WHERE source.{geom_col} && ST_Transform(bounds.geom, 4326)
        ),
        mvtgeom AS (
            SELECT
                fid,
                iso3,
                name,
                sovereign,
                area_km2,
                ST_AsMVTGeom(
                    ST_Simplify(source_geom.geom, %s),
                    bounds.geom,
                    extent => %s,
                    buffer => %s,
                    clip_geom => true
                ) AS geom
            FROM source_geom, bounds
        )
        SELECT ST_AsMVT(mvtgeom.*, %s, %s, 'geom') AS tile
        FROM mvtgeom
    """
    with psycopg.connect(postgis_dsn(pg)) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (z, x, y, source.simplify_meters, source.extent, source.buffer, layer, source.extent))
            tile = cur.fetchone()[0] or b""
    meta = {
        "source": "postgis",
        "format": "mvt",
        "layer": layer,
        "lod": source.lod,
        "cache": "miss",
        "table": source.table,
        "z": z,
        "x": x,
        "y": y,
        "extent": source.extent,
        "buffer": source.buffer,
        "simplify_meters": source.simplify_meters,
        "bytes": len(tile),
        "timing": {"tile_ms": elapsed_ms(started)},
    }
    result = bytes(tile), meta
    cache_set(key, result, cache_max=eez_tile_cache_max(config))
    return result


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
