from __future__ import annotations

import json
import time
from typing import Any

import psycopg
from psycopg.rows import dict_row

from common_adapter.spatial.lod import validate_eez_postgis_settings
from common_adapter.spatial.overlay import elapsed_ms, postgis_dsn, validate_identifier


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _round_or_none(value: Any, digits: int = 6) -> float | None:
    numeric = _float_or_none(value)
    return round(numeric, digits) if numeric is not None else None


def _json_or_none(value: Any) -> Any | None:
    if not value:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def _validate_lat_lon(lat: float, lon: float) -> tuple[float, float]:
    if not -90 <= lat <= 90:
        raise ValueError("lat must be between -90 and 90")
    if not -180 <= lon <= 180:
        raise ValueError("lon must be between -180 and 180")
    return lat, lon


def _validate_bbox(bbox: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    west, south, east, north = bbox
    if west >= east or south >= north:
        raise ValueError("bbox must have positive width and height")
    if west < -180 or east > 180 or south < -90 or north > 90:
        raise ValueError("bbox is outside WGS84 lon/lat bounds")
    return west, south, east, north


def _base_hit(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "fid": row.get("fid"),
        "mrgid": row.get("mrgid"),
        "name": row.get("name"),
        "pol_type": row.get("pol_type"),
        "territory": row.get("territory"),
        "iso3": row.get("iso3"),
        "sovereign": row.get("sovereign"),
        "area_km2": _round_or_none(row.get("area_km2"), 3),
    }


def _point_hits(pg: dict[str, Any], *, table: str, geom_col: str, lat: float, lon: float, limit: int) -> list[dict[str, Any]]:
    sql = f"""
        WITH target AS (
            SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
        )
        SELECT
            source.fid,
            source.mrgid,
            source.name,
            source.pol_type,
            source.territory,
            source.iso3,
            source.sovereign,
            source.area_km2
        FROM {table} AS source, target
        WHERE source.{geom_col} && target.geom
          AND ST_Covers(source.{geom_col}, target.geom)
        ORDER BY source.area_km2 DESC NULLS LAST, source.fid
        LIMIT %s
    """
    with psycopg.connect(postgis_dsn(pg), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (lon, lat, limit))
            return [_base_hit(row) for row in cur.fetchall()]


def _bbox_hits(
    pg: dict[str, Any],
    *,
    table: str,
    geom_col: str,
    bbox: tuple[float, float, float, float],
    limit: int,
) -> tuple[list[dict[str, Any]], float | None, list[dict[str, Any]]]:
    west, south, east, north = bbox
    sql = f"""
        WITH target AS (
            SELECT ST_MakeEnvelope(%s, %s, %s, %s, 4326) AS geom
        ),
        target_area AS (
            SELECT geom, NULLIF(ST_Area(geom::geography), 0) AS area_m2
            FROM target
        ),
        candidates AS (
            SELECT
                source.fid,
                source.mrgid,
                source.name,
                source.pol_type,
                source.territory,
                source.iso3,
                source.sovereign,
                source.area_km2,
                ST_MakeValid(source.{geom_col}) AS geom,
                target_area.geom AS target_geom,
                target_area.area_m2 AS target_area_m2
            FROM {table} AS source, target_area
            WHERE source.{geom_col} && target_area.geom
        ),
        intersections AS (
            SELECT
                fid,
                mrgid,
                name,
                pol_type,
                territory,
                iso3,
                sovereign,
                area_km2,
                target_area_m2,
                ST_MakeValid(ST_Intersection(geom, target_geom)) AS clipped_geom
            FROM candidates
            WHERE ST_Intersects(geom, target_geom)
        ),
        ranked AS (
            SELECT
                fid,
                mrgid,
                name,
                pol_type,
                territory,
                iso3,
                sovereign,
                area_km2,
                target_area_m2,
                ST_Area(clipped_geom::geography) AS overlap_m2,
                ST_AsGeoJSON(clipped_geom, 6) AS preview_geometry,
                ST_X(ST_PointOnSurface(clipped_geom)) AS label_lon,
                ST_Y(ST_PointOnSurface(clipped_geom)) AS label_lat
            FROM intersections
        )
        SELECT *
        FROM ranked
        WHERE overlap_m2 > 0
        ORDER BY overlap_m2 DESC, fid
        LIMIT %s
    """
    with psycopg.connect(postgis_dsn(pg), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (west, south, east, north, limit))
            rows = cur.fetchall()
    hits: list[dict[str, Any]] = []
    preview_features: list[dict[str, Any]] = []
    target_area_m2 = None
    for row in rows:
        target_area_m2 = _float_or_none(row.get("target_area_m2")) or target_area_m2
        overlap_m2 = _float_or_none(row.get("overlap_m2")) or 0.0
        ratio = overlap_m2 / target_area_m2 if target_area_m2 else None
        ratio_value = _round_or_none(ratio, 6)
        label_lon = _round_or_none(row.get("label_lon"), 6)
        label_lat = _round_or_none(row.get("label_lat"), 6)
        label_point = {"lon": label_lon, "lat": label_lat} if label_lon is not None and label_lat is not None else None
        hits.append(
            {
                **_base_hit(row),
                "overlap_area_km2": round(overlap_m2 / 1_000_000, 6),
                "overlap_ratio": ratio_value,
            }
        )
        geometry = _json_or_none(row.get("preview_geometry"))
        if geometry:
            preview_features.append(
                {
                    "fid": row.get("fid"),
                    "label": row.get("sovereign") or row.get("territory") or row.get("iso3") or row.get("name") or "EEZ",
                    "territory": row.get("territory"),
                    "sovereign": row.get("sovereign"),
                    "iso3": row.get("iso3"),
                    "pol_type": row.get("pol_type"),
                    "overlap_ratio": ratio_value,
                    "label_point": label_point,
                    "geometry": geometry,
                }
            )
    return hits, target_area_m2, preview_features


def eez_attribution_packet(
    config: dict[str, Any],
    *,
    lat: float | None = None,
    lon: float | None = None,
    bbox: tuple[float, float, float, float] | None = None,
    limit: int = 8,
) -> dict[str, Any]:
    pg = validate_eez_postgis_settings(config)
    table = validate_identifier(pg.get("table", "eez_v12"), "PostGIS EEZ attribution table")
    geom_col = validate_identifier(pg.get("geometry_column", "geom"), "PostGIS EEZ geometry column")
    row_limit = max(1, min(int(limit), 25))
    started = time.perf_counter()

    if bbox is not None:
        safe_bbox = _validate_bbox(bbox)
        hits, target_area_m2, preview_features = _bbox_hits(
            pg,
            table=table,
            geom_col=geom_col,
            bbox=safe_bbox,
            limit=row_limit,
        )
        query: dict[str, Any] = {
            "bbox": [round(value, 6) for value in safe_bbox],
            "target_area_km2": round(target_area_m2 / 1_000_000, 6) if target_area_m2 else None,
        }
        preview = {
            "schema": "eez_attribution_tile_preview.v1",
            "bbox": [round(value, 6) for value in safe_bbox],
            "features": preview_features,
        }
        mode = "bbox"
    elif lat is not None and lon is not None:
        safe_lat, safe_lon = _validate_lat_lon(float(lat), float(lon))
        hits = _point_hits(pg, table=table, geom_col=geom_col, lat=safe_lat, lon=safe_lon, limit=row_limit)
        query = {"point": {"lat": round(safe_lat, 6), "lon": round(safe_lon, 6)}}
        preview = None
        mode = "point"
    else:
        raise ValueError("EEZ attribution requires either bbox or lat/lon")

    return {
        "schema": "eez_attribution.v1",
        "source": "postgis",
        "mode": mode,
        "table": table,
        "geometry_column": geom_col,
        "query": query,
        "preview": preview,
        "hit_count": len(hits),
        "attribution": hits,
        "fallback": None if hits else "high_seas_or_no_eez_match",
        "timing": {"query_ms": elapsed_ms(started)},
    }
