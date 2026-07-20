from __future__ import annotations

import hashlib
import json
import math
import os
import time
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import BoundedSemaphore, Event, RLock
from typing import Any, Callable, Iterable, Iterator, Sequence

import psycopg
from shapely import from_wkb, make_valid, to_wkb
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from common_adapter.spatial.lod import (
    eez_lod_source,
    validate_eez_postgis_settings,
)
from common_adapter.spatial.overlay import postgis_dsn, validate_identifier


ROOT = Path(__file__).resolve().parents[2]
EEZ_DOMAIN_ARTIFACT_VERSION = "rrkal.eez_domain.v1"
DEFAULT_TILE_SIZE = 256
DEFAULT_TILE_BLEED_PIXELS = 2
DEFAULT_DOMAIN_TILE_QUERY_CONCURRENCY = 2
DEFAULT_TOPOLOGY_PRECISION_DEGREES = 0.025
DEFAULT_TOPOLOGY_PARTITION_DEGREES = 30.0
DEFAULT_ARTIFACT_LOCK_TIMEOUT_SECONDS = 600.0
DEFAULT_ARTIFACT_LOCK_STALE_SECONDS = 1800.0
LOD_GEOMETRY_MODE = "eez_lod"

# Marine Regions High Seas v2 is paired with Maritime Boundaries v12. These
# point-on-surface labels identify complement components; they are not stored
# geometry and never replace the locally scouted EEZ source geometry.
HIGH_SEAS_SEEDS_BY_EEZ_VERSION: dict[str, tuple[tuple[int, float, float], ...]] = {
    "v12_20231025": (
        (1, -143.130163087884, -24.340908795),
        (2, -158.38919006262918, -13.611980975000002),
        (3, -108.34762681547485, -11.121150185000001),
        (4, 134.63634165655782, 15.16983353),
        (5, -92.46966885282123, 25.48992123),
        (6, -87.32512093267681, 25.72394901),
        (7, 136.065628119183, 26.71925247),
        (8, -178.272461875, 57.145580089999996),
        (9, 4.361041209362859, 70.70646757),
        (10, 38.85919582380478, 74.53080564),
        (11, 149.5792330825, 81.50648534),
        (12, 172.7706331132025, -49.512897285),
        (13, 178.25055552151434, -44.31290124),
        (14, 175.00757283019928, -28.546739244999998),
        (15, 172.82157481812163, -15.560527575),
        (16, 167.92949514110137, -4.329404855),
        (17, 179.9720256925, -3.914394445),
        (18, 143.95680451058757, 3.114331355),
        (19, 168.78573101832393, 24.968400414999998),
        (20, 149.6305088155036, 53.236945954999996),
        (21, 176.96288806249999, 57.176479470000004),
    ),
}


def _polygon_parts(geometry: BaseGeometry) -> Iterator[Polygon]:
    if geometry.is_empty:
        return
    if isinstance(geometry, Polygon):
        yield geometry
        return
    if isinstance(geometry, (MultiPolygon, GeometryCollection)):
        for child in geometry.geoms:
            yield from _polygon_parts(child)


def _multi_polygon(geometries: Iterable[BaseGeometry]) -> MultiPolygon:
    return MultiPolygon(tuple(part for geometry in geometries for part in _polygon_parts(geometry)))


def _valid_geometry(geometry: BaseGeometry) -> BaseGeometry:
    if geometry.is_empty or geometry.is_valid:
        return geometry
    return make_valid(geometry)


def _valid_polygonal(geometry: BaseGeometry) -> MultiPolygon:
    return _multi_polygon((_valid_geometry(geometry),))


def _safe_polygon_intersection(left: BaseGeometry, right: BaseGeometry) -> MultiPolygon:
    return _valid_polygonal(
        _valid_polygonal(left).intersection(_valid_polygonal(right))
    )


def _safe_polygon_difference(left: BaseGeometry, right: BaseGeometry) -> MultiPolygon:
    return _valid_polygonal(
        _valid_polygonal(left).difference(_valid_polygonal(right))
    )


