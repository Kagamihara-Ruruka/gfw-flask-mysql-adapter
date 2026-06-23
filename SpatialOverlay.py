from __future__ import annotations

import json
import re
import sqlite3
import struct
import time
from pathlib import Path
from typing import Any

import psycopg

ROOT = Path(__file__).resolve().parent
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def validate_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_RE.match(value):
        raise ValueError(f"invalid {label}: {value!r}")
    return value


_EEZ_CACHE: dict[str, Any] | None = None
_EEZ_PACKET_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}


def overlay_settings(config: dict[str, Any]) -> dict[str, Any]:
    overlays = config.get("overlays", {})
    eez = overlays.get("eez", {})
    return {
        "full_geojson_path": eez.get("full_geojson_path"),
        "full_gpkg_path": eez.get("full_gpkg_path"),
        "provider": eez.get("provider", "gpkg"),
        "gpkg_table": eez.get("gpkg_table", "eez_v12"),
        "gpkg_geometry_column": eez.get("gpkg_geometry_column", "geom"),
        "postgis": eez.get("postgis", {}),
        "force_full": bool(eez.get("force_full", False)),
        "enabled": bool(eez.get("enabled", True)),
    }


def postgis_dsn(settings: dict[str, Any]) -> str:
    return (
        f"host={settings['host']} "
        f"port={int(settings['port'])} "
        f"dbname={settings['database']} "
        f"user={settings['user']} "
        f"password={settings['password']}"
    )


def geometry_bbox(geometry: dict[str, Any]) -> tuple[float, float, float, float]:
    stack = [geometry.get("coordinates", [])]
    west = south = float("inf")
    east = north = float("-inf")
    while stack:
        item = stack.pop()
        if not item:
            continue
        if isinstance(item, list) and item and isinstance(item[0], (int, float)):
            lon = float(item[0])
            lat = float(item[1])
            west = min(west, lon)
            east = max(east, lon)
            south = min(south, lat)
            north = max(north, lat)
        elif isinstance(item, list):
            stack.extend(item)
    if west == float("inf"):
        raise ValueError("geometry has no coordinates")
    return west, south, east, north


def bbox_intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    west_a, south_a, east_a, north_a = a
    west_b, south_b, east_b, north_b = b
    return not (east_a < west_b or west_a > east_b or north_a < south_b or south_a > north_b)


def simplify_tolerance_for_zoom(zoom: float | None) -> float:
    if zoom is None:
        return 0.35
    if zoom <= 3:
        return 0.8
    if zoom <= 5:
        return 0.35
    if zoom <= 7:
        return 0.02
    if zoom <= 9:
        return 0.005
    return 0.0


def bbox_area_degrees(bbox: tuple[float, float, float, float] | None) -> float:
    if bbox is None:
        return 360.0 * 180.0
    west, south, east, north = bbox
    return max(0.0, east - west) * max(0.0, north - south)


def eez_detail_for_zoom(
    zoom: float | None,
    bbox: tuple[float, float, float, float] | None,
    *,
    force_full: bool,
) -> str:
    if force_full:
        return "full"
    area = bbox_area_degrees(bbox)
    if zoom is not None and zoom >= 6 and area <= 700:
        return "full"
    if zoom is not None and zoom >= 8 and area <= 2000:
        return "full"
    if zoom is None or zoom <= 9:
        return "simplified"
    return "full"


def max_ring_points_for_zoom(zoom: float | None) -> int | None:
    if zoom is None:
        return 48
    if zoom <= 3:
        return 32
    if zoom <= 5:
        return 64
    if zoom <= 7:
        return 320
    if zoom <= 9:
        return 900
    return None


def rounded_bbox_for_cache(
    bbox: tuple[float, float, float, float] | None,
    *,
    detail: str,
) -> tuple[float, float, float, float] | None:
    if bbox is None:
        return None
    granularity = 0.25 if detail == "simplified" else 0.05
    return tuple(round(value / granularity) * granularity for value in bbox)


def packet_cache_get(key: tuple[Any, ...]) -> dict[str, Any] | None:
    packet = _EEZ_PACKET_CACHE.get(key)
    if not packet:
        return None
    result = dict(packet)
    result["timing"] = dict(packet.get("timing", {}))
    result["timing"]["cache_hit"] = True
    return result


