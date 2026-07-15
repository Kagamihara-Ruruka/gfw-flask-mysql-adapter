from __future__ import annotations

import time
import json
from dataclasses import dataclass
from pathlib import Path
from threading import BoundedSemaphore, RLock
from typing import Any

import psycopg

from common_adapter.spatial.overlay import elapsed_ms, overlay_settings, postgis_dsn, validate_identifier
from common_adapter.spatial.tile_cache import MvtTileCache, TileCacheKey, TileCacheValue


ROOT = Path(__file__).resolve().parents[2]
_TILE_CACHE = MvtTileCache()
_EEZ_FILL_TABLE_LOCK = RLock()
_EEZ_QUERY_LIMITERS: dict[int, BoundedSemaphore] = {}
_EEZ_QUERY_LIMITERS_LOCK = RLock()
_DEFAULT_TILE_CACHE_MAX = 2048
_DEFAULT_TILE_QUERY_CONCURRENCY = 6


@dataclass(frozen=True)
class LodSource:
    table: str
    lod: str
    extent: int
    buffer: int
    simplify_meters: float
    geometry_srid: int = 4326


WEB_MERCATOR_WORLD_METERS = 40075016.68557849
GEOGRAPHIC_WORLD_DEGREES = 360.0
LEAFLET_TILE_PIXELS = 256
MVT_EXTENT = 4096
MVT_BUFFER = 64


def mvt_detail_for_zoom(zoom: float | int | None) -> tuple[int, int, float]:
    z = int(zoom) if zoom is not None else 0
    tile_meters = WEB_MERCATOR_WORLD_METERS / (2 ** max(0, z))
    visible_pixel_meters = tile_meters / LEAFLET_TILE_PIXELS
    return MVT_EXTENT, MVT_BUFFER, visible_pixel_meters


def geographic_pixel_degrees_for_zoom(zoom: float | int | None) -> float:
    z = int(zoom) if zoom is not None else 0
    return GEOGRAPHIC_WORLD_DEGREES / ((2 ** max(0, z)) * LEAFLET_TILE_PIXELS)


def eez_tile_cache_max(config: dict[str, Any]) -> int:
    settings = overlay_settings(config)
    cache_max = settings.get("tile_cache_max", _DEFAULT_TILE_CACHE_MAX)
    try:
        return max(0, int(cache_max))
    except (TypeError, ValueError):
        return _DEFAULT_TILE_CACHE_MAX


def eez_tile_cache_path(config: dict[str, Any]) -> Path | None:
    configured = overlay_settings(config).get("tile_cache_path")
    if configured is None or not str(configured).strip():
        return None
    path = Path(str(configured))
    if not path.is_absolute():
        path = ROOT / path
    return path.resolve()


def eez_tile_query_concurrency(config: dict[str, Any]) -> int:
    configured = overlay_settings(config).get("tile_query_concurrency")
    try:
        return max(1, int(configured))
    except (TypeError, ValueError):
        return _DEFAULT_TILE_QUERY_CONCURRENCY


def eez_tile_query_limiter(config: dict[str, Any]) -> BoundedSemaphore:
    concurrency = eez_tile_query_concurrency(config)
    with _EEZ_QUERY_LIMITERS_LOCK:
        return _EEZ_QUERY_LIMITERS.setdefault(concurrency, BoundedSemaphore(concurrency))


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
) -> TileCacheKey:
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


def cache_get(
    key: TileCacheKey,
    *,
    cache_max: int,
    cache_path: Path | None,
) -> TileCacheValue | None:
    return _TILE_CACHE.get(key, max_entries=cache_max, directory=cache_path)


def cache_set(
    key: TileCacheKey,
    value: TileCacheValue,
    *,
    cache_max: int,
    cache_path: Path | None,
) -> None:
    _TILE_CACHE.set(key, value, max_entries=cache_max, directory=cache_path)