def classify_local_complement_components(
    complement: BaseGeometry,
    high_seas_geometries: Iterable[BaseGeometry],
) -> tuple[tuple[Polygon, ...], tuple[Polygon, ...]]:
    """Classify complete local components without cutting across precision domains."""
    candidates = tuple(_polygon_parts(_multi_polygon(high_seas_geometries)))
    tree = STRtree(candidates) if candidates else None
    land: list[Polygon] = []
    high_seas: list[Polygon] = []
    for component in _polygon_parts(_valid_polygonal(complement)):
        if component.is_empty or component.area <= 0:
            continue
        indices = tuple(tree.query(component, predicate="intersects")) if tree is not None else ()
        overlap = sum(
            _safe_polygon_intersection(candidates[int(index)], component).area
            for index in indices
        )
        representative = component.representative_point()
        is_high_seas = any(
            candidates[int(index)].covers(representative)
            for index in indices
        ) or overlap >= component.area * 0.5
        (high_seas if is_high_seas else land).append(component)
    return tuple(land), tuple(high_seas)


def classify_complement_components(
    components: Sequence[Polygon],
    seeds: Sequence[tuple[int, float, float]],
) -> tuple[tuple[Polygon, ...], tuple[Polygon, ...]]:
    """Classify EEZ complement components from versioned semantic seed labels."""
    if not components:
        raise ValueError("EEZ complement produced no polygon components")
    if not seeds:
        raise ValueError("EEZ source version has no High Seas seed mapping")
    tree = STRtree(components)
    high_seas_indices: set[int] = set()
    for seed_id, longitude, latitude in seeds:
        point = Point(float(longitude), float(latitude))
        matches = [
            int(index)
            for index in tree.query(point)
            if components[int(index)].covers(point)
        ]
        if len(matches) != 1:
            raise ValueError(
                f"High Seas seed {seed_id} matched {len(matches)} EEZ complement components"
            )
        high_seas_indices.add(matches[0])
    if len(high_seas_indices) != len(seeds):
        raise ValueError("High Seas seeds do not identify unique complement components")
    high_seas = tuple(components[index] for index in sorted(high_seas_indices))
    land = tuple(
        component
        for index, component in enumerate(components)
        if index not in high_seas_indices
    )
    if not land:
        raise ValueError("EEZ complement classification produced no land components")
    return land, high_seas


def xyz_geographic_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    scale = 2 ** int(z)
    west = (float(x) / scale) * 360.0 - 180.0
    east = (float(x + 1) / scale) * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - (2.0 * y / scale)))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - (2.0 * (y + 1) / scale)))))
    return west, south, east, north


def xyz_geographic_bleed_bounds(
    z: int,
    x: int,
    y: int,
    *,
    size: int = DEFAULT_TILE_SIZE,
    bleed_pixels: int = DEFAULT_TILE_BLEED_PIXELS,
) -> tuple[float, float, float, float]:
    scale = 2 ** int(z)
    bleed = max(0.0, float(bleed_pixels)) / max(1.0, float(size))
    west = ((float(x) - bleed) / scale) * 360.0 - 180.0
    east = ((float(x + 1) + bleed) / scale) * 360.0 - 180.0
    north_y = float(y) - bleed
    south_y = float(y + 1) + bleed
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - (2.0 * north_y / scale)))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - (2.0 * south_y / scale)))))
    return west, south, east, north


def _tile_pixel(longitude: float, latitude: float, z: int, x: int, y: int, size: int) -> tuple[float, float]:
    scale = (2 ** int(z)) * size
    px = ((float(longitude) + 180.0) / 360.0) * scale - (x * size)
    clamped_latitude = max(-85.05112878, min(85.05112878, float(latitude)))
    sine = math.sin(math.radians(clamped_latitude))
    py = (0.5 - math.log((1.0 + sine) / (1.0 - sine)) / (4.0 * math.pi)) * scale - (y * size)
    return px, py