def packet_cache_put(key: tuple[Any, ...], packet: dict[str, Any]) -> None:
    limit = 2 if packet.get("detail") == "full" else 16
    while len(_EEZ_PACKET_CACHE) >= limit:
        _EEZ_PACKET_CACHE.pop(next(iter(_EEZ_PACKET_CACHE)))
    _EEZ_PACKET_CACHE[key] = packet


def perpendicular_distance(point: list[float], start: list[float], end: list[float]) -> float:
    x, y = point
    x1, y1 = start
    x2, y2 = end
    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    return abs(dy * x - dx * y + x2 * y1 - y2 * x1) / (dx * dx + dy * dy) ** 0.5


def rdp_simplify(points: list[list[float]], tolerance: float) -> list[list[float]]:
    if tolerance <= 0 or len(points) <= 3:
        return points
    closed = points[0] == points[-1]
    work = points[:-1] if closed else points
    if len(work) <= 3:
        return points

    def recurse(segment: list[list[float]]) -> list[list[float]]:
        if len(segment) <= 2:
            return segment
        start = segment[0]
        end = segment[-1]
        max_distance = -1.0
        split_index = 0
        for idx in range(1, len(segment) - 1):
            distance = perpendicular_distance(segment[idx], start, end)
            if distance > max_distance:
                max_distance = distance
                split_index = idx
        if max_distance > tolerance:
            left = recurse(segment[: split_index + 1])
            right = recurse(segment[split_index:])
            return left[:-1] + right
        return [start, end]

    simplified = recurse(work)
    if closed and simplified[0] != simplified[-1]:
        simplified.append(simplified[0])
    if closed and len(simplified) < 4:
        return points
    return simplified


def cap_ring_points(points: list[list[float]], max_points: int | None) -> list[list[float]]:
    if not max_points or len(points) <= max_points:
        return points
    closed = points[0] == points[-1]
    work = points[:-1] if closed else points
    if len(work) <= max_points:
        return points
    stride = max(1, (len(work) + max_points - 1) // max_points)
    capped = work[::stride]
    if work[-1] not in capped:
        capped.append(work[-1])
    if closed and capped[0] != capped[-1]:
        capped.append(capped[0])
    if closed and len(capped) < 4:
        return points
    return capped


def exterior_only_for_zoom(zoom: float | None) -> bool:
    return zoom is None or zoom <= 5


def simplify_geometry(
    geometry: dict[str, Any],
    tolerance: float,
    max_points: int | None,
    *,
    exterior_only: bool,
) -> dict[str, Any]:
    if tolerance <= 0 and not max_points:
        return geometry
    def simplify_ring(ring: list[list[float]]) -> list[list[float]]:
        return cap_ring_points(rdp_simplify(ring, tolerance), max_points)

    if geometry["type"] == "Polygon":
        rings = geometry["coordinates"][:1] if exterior_only else geometry["coordinates"]
        return {
            "type": "Polygon",
            "coordinates": [simplify_ring(ring) for ring in rings],
        }
    if geometry["type"] == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [
                [simplify_ring(ring) for ring in (polygon[:1] if exterior_only else polygon)]
                for polygon in geometry["coordinates"]
            ],
        }
    return geometry


def load_eez_cache(config: dict[str, Any]) -> dict[str, Any]:
    global _EEZ_CACHE
    settings = overlay_settings(config)
    source = settings.get("full_geojson_path")
    if not settings["enabled"] or not source:
        raise ValueError("EEZ overlay is not configured")
    source_path = Path(source)
    if not source_path.is_absolute():
        source_path = ROOT / source_path
    if _EEZ_CACHE and _EEZ_CACHE.get("source") == str(source_path):
        return _EEZ_CACHE

    started = time.perf_counter()
    data = json.loads(source_path.read_text(encoding="utf-8"))
    entries = []
    for index, feature in enumerate(data.get("features", [])):
        bbox = geometry_bbox(feature["geometry"])
        entries.append({"index": index, "bbox": bbox, "feature": feature})
    _EEZ_CACHE = {
        "source": str(source_path),
        "source_bytes": source_path.stat().st_size,
        "features": entries,
        "load_ms": elapsed_ms(started),
    }
    return _EEZ_CACHE


