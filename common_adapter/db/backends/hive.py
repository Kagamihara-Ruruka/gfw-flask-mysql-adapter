from __future__ import annotations

import math
import time
from copy import deepcopy
from typing import Any

from common_adapter.db.connect import dataset_backend_info
from common_adapter.db.spark_thrift import availability_packet, heatmap_packet, spark_defaults
from common_adapter.endpoint.sampled_grid import (
    _bbox_mapping,
    _bounds_intersect,
    _coverage_choice,
    _effective_limit,
    _resolution_for_request,
    _union_bounds,
)
from common_adapter.query.identity import dataset_cache_namespace
from common_adapter.query.registry import UnsupportedQueryOperation, query_adapter
from common_adapter.query.sampled_grid import (
    SAMPLED_GRID_CONTRACT_VERSION,
    canonicalize_sampled_grid_row,
    sampled_grid_available_resolutions,
    sampled_grid_canonical_columns,
)
from common_adapter.query.snapshot_cache import (
    CANONICAL_SNAPSHOT_CACHE,
    SnapshotCachePolicy,
    SnapshotLoad,
)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


@query_adapter("hive")
class HiveReadBackend:
    """Read one canonical sampled-grid dataset from Gold through Spark Thrift."""

    def __init__(self, config: dict[str, Any], dataset: dict[str, Any]) -> None:
        self.config = config
        self.dataset = dataset
        self.kind, self.connection_ref, self.connection = dataset_backend_info(config, dataset)
        self.descriptor = _mapping(dataset.get("sampled_grid"))
        if not self.descriptor:
            raise ValueError("hive sampled-grid dataset requires sampled_grid contract")
        self.dataset_id = str(dataset.get("dataset_id") or dataset.get("data_layer") or "").strip()
        if not self.dataset_id:
            raise ValueError("hive sampled-grid dataset requires dataset_id or data_layer")
        self.available_resolutions = sampled_grid_available_resolutions(dataset)
        if not self.available_resolutions:
            raise ValueError("hive sampled-grid dataset requires available_resolutions_km")
        self.coverages = [row for row in _list(self.descriptor.get("coverage_areas")) if isinstance(row, dict)]
        self.source_parameters = _mapping(self.descriptor.get("source_parameters"))
        self.snapshot_cache_policy = SnapshotCachePolicy.from_contract(self.descriptor)
        self.snapshot_cache_namespace = dataset_cache_namespace(dataset)
        self.query_scope = str(self.descriptor.get("query_scope") or "coverage").strip().lower()
        if self.query_scope not in {"coverage", "viewport"}:
            raise ValueError("hive sampled-grid query_scope must be coverage or viewport")
        if (
            self.query_scope == "viewport"
            and self.snapshot_cache_policy.enabled
            and "bbox" not in self.snapshot_cache_policy.identity_roles
        ):
            raise ValueError("viewport snapshot_cache.identity_roles must include bbox")

    def _source_value(self, name: str, fallback: Any = None) -> Any:
        value = self.source_parameters.get(name)
        return fallback if value in (None, "") else value

    def _date_range(self) -> tuple[str, str]:
        configured = _mapping(self.descriptor.get("date_range"))
        defaults = spark_defaults(self.config)
        start = str(configured.get("start") or defaults.get("start_date") or "2022-01-01")
        end = str(configured.get("end") or defaults.get("end_date") or "2024-12-31")
        return start, end

    def _coverage_for_request(
        self,
        bbox: dict[str, float] | None,
        query_context: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any] | None, str, str]:
        context = _mapping(query_context)
        by_id = {
            str(row.get("id") or "").strip(): row
            for row in self.coverages
            if str(row.get("id") or "").strip()
        }
        requested = str(
            context.get("aoi")
            or self.descriptor.get("default_aoi")
            or self.source_parameters.get("aoi")
            or next(iter(by_id), "")
        ).strip()
        if requested not in by_id:
            available = ", ".join(by_id) or "<none>"
            raise ValueError(f"unsupported aoi: {requested!r}; available: {available}")
        coverage, status = _coverage_choice([by_id[requested]], bbox)
        return coverage, status, requested

    def _snapshot_identity(
        self,
        date_value: str,
        coverage_id: str,
        resolution: float,
        bbox: dict[str, float] | None,
    ) -> dict[str, Any]:
        identity = {
            "dataset_id": self.dataset_id,
            "date": date_value,
            "coverage_id": coverage_id,
            "resolution_km": float(resolution),
        }
        if self.query_scope == "viewport":
            if bbox is None:
                raise ValueError("hive viewport query requires bbox")
            identity["bbox"] = tuple(round(float(bbox[key]), 6) for key in ("west", "south", "east", "north"))
        return identity

    def _load_snapshot(
        self,
        *,
        date_value: str,
        coverage_id: str,
        resolution: float,
        bbox: dict[str, float] | None,
    ) -> SnapshotLoad:
        identity = self._snapshot_identity(date_value, coverage_id, resolution, bbox)

        def load() -> SnapshotLoad:
            query_started = time.perf_counter()
            configured_limit = self.descriptor.get("snapshot_limit")
            snapshot_limit = (
                None
                if configured_limit in (None, "")
                else int(configured_limit)
            )
            packet = heatmap_packet(
                self.config,
                date=date_value,
                aoi=coverage_id,
                product=str(self._source_value("product")),
                metric=str(self._source_value("metric")),
                resolution=int(resolution),
                limit=snapshot_limit,
                bbox=(
                    None
                    if self.query_scope != "viewport" or bbox is None
                    else (bbox["west"], bbox["south"], bbox["east"], bbox["north"])
                ),
                geometry=_mapping(self.descriptor.get("geometry")),
            )
            query_ms = (time.perf_counter() - query_started) * 1000
            normalize_started = time.perf_counter()
            rows: list[dict[str, Any]] = []
            for source_row in packet.get("rows") or []:
                if not isinstance(source_row, dict):
                    continue
                row = {**source_row, "resolution_km": source_row.get("resolution_km", resolution)}
                rows.append(canonicalize_sampled_grid_row(row, self.dataset, context={"date": date_value}))
            normalize_ms = (time.perf_counter() - normalize_started) * 1000
            return SnapshotLoad(
                identity,
                {
                    "rows": rows,
                    "actual_resolution_km": resolution,
                    "source_query_ms": round(query_ms, 3),
                    "normalize_ms": round(normalize_ms, 3),
                    "connection": deepcopy(packet.get("connection") or {}),
                },
            )

        return CANONICAL_SNAPSHOT_CACHE.get_or_load(
            self.snapshot_cache_namespace,
            self.snapshot_cache_policy,
            identity,
            load,
        )

    def _effective_viewport_resolution(
        self,
        requested_resolution: float,
        bbox: dict[str, float] | None,
    ) -> tuple[float, int | None]:
        if self.query_scope != "viewport" or bbox is None:
            return requested_resolution, None
        try:
            max_rows = int(self.descriptor.get("max_viewport_rows"))
        except (TypeError, ValueError):
            return requested_resolution, None
        geometry = _mapping(self.descriptor.get("geometry"))
        try:
            units = float(geometry["index_units_per_degree"])
            base_resolution = float(geometry["base_resolution_km"])
        except (KeyError, TypeError, ValueError):
            return requested_resolution, None
        if max_rows < 1 or units <= 0 or base_resolution <= 0:
            return requested_resolution, None

        width = max(0.0, bbox["east"] - bbox["west"])
        height = max(0.0, bbox["north"] - bbox["south"])
        estimate = None
        candidates = [value for value in self.available_resolutions if value >= requested_resolution]
        for candidate in candidates or [self.available_resolutions[-1]]:
            span = (candidate / base_resolution) / units
            estimate = (math.ceil(width / span) + 2) * (math.ceil(height / span) + 2)
            if estimate <= max_rows:
                return candidate, estimate
        return self.available_resolutions[-1], estimate

    def schema_packet(self, *, query_context: dict[str, Any] | None = None) -> dict[str, Any]:
        started = time.perf_counter()
        coverage, coverage_status, coverage_id = self._coverage_for_request(None, query_context)
        if coverage is None:
            raise ValueError("hive sampled-grid dataset has no coverage area")
        resolution = self.available_resolutions[0]
        start_date, end_date = self._date_range()
        packet = availability_packet(
            self.config,
            start_date=start_date,
            end_date=end_date,
            aoi=coverage_id,
            product=str(self._source_value("product")),
            metric=str(self._source_value("metric")),
            resolution=int(resolution),
        )
        return {
            "columns": [
                {"Field": column, "Type": "canonical"}
                for column in sampled_grid_canonical_columns(self.dataset)
            ],
            "row_count": None,
            "bounds": deepcopy(coverage.get("bounds")),
            "dates": packet.get("dates") or [],
            "date_range": {"start": start_date, "end": end_date},
            "coverage_status": coverage_status,
            "coverage_id": coverage_id,
            "timing": {
                **_mapping(packet.get("timing")),
                "server_total_ms": round((time.perf_counter() - started) * 1000, 3),
            },
            "connection": deepcopy(packet.get("connection") or {}),
            "backend": {"kind": self.kind, "connection_ref": self.connection_ref},
        }

    def records_packet(
        self,
        *,
        date_value: str | None,
        bbox: tuple[float, float, float, float] | None,
        limit: Any,
        offset: int,
        column_profile: str | None = None,
        query_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not date_value:
            raise ValueError("hive sampled-grid snapshot requires date")
        context = _mapping(query_context)
        requested_bbox = _bbox_mapping(bbox)
        if self.query_scope == "viewport" and requested_bbox is None:
            raise ValueError("hive viewport query requires bbox")
        requested_resolution = _resolution_for_request(self.available_resolutions, requested_bbox, context)
        query_resolution, estimated_rows = self._effective_viewport_resolution(
            requested_resolution,
            requested_bbox,
        )
        coverage, coverage_status, coverage_id = self._coverage_for_request(requested_bbox, context)
        if coverage is None:
            return {
                "row_contract_version": SAMPLED_GRID_CONTRACT_VERSION,
                "rows": [],
                "row_count": 0,
                "columns": sampled_grid_canonical_columns(self.dataset),
                "grid": {
                    "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
                    "available_resolutions_km": self.available_resolutions,
                    "requested_resolution_km": requested_resolution,
                    "actual_resolution_km": requested_resolution,
                    "coverage_status": coverage_status,
                    "coverage_id": coverage_id,
                },
                "timing": {"query_ms": 0.0, "normalize_ms": 0.0, "filter_ms": 0.0},
                "backend": {"kind": self.kind, "connection_ref": self.connection_ref},
            }

        cache_started = time.perf_counter()
        loaded = self._load_snapshot(
            date_value=str(date_value),
            coverage_id=coverage_id,
            resolution=query_resolution,
            bbox=requested_bbox,
        )
        cache_lookup_ms = round((time.perf_counter() - cache_started) * 1000, 3)
        payload = _mapping(loaded.payload)
        filter_started = time.perf_counter()
        rows = [row for row in payload.get("rows") or [] if _bounds_intersect(row, requested_bbox)]
        source_row_count = len(rows)
        offset_value = max(0, int(offset))
        effective_limit = _effective_limit(limit)
        rows = rows[offset_value:]
        if effective_limit is not None:
            rows = rows[:effective_limit]
        filter_ms = round((time.perf_counter() - filter_started) * 1000, 3)
        cache_stats = CANONICAL_SNAPSHOT_CACHE.stats(self.snapshot_cache_namespace)
        source_query_ms = 0.0 if loaded.cache_hit else float(payload.get("source_query_ms") or 0)
        normalize_ms = 0.0 if loaded.cache_hit else float(payload.get("normalize_ms") or 0)
        return {
            "row_contract_version": SAMPLED_GRID_CONTRACT_VERSION,
            "rows": rows,
            "row_count": len(rows),
            "source_row_count": source_row_count,
            "source_slice_row_count": len(payload.get("rows") or []),
            "limit": effective_limit,
            "offset": offset_value,
            "column_profile": column_profile or "render",
            "columns": sampled_grid_canonical_columns(self.dataset),
            "bounds": None if requested_bbox is None else {
                "min_lon": requested_bbox["west"],
                "min_lat": requested_bbox["south"],
                "max_lon": requested_bbox["east"],
                "max_lat": requested_bbox["north"],
            },
            "grid": {
                "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
                "grid_profile": deepcopy(_mapping(self.descriptor.get("grid_profile"))),
                "requested_resolution_km": requested_resolution,
                "actual_resolution_km": float(payload.get("actual_resolution_km") or query_resolution),
                "available_resolutions_km": self.available_resolutions,
                "lod_degraded": query_resolution > requested_resolution,
                "degrade_reason": "viewport_row_budget" if query_resolution > requested_resolution else None,
                "estimated_source_rows": estimated_rows,
                "coverage_status": coverage_status,
                "coverage_id": coverage_id,
                "zero_is_data": bool(self.descriptor.get("zero_is_data", True)),
                "alignment": deepcopy(_mapping(self.descriptor.get("alignment"))),
            },
            "timing": {
                "cache_hit": loaded.cache_hit,
                "cache_waited": loaded.waited,
                "cache_namespace_entries": cache_stats["namespace_entries"],
                "cache_total_entries": cache_stats["total_entries"],
                "cache_total_rows": cache_stats["total_rows"],
                "cache_max_rows": cache_stats["max_total_rows"],
                "cache_lookup_ms": cache_lookup_ms,
                "query_ms": round(source_query_ms, 3),
                "normalize_ms": round(normalize_ms, 3),
                "filter_ms": filter_ms,
                "server_total_ms": round(cache_lookup_ms + filter_ms, 3),
            },
            "connection": deepcopy(payload.get("connection") or {}),
            "backend": {"kind": self.kind, "connection_ref": self.connection_ref},
        }

    def records_range_packet(
        self,
        *,
        start_date: str,
        end_date: str,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        column_profile: str | None = None,
        query_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raise UnsupportedQueryOperation(
            "hive",
            "records_range_packet",
            "playback loads date snapshots on demand; bulk multi-date rows are intentionally disabled",
        )

    def time_series_packet(
        self,
        *,
        start_date: str,
        end_date: str,
        bbox: tuple[float, float, float, float] | None,
        metric: str | None = None,
        aggregation: str | None = None,
        identity_column: str | None = None,
        identity_value: str | None = None,
        query_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raise UnsupportedQueryOperation(
            "hive",
            "time_series_packet",
            "the current line widget folds cached date snapshots instead of issuing a separate SQL contract",
        )