def _ring_path(coordinates: Iterable[tuple[float, float]], z: int, x: int, y: int, size: int) -> str:
    points = [_tile_pixel(longitude, latitude, z, x, y, size) for longitude, latitude in coordinates]
    if len(points) < 3:
        return ""
    commands = [f"M{points[0][0]:.2f},{points[0][1]:.2f}"]
    commands.extend(f"L{px:.2f},{py:.2f}" for px, py in points[1:])
    commands.append("Z")
    return "".join(commands)


def _polygon_path(polygon: Polygon, z: int, x: int, y: int, size: int) -> str:
    paths = [_ring_path(polygon.exterior.coords, z, x, y, size)]
    paths.extend(_ring_path(ring.coords, z, x, y, size) for ring in polygon.interiors)
    return "".join(path for path in paths if path)


@dataclass(frozen=True)
class EezDomainTopologyArtifact:
    source_version: str
    precision_degrees: float
    high_seas: tuple[Polygon, ...]
    compiled_ms: float
    provenance_digest: str


@dataclass(frozen=True)
class EezLodOceanTile:
    geometry: BaseGeometry
    source_table: str
    lod: str
    simplify_meters: float
    query_ms: float


@dataclass(frozen=True)
class EezDomainTile:
    land: tuple[Polygon, ...]
    high_seas: tuple[Polygon, ...]
    source_table: str
    lod: str
    simplify_meters: float
    query_ms: float