def gpkg_wkb_offset(blob: bytes) -> int:
    if len(blob) < 8 or blob[:2] != b"GP":
        raise ValueError("unsupported GPKG geometry header")
    flags = blob[3]
    envelope_code = (flags >> 1) & 0b111
    envelope_bytes = {
        0: 0,
        1: 32,
        2: 48,
        3: 48,
        4: 64,
    }.get(envelope_code)
    if envelope_bytes is None:
        raise ValueError(f"unsupported GPKG envelope code: {envelope_code}")
    return 8 + envelope_bytes


def normalized_wkb_type(raw_type: int) -> int:
    # GPKG may store ISO WKB type codes with Z/M offsets. This app only
    # renders lon/lat, so the geometry family is enough.
    for offset in (3000, 2000, 1000):
        if raw_type >= offset:
            raw_type -= offset
    return raw_type


def parse_wkb_geometry(wkb: bytes) -> dict[str, Any]:
    offset = 0

    def read_byte() -> int:
        nonlocal offset
        value = wkb[offset]
        offset += 1
        return value

    def read_u32(endian: str) -> int:
        nonlocal offset
        value = struct.unpack_from(f"{endian}I", wkb, offset)[0]
        offset += 4
        return value

    def read_point(endian: str) -> list[float]:
        nonlocal offset
        x, y = struct.unpack_from(f"{endian}dd", wkb, offset)
        offset += 16
        return [x, y]

    def read_header() -> tuple[str, int]:
        endian = "<" if read_byte() == 1 else ">"
        return endian, normalized_wkb_type(read_u32(endian))

    def read_polygon_body(endian: str) -> list[list[list[float]]]:
        ring_count = read_u32(endian)
        rings = []
        for _ in range(ring_count):
            point_count = read_u32(endian)
            rings.append([read_point(endian) for _ in range(point_count)])
        return rings

    endian, geometry_type = read_header()
    if geometry_type == 3:
        return {"type": "Polygon", "coordinates": read_polygon_body(endian)}
    if geometry_type == 6:
        polygon_count = read_u32(endian)
        polygons = []
        for _ in range(polygon_count):
            child_endian, child_type = read_header()
            if child_type != 3:
                raise ValueError(f"unsupported child WKB geometry type: {child_type}")
            polygons.append(read_polygon_body(child_endian))
        return {"type": "MultiPolygon", "coordinates": polygons}
    raise ValueError(f"unsupported WKB geometry type: {geometry_type}")


def gpkg_geometry_to_geojson(blob: bytes) -> dict[str, Any]:
    return parse_wkb_geometry(blob[gpkg_wkb_offset(blob):])


def validate_gpkg_identifier(value: str, label: str) -> str:
    return validate_identifier(value, label)