def eez_lod_source(config: dict[str, Any], zoom: float | int | None) -> LodSource:
    settings = overlay_settings(config)
    pg = settings.get("postgis") or {}
    z = int(zoom) if zoom is not None else 0
    extent, buffer, simplify_meters = mvt_detail_for_zoom(z)
    base_table = validate_identifier(pg.get("table", "eez_v12"), "postgis EEZ source table")
    table = pg.get("tile_table", f"{base_table}_tile")
    return LodSource(
        table=validate_identifier(table, "postgis tile table"),
        lod=f"web_mercator_subdivided_z{z}",
        extent=extent,
        buffer=buffer,
        simplify_meters=simplify_meters,
        geometry_srid=4326,
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


def eez_fill_table_name(pg: dict[str, Any]) -> str:
    base_table = validate_identifier(pg.get("table", "eez_v12"), "postgis EEZ source table")
    return validate_identifier(pg.get("fill_table", f"{base_table}_fill"), "postgis fill table")


def ensure_eez_fill_table(config: dict[str, Any]) -> str:
    pg = validate_eez_postgis_settings(config)
    source_table = validate_identifier(pg.get("table", "eez_v12"), "postgis EEZ source table")
    fill_table = eez_fill_table_name(pg)
    geom_col = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
    index_name = validate_identifier(f"idx_{fill_table}_{geom_col}_gist", "postgis fill table index")
    with _EEZ_FILL_TABLE_LOCK:
        with psycopg.connect(postgis_dsn(pg), autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass(%s)", (fill_table,))
                if cur.fetchone()[0] is not None:
                    cur.execute(f"SELECT EXISTS (SELECT 1 FROM {fill_table} LIMIT 1)")
                    if bool(cur.fetchone()[0]):
                        return fill_table
                    cur.execute(f"DROP TABLE IF EXISTS {fill_table}")
                cur.execute(
                    f"""
                    CREATE TABLE {fill_table} AS
                    SELECT
                        source.fid,
                        source.mrgid,
                        source.name,
                        source.pol_type,
                        source.territory,
                        source.iso3,
                        source.sovereign,
                        source.area_km2,
                        ST_Multi(
                            ST_CollectionExtract(
                                ST_Transform(source.{geom_col}, 3857),
                                3
                            )
                        )::geometry(MultiPolygon, 3857) AS {geom_col}
                    FROM {source_table} AS source
                    WHERE NOT ST_IsEmpty(source.{geom_col})
                    """
                )
                cur.execute(f"DELETE FROM {fill_table} WHERE ST_IsEmpty({geom_col})")
                cur.execute(f"CREATE INDEX {index_name} ON {fill_table} USING GIST ({geom_col})")
                cur.execute(f"ANALYZE {fill_table}")
    return fill_table


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
    key = tile_cache_key(pg, kind="fill-poltype-v4", source=source, geom_col=geom_col, layer=layer, z=z, x=x, y=y)
    cache_max = eez_tile_cache_max(config)
    cache_path = eez_tile_cache_path(config)
    cached = cache_get(key, cache_max=cache_max, cache_path=cache_path)
    if cached is not None:
        return cached
    if source.geometry_srid == 3857:
        source_geom_select = f"source.{geom_col} AS geom"
        source_geom_filter = f"source.{geom_col} && bounds.geom"
    else:
        source_geom_select = f"ST_Transform(source.{geom_col}, 3857) AS geom"
        source_geom_filter = f"source.{geom_col} && ST_Transform(bounds.geom, 4326)"
    if source.simplify_meters > 0:
        mvt_geom = "ST_Simplify(source_geom.geom, %s)"
        simplify_params: tuple[Any, ...] = (source.simplify_meters,)
    else:
        mvt_geom = "source_geom.geom"
        simplify_params = ()
    sql = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        source_geom AS (
            SELECT
                fid,
                iso3,
                name,
                pol_type,
                sovereign,
                area_km2,
                {source_geom_select}
            FROM {source.table} AS source, bounds
            WHERE {source_geom_filter}
        ),
        clipped AS (
            SELECT
                fid,
                iso3,
                name,
                pol_type,
                sovereign,
                area_km2,
                ST_AsMVTGeom(
                    {mvt_geom},
                    bounds.geom,
                    extent => %s,
                    buffer => %s,
                    clip_geom => true
                ) AS geom
            FROM source_geom, bounds
        ),
        mvtgeom AS (
            SELECT
                fid,
                iso3,
                name,
                pol_type,
                sovereign,
                area_km2,
                ST_Multi(
                    ST_CollectionExtract(
                        ST_Collect(geom),
                        3
                    )
                ) AS geom
            FROM clipped
            WHERE geom IS NOT NULL
            GROUP BY fid, iso3, name, pol_type, sovereign, area_km2
        )
        SELECT ST_AsMVT(mvtgeom.*, %s, %s, 'geom') AS tile
        FROM mvtgeom
    """
    with eez_tile_query_limiter(config):
        with psycopg.connect(postgis_dsn(pg)) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (z, x, y, *simplify_params, source.extent, source.buffer, layer, source.extent))
                tile = cur.fetchone()[0] or b""
    meta = {
        "source": "postgis",
        "format": "mvt",
        "layer": layer,
        "lod": source.lod,
        "cache": "miss",
        "cache_tier": "postgis",
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
    cache_set(key, result, cache_max=cache_max, cache_path=cache_path)
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
    key = tile_cache_key(pg, kind="boundary-poltype-v2", source=source, geom_col=geom_col, layer=layer, z=z, x=x, y=y)
    cache_max = eez_tile_cache_max(config)
    cache_path = eez_tile_cache_path(config)
    cached = cache_get(key, cache_max=cache_max, cache_path=cache_path)
    if cached is not None:
        return cached
    simplify_degrees = geographic_pixel_degrees_for_zoom(z)
    sql = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        source_geom AS (
            SELECT
                fid,
                iso3,
                name,
                pol_type,
                sovereign,
                area_km2,
                ST_Transform(
                    ST_Simplify(source.{geom_col}, %s),
                    3857
                ) AS geom
            FROM {source.table} AS source, bounds
            WHERE source.{geom_col} && ST_Transform(bounds.geom, 4326)
        ),
        mvtgeom AS (
            SELECT
                fid,
                iso3,
                name,
                pol_type,
                sovereign,
                area_km2,
                ST_AsMVTGeom(
                    source_geom.geom,
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
    with eez_tile_query_limiter(config):
        with psycopg.connect(postgis_dsn(pg)) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (z, x, y, simplify_degrees, source.extent, source.buffer, layer, source.extent))
                tile = cur.fetchone()[0] or b""
    meta = {
        "source": "postgis",
        "format": "mvt",
        "layer": layer,
        "lod": source.lod,
        "cache": "miss",
        "cache_tier": "postgis",
        "table": source.table,
        "z": z,
        "x": x,
        "y": y,
        "extent": source.extent,
        "buffer": source.buffer,
        "simplify_meters": source.simplify_meters,
        "simplify_degrees": simplify_degrees,
        "bytes": len(tile),
        "timing": {"tile_ms": elapsed_ms(started)},
    }
    result = bytes(tile), meta
    cache_set(key, result, cache_max=cache_max, cache_path=cache_path)
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
            pol_type,
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
                "pol_type": row[3],
                "sovereign": row[4],
                "area_km2": row[5],
            },
            "geometry": json.loads(row[6]),
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