class EezDomainMaskService:
    """Owns the EEZ-derived land/high-seas artifact and immutable tile views."""

    def __init__(
        self,
        config: dict[str, Any],
        *,
        component_loader: Callable[[], Sequence[Polygon]] | None = None,
        lod_ocean_loader: Callable[[int, int, int], EezLodOceanTile | BaseGeometry] | None = None,
    ) -> None:
        self.config = config
        self.settings = self._settings(config)
        self.source_version = str(self.settings.get("source_version") or "").strip()
        self.topology_precision_degrees = max(
            1e-6,
            float(
                self.settings.get("topology_precision_degrees")
                or DEFAULT_TOPOLOGY_PRECISION_DEGREES
            ),
        )
        self.topology_partition_degrees = max(
            1.0,
            min(
                90.0,
                float(
                    self.settings.get("topology_partition_degrees")
                    or DEFAULT_TOPOLOGY_PARTITION_DEGREES
                ),
            ),
        )
        self.cache_path = self._cache_path(self.settings.get("cache_path"))
        try:
            tile_query_concurrency = int(
                self.settings.get("tile_query_concurrency")
                or DEFAULT_DOMAIN_TILE_QUERY_CONCURRENCY
            )
        except (TypeError, ValueError):
            tile_query_concurrency = DEFAULT_DOMAIN_TILE_QUERY_CONCURRENCY
        self.domain_tile_query_concurrency = max(1, tile_query_concurrency)
        self._tile_query_limiter = BoundedSemaphore(self.domain_tile_query_concurrency)
        self.high_seas_tile_query_concurrency = max(
            1,
            self.domain_tile_query_concurrency - 1,
        )
        self._high_seas_tile_query_limiter = BoundedSemaphore(
            self.high_seas_tile_query_concurrency
        )
        self.component_loader = component_loader or self._load_complement_components
        self.lod_ocean_loader = lod_ocean_loader or self._load_lod_ocean_tile
        self._artifact: EezDomainTopologyArtifact | None = None
        self._lock = RLock()
        self._high_seas_tree: STRtree | None = None
        self._domain_tile_lock = RLock()
        self._domain_tile_cache: OrderedDict[tuple[int, int, int], EezDomainTile] = OrderedDict()
        self._domain_tile_inflight: dict[tuple[int, int, int], dict[str, Any]] = {}
        self._domain_tile_cache_max_entries = 2048

    @staticmethod
    def _settings(config: dict[str, Any]) -> dict[str, Any]:
        eez = (config.get("overlays") or {}).get("eez") or {}
        domain = eez.get("domain_mask") if isinstance(eez.get("domain_mask"), dict) else {}
        source = eez.get("source") if isinstance(eez.get("source"), dict) else {}
        return {
            "enabled": bool(eez.get("enabled", True) and domain.get("enabled", True)),
            "provider": str(eez.get("provider") or ""),
            "source_version": str(source.get("version") or ""),
            "cache_path": domain.get("cache_path", "data/eez/derived-domain-cache"),
            "topology_precision_degrees": domain.get(
                "topology_precision_degrees",
                DEFAULT_TOPOLOGY_PRECISION_DEGREES,
            ),
            "topology_partition_degrees": domain.get(
                "topology_partition_degrees",
                DEFAULT_TOPOLOGY_PARTITION_DEGREES,
            ),
            "prepare_on_startup": bool(domain.get("prepare_on_startup", True)),
            "tile_query_concurrency": domain.get(
                "tile_query_concurrency",
                DEFAULT_DOMAIN_TILE_QUERY_CONCURRENCY,
            ),
            "artifact_lock_timeout_seconds": domain.get(
                "artifact_lock_timeout_seconds",
                DEFAULT_ARTIFACT_LOCK_TIMEOUT_SECONDS,
            ),
            "artifact_lock_stale_seconds": domain.get(
                "artifact_lock_stale_seconds",
                DEFAULT_ARTIFACT_LOCK_STALE_SECONDS,
            ),
            "postgis": eez.get("postgis") or {},
        }

    @staticmethod
    def _cache_path(value: Any) -> Path:
        path = Path(str(value or "data/eez/derived-domain-cache"))
        return (path if path.is_absolute() else ROOT / path).resolve()

    @property
    def enabled(self) -> bool:
        return bool(self.settings.get("enabled") and self.settings.get("provider") == "postgis")

    def _seed_rows(self) -> tuple[tuple[int, float, float], ...]:
        seeds = HIGH_SEAS_SEEDS_BY_EEZ_VERSION.get(self.source_version)
        if seeds is None:
            raise ValueError(f"unsupported EEZ source version for land mask: {self.source_version or 'unknown'}")
        return seeds

    def _artifact_prefix(self) -> str:
        precision = str(self.topology_precision_degrees).replace(".", "_")
        return f"eez-domain-{self.source_version}-p{precision}"

    def _artifact_paths(self) -> tuple[Path, Path]:
        prefix = self._artifact_prefix()
        return (
            self.cache_path / f"{prefix}.json",
            self.cache_path / f"{prefix}.high-seas.wkb",
        )

    def _provenance_digest(self) -> str:
        payload = json.dumps(
            {
                "artifact_version": EEZ_DOMAIN_ARTIFACT_VERSION,
                "source_version": self.source_version,
                "precision_degrees": self.topology_precision_degrees,
                "high_seas_seeds": self._seed_rows(),
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def _load_cached_artifact(self) -> EezDomainTopologyArtifact | None:
        metadata_path, high_seas_path = self._artifact_paths()
        if not all(path.exists() for path in (metadata_path, high_seas_path)):
            return None
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            digest = self._provenance_digest()
            if metadata.get("artifact_version") != EEZ_DOMAIN_ARTIFACT_VERSION:
                return None
            if metadata.get("provenance_digest") != digest:
                return None
            high_seas = tuple(_polygon_parts(from_wkb(high_seas_path.read_bytes())))
            if len(high_seas) != len(self._seed_rows()):
                return None
            return EezDomainTopologyArtifact(
                source_version=self.source_version,
                precision_degrees=self.topology_precision_degrees,
                high_seas=high_seas,
                compiled_ms=float(metadata.get("compiled_ms") or 0.0),
                provenance_digest=digest,
            )
        except (OSError, ValueError, TypeError):
            return None

    @staticmethod
    def _atomic_write(path: Path, payload: bytes) -> None:
        temporary = path.with_name(
            f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            temporary.write_bytes(payload)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    @contextmanager
    def _artifact_file_lock(self) -> Iterator[None]:
        self.cache_path.mkdir(parents=True, exist_ok=True)
        lock_path = self.cache_path / f"{self._artifact_prefix()}.lock"
        timeout_seconds = max(
            1.0,
            float(
                self.settings.get("artifact_lock_timeout_seconds")
                or DEFAULT_ARTIFACT_LOCK_TIMEOUT_SECONDS
            ),
        )
        stale_seconds = max(
            timeout_seconds,
            float(
                self.settings.get("artifact_lock_stale_seconds")
                or DEFAULT_ARTIFACT_LOCK_STALE_SECONDS
            ),
        )
        token = f"{os.getpid()}:{uuid.uuid4().hex}"
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                descriptor = os.open(
                    lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                )
            except FileExistsError:
                try:
                    age_seconds = max(0.0, time.time() - lock_path.stat().st_mtime)
                    if age_seconds > stale_seconds:
                        lock_path.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timed out waiting for EEZ artifact lock: {lock_path}")
                time.sleep(0.1)
                continue
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(token)
            break
        try:
            yield
        finally:
            try:
                if lock_path.read_text(encoding="utf-8") == token:
                    lock_path.unlink(missing_ok=True)
            except FileNotFoundError:
                pass

    def _persist_artifact(self, artifact: EezDomainTopologyArtifact) -> None:
        metadata_path, high_seas_path = self._artifact_paths()
        self.cache_path.mkdir(parents=True, exist_ok=True)
        self._atomic_write(high_seas_path, bytes(to_wkb(_multi_polygon(artifact.high_seas))))
        metadata = {
            "artifact_version": EEZ_DOMAIN_ARTIFACT_VERSION,
            "source_version": artifact.source_version,
            "precision_degrees": artifact.precision_degrees,
            "high_seas_components": len(artifact.high_seas),
            "compiled_ms": artifact.compiled_ms,
            "provenance_digest": artifact.provenance_digest,
        }
        self._atomic_write(
            metadata_path,
            json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"),
        )

    def _load_complement_components(self) -> Sequence[Polygon]:
        if not self.enabled:
            raise ValueError("EEZ land-mask capability is disabled")
        pg = self.settings.get("postgis") or {}
        source_table = validate_identifier(pg.get("table", "eez_v12"), "postgis EEZ source table")
        geom_col = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
        sql = f"""
            WITH valid AS MATERIALIZED (
                SELECT ST_ReducePrecision(
                    ST_CollectionExtract(ST_MakeValid(source.{geom_col}), 3),
                    %s
                ) AS geom
                FROM {source_table} AS source
                WHERE NOT ST_IsEmpty(source.{geom_col})
            ),
            partitioned AS MATERIALIZED (
                SELECT
                    FLOOR((ST_X(ST_PointOnSurface(geom)) + 180.0) / %s)::integer AS bucket_x,
                    FLOOR((ST_Y(ST_PointOnSurface(geom)) + 90.0) / %s)::integer AS bucket_y,
                    ST_UnaryUnion(ST_Collect(geom)) AS geom
                FROM valid
                WHERE NOT ST_IsEmpty(geom)
                GROUP BY bucket_x, bucket_y
            ),
            dissolved AS MATERIALIZED (
                SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom
                FROM partitioned
                WHERE NOT ST_IsEmpty(geom)
            ),
            complement AS MATERIALIZED (
                SELECT ST_Difference(
                    ST_MakeEnvelope(-180, -90, 180, 90, 4326),
                    geom
                ) AS geom
                FROM dissolved
            )
            SELECT ST_AsBinary((ST_Dump(ST_CollectionExtract(geom, 3))).geom)
            FROM complement
        """
        with psycopg.connect(postgis_dsn(pg)) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    sql,
                    (
                        self.topology_precision_degrees,
                        self.topology_partition_degrees,
                        self.topology_partition_degrees,
                    ),
                )
                return tuple(
                    part
                    for row in cursor.fetchall()
                    for part in _polygon_parts(from_wkb(bytes(row[0])))
                )

    def artifact(self) -> EezDomainTopologyArtifact:
        if self._artifact is not None:
            return self._artifact
        with self._lock:
            if self._artifact is not None:
                return self._artifact
            cached = self._load_cached_artifact()
            if cached is not None:
                self._artifact = cached
                return cached
            with self._artifact_file_lock():
                cached = self._load_cached_artifact()
                if cached is not None:
                    self._artifact = cached
                    return cached
                started = time.perf_counter()
                components = tuple(self.component_loader())
                _land, high_seas = classify_complement_components(components, self._seed_rows())
                artifact = EezDomainTopologyArtifact(
                    source_version=self.source_version,
                    precision_degrees=self.topology_precision_degrees,
                    high_seas=high_seas,
                    compiled_ms=round((time.perf_counter() - started) * 1000.0, 3),
                    provenance_digest=self._provenance_digest(),
                )
                self._persist_artifact(artifact)
                self._artifact = artifact
                return artifact

    @property
    def prepare_on_startup(self) -> bool:
        return bool(self.settings.get("prepare_on_startup", True))

    def prepare(self) -> EezDomainTopologyArtifact | None:
        return self.artifact() if self.enabled else None

    def _tree(self) -> STRtree:
        with self._lock:
            if self._high_seas_tree is None:
                self._high_seas_tree = STRtree(self.artifact().high_seas)
            return self._high_seas_tree

    def _high_seas_intersection_area(self, target: BaseGeometry) -> float:
        geometries = self.artifact().high_seas
        tree = self._tree()
        valid_target = _valid_polygonal(target)
        return sum(
            _safe_polygon_intersection(geometries[int(index)], valid_target).area
            for index in tree.query(valid_target, predicate="intersects")
        )

    def _high_seas_covers(self, target: BaseGeometry) -> bool:
        geometries = self.artifact().high_seas
        tree = self._tree()
        valid_target = _valid_geometry(target)
        return any(
            geometries[int(index)].covers(valid_target)
            for index in tree.query(valid_target)
        )

    @contextmanager
    def _tile_query_slot(self, request_kind: str) -> Iterator[None]:
        if request_kind == "high_seas" and self.domain_tile_query_concurrency > 1:
            with self._high_seas_tile_query_limiter:
                with self._tile_query_limiter:
                    yield
            return
        with self._tile_query_limiter:
            yield

    def _load_lod_ocean_tile(
        self,
        z: int,
        x: int,
        y: int,
        request_kind: str = "land",
    ) -> EezLodOceanTile:
        pg = validate_eez_postgis_settings(self.config)
        source = eez_lod_source(self.config, z)
        geom_col = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
        source_table = validate_identifier(source.table, "postgis EEZ LOD source table")
        if source.geometry_srid == 3857:
            source_bounds_select = "geom AS source_geom"
            source_filter = f"source.{geom_col} && bounds.source_geom"
            source_geom_select = f"source.{geom_col} AS geom"
        else:
            source_bounds_select = "ST_Transform(geom, 4326) AS source_geom"
            source_filter = f"source.{geom_col} && bounds.source_geom"
            source_geom_select = f"ST_Transform(source.{geom_col}, 3857) AS geom"
        sql = f"""
            WITH tile_bounds AS (
                SELECT ST_TileEnvelope(%s, %s, %s) AS geom
            ),
            bounds AS (
                SELECT ST_Expand(
                    geom,
                    (ST_XMax(geom) - ST_XMin(geom)) * %s / %s
                ) AS geom,
                {source_bounds_select}
                FROM tile_bounds
            ),
            source_geom AS MATERIALIZED (
                SELECT {source_geom_select}
                FROM {source_table} AS source, bounds
                WHERE {source_filter}
            ),
            clipped AS MATERIALIZED (
                SELECT ST_CollectionExtract(
                    ST_MakeValid(ST_ClipByBox2D(source.geom, bounds.geom)),
                    3
                ) AS geom
                FROM source_geom AS source, bounds
            ),
            dissolved AS MATERIALIZED (
                SELECT ST_CollectionExtract(
                    ST_MakeValid(
                        ST_ReducePrecision(
                            ST_UnaryUnion(ST_Collect(geom)),
                            %s
                        )
                    ),
                    3
                ) AS geom
                FROM clipped
                WHERE NOT ST_IsEmpty(geom)
            )
            SELECT ST_AsBinary(
                ST_Transform(geom, 4326)
            )
            FROM dissolved
            WHERE NOT ST_IsEmpty(geom)
        """
        started = time.perf_counter()
        with self._tile_query_slot(request_kind):
            with psycopg.connect(postgis_dsn(pg)) as connection:
                with connection.cursor() as cursor:
                    cursor.execute(sql, (
                        z,
                        x,
                        y,
                        DEFAULT_TILE_BLEED_PIXELS,
                        DEFAULT_TILE_SIZE,
                        source.simplify_meters,
                    ))
                    row = cursor.fetchone()
        geometry = GeometryCollection()
        if row is not None and row[0] is not None:
            geometry = _valid_polygonal(from_wkb(bytes(row[0])))
        return EezLodOceanTile(
            geometry=geometry,
            source_table=source_table,
            lod=source.lod,
            simplify_meters=source.simplify_meters,
            query_ms=round((time.perf_counter() - started) * 1000.0, 3),
        )

    def _compute_domain_tile(self, z: int, x: int, y: int, request_kind: str) -> EezDomainTile:
        west, south, east, north = xyz_geographic_bleed_bounds(z, x, y)
        bounds = box(west, south, east, north)
        loaded = (
            self._load_lod_ocean_tile(z, x, y, request_kind)
            if self.lod_ocean_loader == self._load_lod_ocean_tile
            else self.lod_ocean_loader(z, x, y)
        )
        if isinstance(loaded, EezLodOceanTile):
            ocean = loaded
        else:
            ocean = EezLodOceanTile(
                geometry=loaded,
                source_table="fixture",
                lod=f"fixture_z{z}",
                simplify_meters=0.0,
                query_ms=0.0,
            )
        clipped_ocean = _safe_polygon_intersection(ocean.geometry, bounds)
        complement = _safe_polygon_difference(bounds, clipped_ocean)
        high_seas_geometries = self.artifact().high_seas
        candidates = (
            high_seas_geometries[int(index)]
            for index in self._tree().query(complement, predicate="intersects")
        )
        land, high_seas = classify_local_complement_components(complement, candidates)
        return EezDomainTile(
            land=land,
            high_seas=high_seas,
            source_table=ocean.source_table,
            lod=ocean.lod,
            simplify_meters=ocean.simplify_meters,
            query_ms=ocean.query_ms,
        )

    def _domain_tile(self, z: int, x: int, y: int, request_kind: str) -> EezDomainTile:
        key = (int(z), int(x), int(y))
        with self._domain_tile_lock:
            cached = self._domain_tile_cache.pop(key, None)
            if cached is not None:
                self._domain_tile_cache[key] = cached
                return cached
            flight = self._domain_tile_inflight.get(key)
            leader = flight is None
            if leader:
                flight = {"done": Event(), "result": None, "error": None}
                self._domain_tile_inflight[key] = flight

        if not leader:
            flight["done"].wait()
            if flight["error"] is not None:
                raise flight["error"]
            return flight["result"]

        try:
            result = self._compute_domain_tile(z, x, y, request_kind)
            with self._domain_tile_lock:
                self._domain_tile_cache[key] = result
                while len(self._domain_tile_cache) > self._domain_tile_cache_max_entries:
                    self._domain_tile_cache.popitem(last=False)
            flight["result"] = result
            return result
        except BaseException as error:
            flight["error"] = error
            raise
        finally:
            with self._domain_tile_lock:
                self._domain_tile_inflight.pop(key, None)
            flight["done"].set()

    def classify_bbox(
        self,
        bbox: tuple[float, float, float, float],
        *,
        eez_coverage_ratio: float = 0.0,
    ) -> dict[str, Any]:
        """Classify the exact EEZ union's complement inside a bbox."""
        west, south, east, north = (float(value) for value in bbox)
        target = box(west, south, east, north)
        target_area = target.area
        if target_area <= 0:
            raise ValueError("EEZ domain bbox must have positive area")
        coverage_ratio = min(1.0, max(0.0, float(eez_coverage_ratio)))
        complement_ratio = max(0.0, 1.0 - coverage_ratio)
        high_seas_area = min(target_area, self._high_seas_intersection_area(target))
        high_seas_ratio = min(complement_ratio, high_seas_area / target_area)
        land_ratio = max(0.0, complement_ratio - high_seas_ratio)
        regions = []
        if high_seas_ratio > 1e-9:
            regions.append({"kind": "high_seas", "overlap_ratio": round(high_seas_ratio, 6)})
        if land_ratio > 1e-9:
            regions.append({"kind": "land", "overlap_ratio": round(land_ratio, 6)})
        regions.sort(key=lambda row: float(row["overlap_ratio"]), reverse=True)
        if complement_ratio <= 1e-9:
            kind = "eez"
        elif len(regions) > 1:
            kind = "mixed"
        elif regions:
            kind = str(regions[0]["kind"])
        else:
            kind = "land"
        return {
            "schema": "rrkal.eez_domain_attribution.v1",
            "kind": kind,
            "regions": regions,
            "eez_coverage_ratio": round(coverage_ratio, 6),
            "source_version": self.source_version,
            "artifact_version": EEZ_DOMAIN_ARTIFACT_VERSION,
        }

    def classify_point(self, *, lat: float, lon: float) -> dict[str, Any]:
        """Classify a point already proven not to intersect the exact EEZ source."""
        point = Point(float(lon), float(lat))
        kind = "high_seas" if self._high_seas_covers(point) else "land"
        return {
            "schema": "rrkal.eez_domain_attribution.v1",
            "kind": kind,
            "regions": [{"kind": kind, "overlap_ratio": 1.0}],
            "source_version": self.source_version,
            "artifact_version": EEZ_DOMAIN_ARTIFACT_VERSION,
        }

    @lru_cache(maxsize=4096)
    def tile_svg(self, kind: str, z: int, x: int, y: int, size: int = DEFAULT_TILE_SIZE) -> tuple[bytes, dict[str, Any]]:
        z = max(0, min(18, int(z)))
        scale = 2 ** z
        x = int(x) % scale
        y = int(y)
        if y < 0 or y >= scale:
            raise ValueError("EEZ domain tile y is outside the Web Mercator world")
        size = max(16, min(1024, int(size)))
        started = time.perf_counter()
        domain_tile = self._domain_tile(z, x, y, kind)
        geometries = domain_tile.land if kind == "land" else domain_tile.high_seas
        paths: list[str] = []
        paths.extend(
            path
            for polygon in geometries
            if (path := _polygon_path(polygon, z, x, y, size))
        )
        path_markup = "".join(f'<path d="{path}"/>' for path in paths)
        bleed = DEFAULT_TILE_BLEED_PIXELS
        rendered_size = size + (bleed * 2)
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="{-bleed} {-bleed} {rendered_size} {rendered_size}" '
            f'width="{rendered_size}" height="{rendered_size}"><g fill="#fff" fill-rule="evenodd" '
            f'shape-rendering="crispEdges" '
            f'stroke="none">{path_markup}</g></svg>'
        ).encode("utf-8")
        artifact = self.artifact()
        return svg, {
            "kind": kind,
            "source_version": artifact.source_version,
            "artifact_version": EEZ_DOMAIN_ARTIFACT_VERSION,
            "geometry_mode": LOD_GEOMETRY_MODE,
            "source_table": domain_tile.source_table,
            "lod": domain_tile.lod,
            "simplify_meters": domain_tile.simplify_meters,
            "source_query_ms": domain_tile.query_ms,
            "z": z,
            "x": x,
            "y": y,
            "bleed_pixels": bleed,
            "feature_count": len(paths),
            "bytes": len(svg),
            "tile_ms": round((time.perf_counter() - started) * 1000.0, 3),
        }