def eez_overlay_packet_from_gpkg(
    config: dict[str, Any],
    *,
    bbox: tuple[float, float, float, float] | None,
    zoom: float | None,
) -> dict[str, Any]:
    started = time.perf_counter()
    settings = overlay_settings(config)
    source = settings.get("full_gpkg_path")
    if not settings["enabled"] or not source:
        raise ValueError("EEZ GPKG overlay is not configured")
    source_path = Path(source)
    if not source_path.is_absolute():
        source_path = ROOT / source_path
    table = validate_gpkg_identifier(settings["gpkg_table"], "gpkg table")
    geom_col = validate_gpkg_identifier(settings["gpkg_geometry_column"], "gpkg geometry column")
    rtree = validate_gpkg_identifier(f"rtree_{table}_{geom_col}", "gpkg rtree table")
    detail = eez_detail_for_zoom(zoom, bbox, force_full=settings["force_full"])
    tolerance = simplify_tolerance_for_zoom(zoom)
    max_points = max_ring_points_for_zoom(zoom)
    exterior_only = exterior_only_for_zoom(zoom)
    cache_key = (
        str(source_path),
        detail,
        rounded_bbox_for_cache(bbox, detail=detail),
        round(zoom, 1) if zoom is not None else None,
    )
    cached = packet_cache_get(cache_key)
    if cached:
        return cached

    geom_select = f"t.{geom_col} AS geom,"

    where_sql = ""
    params: list[float] = []
    if bbox is not None:
        west, south, east, north = bbox
        where_sql = "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?"
        params = [west, east, south, north]

    rows_start = time.perf_counter()
    with sqlite3.connect(str(source_path)) as conn:
        conn.row_factory = sqlite3.Row
        total_feature_count = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
        rows = conn.execute(
            f"""
            SELECT
                t.fid,
                {geom_select}
                t.MRGID,
                t.GEONAME,
                t.POL_TYPE,
                t.TERRITORY1,
                t.ISO_TER1,
                t.SOVEREIGN1,
                t.ISO_SOV1,
                t.AREA_KM2,
                r.minx,
                r.maxx,
                r.miny,
                r.maxy
            FROM {table} AS t
            JOIN {rtree} AS r ON t.fid = r.id
            {where_sql}
            ORDER BY t.fid
            """,
            params,
        ).fetchall()
    rows_ms = elapsed_ms(rows_start)

    geometry_start = time.perf_counter()
    features = []
    for row in rows:
        geometry = gpkg_geometry_to_geojson(row["geom"])
        geometry = simplify_geometry(
            geometry,
            tolerance,
            max_points,
            exterior_only=exterior_only,
        )
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "fid": row["fid"],
                    "mrgid": row["MRGID"],
                    "name": row["GEONAME"],
                    "pol_type": row["POL_TYPE"],
                    "territory": row["TERRITORY1"],
                    "iso3": row["ISO_SOV1"] or row["ISO_TER1"],
                    "sovereign": row["SOVEREIGN1"],
                    "area_km2": row["AREA_KM2"],
                },
                "geometry": geometry,
            }
        )
    packet = {
        "type": "FeatureCollection",
        "features": features,
        "source": "eez_v12.gpkg",
        "detail": detail,
        "simplify_tolerance": tolerance,
        "max_ring_points": max_points,
        "exterior_only": exterior_only,
        "source_bytes": source_path.stat().st_size,
        "feature_count": len(features),
        "total_feature_count": int(total_feature_count),
        "timing": {
            "rtree_query_ms": rows_ms,
            "geometry_decode_ms": elapsed_ms(geometry_start),
            "filter_total_ms": elapsed_ms(started),
            "cache_hit": False,
        },
    }
    packet_cache_put(cache_key, packet)
    return packet


def eez_overlay_packet(
    config: dict[str, Any],
    *,
    bbox: tuple[float, float, float, float] | None,
    zoom: float | None = None,
) -> dict[str, Any]:
    settings = overlay_settings(config)
    if settings.get("full_gpkg_path"):
        return eez_overlay_packet_from_gpkg(config, bbox=bbox, zoom=zoom)

    started = time.perf_counter()
    cache = load_eez_cache(config)
    features = []
    for entry in cache["features"]:
        if bbox is None or bbox_intersects(entry["bbox"], bbox):
            features.append(entry["feature"])
    return {
        "type": "FeatureCollection",
        "features": features,
        "source": "configured_geojson",
        "source_bytes": cache["source_bytes"],
        "feature_count": len(features),
        "total_feature_count": len(cache["features"]),
        "timing": {
            "cache_load_ms": cache["load_ms"],
            "filter_total_ms": elapsed_ms(started),
        },
    }


def eez_tile_packet(
    config: dict[str, Any],
    *,
    z: int,
    x: int,
    y: int,
) -> tuple[bytes, dict[str, Any]]:
    settings = overlay_settings(config)
    if not settings["enabled"]:
        raise ValueError("EEZ overlay is disabled")
    if settings.get("provider") != "postgis":
        raise ValueError("EEZ vector tiles require overlays.eez.provider=postgis")
    pg = settings.get("postgis") or {}
    if z <= 3 and pg.get("tile_low_table"):
        configured_table = pg["tile_low_table"]
        lod = "low"
    elif z <= 5 and pg.get("tile_mid_table"):
        configured_table = pg["tile_mid_table"]
        lod = "mid"
    else:
        configured_table = pg.get("tile_table") or pg.get("table", "eez_v12")
        lod = "full" if z > 5 else "full_fallback"
    table = validate_identifier(configured_table, "postgis table")
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
            FROM {table} AS source, bounds
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
        "layer": layer,
        "lod": lod,
        "table": table,
        "z": z,
        "x": x,
        "y": y,
        "bytes": len(tile),
        "timing": {"tile_ms": elapsed_ms(started)},
    }
    return bytes(tile), meta
