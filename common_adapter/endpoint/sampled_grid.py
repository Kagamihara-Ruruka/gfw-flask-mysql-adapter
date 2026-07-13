from __future__ import annotations

import math
import time
from copy import deepcopy
from typing import Any

from common_adapter.endpoint.client import EndpointHttpClient, EndpointRequestError
from common_adapter.endpoint.runtime import value_at
from common_adapter.query.registry import query_adapter
from common_adapter.query.sampled_grid import (
    SAMPLED_GRID_CONTRACT_VERSION,
    canonicalize_sampled_grid_row,
)
from common_adapter.query.snapshot_cache import (
    CANONICAL_SNAPSHOT_CACHE,
    SnapshotCachePolicy,
    SnapshotLoad,
)


WEB_MERCATOR_KM_PER_CSS_PIXEL_AT_ZOOM_ZERO = 156.54303392804097


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive_numbers(value: Any) -> list[float]:
    values = {_number(item) for item in _list(value)}
    return sorted(item for item in values if item is not None and item > 0)


def _area(bounds: dict[str, float]) -> float:
    return max(0.0, bounds["east"] - bounds["west"]) * max(0.0, bounds["north"] - bounds["south"])


def _intersection(
    left: dict[str, float],
    right: dict[str, float],
) -> dict[str, float] | None:
    result = {
        "west": max(left["west"], right["west"]),
        "south": max(left["south"], right["south"]),
        "east": min(left["east"], right["east"]),
        "north": min(left["north"], right["north"]),
    }
    return result if result["west"] < result["east"] and result["south"] < result["north"] else None


def _contains(outer: dict[str, float], inner: dict[str, float]) -> bool:
    return (
        outer["west"] <= inner["west"]
        and outer["south"] <= inner["south"]
        and outer["east"] >= inner["east"]
        and outer["north"] >= inner["north"]
    )


def _bbox_mapping(bbox: tuple[float, float, float, float] | None) -> dict[str, float] | None:
    if bbox is None:
        return None
    west, south, east, north = bbox
    return {"west": west, "south": south, "east": east, "north": north}


def _coverage_choice(
    coverages: list[dict[str, Any]],
    bbox: dict[str, float] | None,
) -> tuple[dict[str, Any] | None, str]:
    valid = [row for row in coverages if isinstance(row.get("bounds"), dict)]
    if not valid:
        return None, "outside_coverage"
    if bbox is None:
        return max(valid, key=lambda row: _area(row["bounds"])), "covered"
    containing = [row for row in valid if _contains(row["bounds"], bbox)]
    if containing:
        return min(containing, key=lambda row: _area(row["bounds"])), "covered"
    intersecting = [
        (row, _intersection(row["bounds"], bbox))
        for row in valid
    ]
    intersecting = [(row, overlap) for row, overlap in intersecting if overlap is not None]
    if not intersecting:
        return None, "outside_coverage"
    row, _overlap = max(intersecting, key=lambda pair: _area(pair[1]))
    return row, "partial"


def _latitude_for_request(
    bbox: dict[str, float] | None,
    query_context: dict[str, Any],
) -> float:
    configured = _number(query_context.get("latitude"))
    if configured is not None:
        return max(-85.0, min(85.0, configured))
    if bbox is not None:
        return max(-85.0, min(85.0, (bbox["south"] + bbox["north"]) / 2))
    return 0.0


def _resolution_for_request(
    available: list[float],
    bbox: dict[str, float] | None,
    query_context: dict[str, Any],
) -> float:
    if not available:
        raise ValueError("sampled-grid mapping has no advertised resolutions")
    explicit = _number(query_context.get("requested_resolution_km"))
    if explicit is not None and explicit > 0:
        return next((value for value in available if value >= explicit), available[-1])
    zoom = _number(query_context.get("zoom"))
    if zoom is None:
        return available[-1]
    latitude = _latitude_for_request(bbox, query_context)
    ground_resolution = (
        WEB_MERCATOR_KM_PER_CSS_PIXEL_AT_ZOOM_ZERO
        * math.cos(math.radians(latitude))
        / (2 ** zoom)
    )
    return next((value for value in available if value >= ground_resolution), available[-1])


def _query_parameters(
    query: dict[str, Any],
    descriptor: dict[str, Any],
    values: dict[str, Any],
) -> dict[str, Any]:
    parameter_names = _mapping(query.get("parameters"))
    canonical = {**_mapping(descriptor.get("source_parameters")), **values}
    params: dict[str, Any] = {}
    for role, value in canonical.items():
        if value is None or str(value) == "":
            continue
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        params[str(parameter_names.get(role) or role)] = value
    return params


def _bounds_intersect(row: dict[str, Any], bbox: dict[str, float] | None) -> bool:
    if bbox is None:
        return True
    bounds = row.get("bounds")
    if isinstance(bounds, dict):
        return _intersection(bounds, bbox) is not None
    lat = _number(row.get("lat"))
    lon = _number(row.get("lon"))
    return bool(
        lat is not None
        and lon is not None
        and bbox["west"] <= lon <= bbox["east"]
        and bbox["south"] <= lat <= bbox["north"]
    )


def _effective_limit(value: Any) -> int | None:
    if value in (None, "", "max", "all", "unlimited"):
        return None
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be a positive integer or max") from exc
    if limit < 1:
        raise ValueError("limit must be positive")
    return limit


def _retryable_resolution_error(exc: EndpointRequestError, policy: dict[str, Any]) -> bool:
    status_codes = {
        int(value)
        for value in _list(policy.get("retry_status_codes"))
        if str(value).isdigit()
    }
    fragments = [str(value).lower() for value in _list(policy.get("retry_error_contains")) if str(value)]
    body_text = str(exc.body or exc).lower()
    status_match = not status_codes or exc.status_code in status_codes
    text_match = not fragments or any(fragment in body_text for fragment in fragments)
    return status_match and text_match


def _union_bounds(coverages: list[dict[str, Any]]) -> dict[str, float] | None:
    bounds = [row.get("bounds") for row in coverages if isinstance(row.get("bounds"), dict)]
    if not bounds:
        return None
    return {
        "min_lon": min(row["west"] for row in bounds),
        "min_lat": min(row["south"] for row in bounds),
        "max_lon": max(row["east"] for row in bounds),
        "max_lat": max(row["north"] for row in bounds),
    }


@query_adapter("sampled_grid_http")
class SampledGridHttpQueryAdapter:
    def __init__(self, config: dict[str, Any], dataset: dict[str, Any]) -> None:
        self.config = config
        self.dataset = dataset
        self.descriptor = _mapping(dataset.get("sampled_grid"))
        self.query = _mapping(self.descriptor.get("query"))
        self.client = EndpointHttpClient.from_config(_mapping(dataset.get("endpoint_source")))
        self.available_resolutions = _positive_numbers(self.descriptor.get("available_resolutions_km"))
        self.coverages = [row for row in _list(self.descriptor.get("coverage_areas")) if isinstance(row, dict)]
        self.dataset_id = str(dataset.get("dataset_id") or dataset.get("data_layer") or "").strip()
        if not self.dataset_id:
            raise ValueError("sampled-grid dataset is missing its canonical dataset_id")
        self.snapshot_cache_policy = SnapshotCachePolicy.from_contract(self.descriptor)
        self.snapshot_cache_namespace = f"{SAMPLED_GRID_CONTRACT_VERSION}:{self.dataset_id}"

    def _snapshot_identity(
        self,
        *,
        date_value: str,
        coverage_id: Any,
        resolution: float,
    ) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "date": str(date_value),
            "coverage_id": str(coverage_id or ""),
            "resolution_km": float(resolution),
        }

    def _load_canonical_snapshot(
        self,
        *,
        date_value: str,
        coverage: dict[str, Any],
        requested_resolution: float,
        candidates: list[float],
        snapshot: dict[str, Any],
        path: str,
        resolution_policy: dict[str, Any],
        allow_fallback: bool,
    ) -> SnapshotLoad:
        coverage_id = coverage.get("id")
        requested_identity = self._snapshot_identity(
            date_value=date_value,
            coverage_id=coverage_id,
            resolution=requested_resolution,
        )

        def load() -> SnapshotLoad:
            source_query_ms = 0.0
            degrade_reason = None
            for index, resolution in enumerate(candidates):
                candidate_identity = self._snapshot_identity(
                    date_value=date_value,
                    coverage_id=coverage_id,
                    resolution=resolution,
                )
                cached = CANONICAL_SNAPSHOT_CACHE.get(
                    self.snapshot_cache_namespace,
                    self.snapshot_cache_policy,
                    candidate_identity,
                )
                if cached is not None:
                    payload = {
                        **_mapping(cached.payload),
                        "degrade_reason": degrade_reason or _mapping(cached.payload).get("degrade_reason"),
                    }
                    return SnapshotLoad(candidate_identity, payload, cache_hit=True)

                params = _query_parameters(
                    self.query,
                    self.descriptor,
                    {
                        "date": date_value,
                        "aoi": coverage_id,
                        "resolution": resolution,
                    },
                )
                query_started = time.perf_counter()
                try:
                    body = self.client.get_json(path, params=params)
                except EndpointRequestError as exc:
                    source_query_ms += (time.perf_counter() - query_started) * 1000
                    has_coarser = index + 1 < len(candidates)
                    if (
                        not allow_fallback
                        or not has_coarser
                        or not _retryable_resolution_error(exc, resolution_policy)
                    ):
                        raise
                    degrade_reason = "source_resolution_limit"
                    continue
                source_query_ms += (time.perf_counter() - query_started) * 1000

                normalize_started = time.perf_counter()
                canonical_rows = []
                for row in _list(value_at(body, snapshot.get("rows_path", "rows"))):
                    if not isinstance(row, dict):
                        continue
                    canonical = canonicalize_sampled_grid_row(row, self.dataset)
                    canonical["date"] = date_value
                    canonical_rows.append(canonical)
                normalize_ms = (time.perf_counter() - normalize_started) * 1000
                return SnapshotLoad(
                    candidate_identity,
                    {
                        "rows": canonical_rows,
                        "actual_resolution_km": resolution,
                        "source_query_ms": round(source_query_ms, 3),
                        "normalize_ms": round(normalize_ms, 3),
                        "degrade_reason": degrade_reason,
                    },
                )
            raise RuntimeError("sampled-grid endpoint returned no snapshot")

        return CANONICAL_SNAPSHOT_CACHE.get_or_load(
            self.snapshot_cache_namespace,
            self.snapshot_cache_policy,
            requested_identity,
            load,
        )

    def schema_packet(self) -> dict[str, Any]:
        started = time.perf_counter()
        availability = _mapping(self.query.get("availability"))
        dates: list[Any] = []
        if availability.get("path"):
            coverage, _status = _coverage_choice(self.coverages, None)
            resolution = self.available_resolutions[-1] if self.available_resolutions else None
            params = _query_parameters(
                self.query,
                self.descriptor,
                {
                    "aoi": coverage.get("id") if coverage else None,
                    "resolution": resolution,
                },
            )
            body = self.client.get_json(str(availability["path"]), params=params)
            dates = _list(value_at(body, availability.get("dates_path", "dates")))
        return {
            "columns": [
                {"Field": column, "Type": "canonical"}
                for column in self.dataset.get("display_columns") or []
            ],
            "row_count": None,
            "bounds": _union_bounds(self.coverages),
            "dates": dates,
            "sampled_grid": {
                "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
                "available_resolutions_km": self.available_resolutions,
                "coverage_areas": deepcopy(self.coverages),
                "alignment": deepcopy(_mapping(self.descriptor.get("alignment"))),
                "value_domain": deepcopy(_mapping(self.descriptor.get("value_domain"))),
            },
            "timing": {
                "query_ms": round((time.perf_counter() - started) * 1000, 3),
                "cache_hit": False,
            },
            "backend": {
                "kind": "sampled_grid_http",
                "connection_ref": self.dataset.get("connection_ref"),
            },
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
            raise ValueError("sampled-grid snapshot requires date")
        context = _mapping(query_context)
        requested_bbox = _bbox_mapping(bbox)
        requested_resolution = _resolution_for_request(self.available_resolutions, requested_bbox, context)
        coverage, coverage_status = _coverage_choice(self.coverages, requested_bbox)
        if coverage is None:
            return self._empty_packet(
                requested_bbox=requested_bbox,
                requested_resolution=requested_resolution,
                coverage_status=coverage_status,
            )

        snapshot = _mapping(self.query.get("snapshot"))
        path = str(snapshot.get("path") or "").strip()
        if not path:
            raise ValueError("sampled-grid mapping is missing query.snapshot.path")
        candidates = [value for value in self.available_resolutions if value >= requested_resolution]
        if not candidates:
            candidates = [self.available_resolutions[-1]]
        resolution_policy = _mapping(self.descriptor.get("resolution_policy"))
        allow_fallback = str(resolution_policy.get("fallback") or "none").strip().lower() == "coarser"
        cache_started = time.perf_counter()
        loaded = self._load_canonical_snapshot(
            date_value=date_value,
            coverage=coverage,
            requested_resolution=requested_resolution,
            candidates=candidates,
            snapshot=snapshot,
            path=path,
            resolution_policy=resolution_policy,
            allow_fallback=allow_fallback,
        )
        cache_lookup_ms = round((time.perf_counter() - cache_started) * 1000, 3)
        source_slice = _mapping(loaded.payload)
        actual_resolution = _number(source_slice.get("actual_resolution_km"))
        if actual_resolution is None:
            actual_resolution = _number(loaded.actual_identity.get("resolution_km"))
        if actual_resolution is None:
            raise RuntimeError("mapped snapshot has no actual resolution")

        filter_started = time.perf_counter()
        rows = [
            row
            for row in _list(source_slice.get("rows"))
            if _bounds_intersect(row, requested_bbox)
        ]
        source_row_count = len(rows)
        offset_value = max(0, int(offset))
        effective_limit = _effective_limit(limit)
        rows = rows[offset_value:]
        if effective_limit is not None:
            rows = rows[:effective_limit]
        filter_ms = round((time.perf_counter() - filter_started) * 1000, 3)
        source_query_ms = 0.0 if loaded.cache_hit else float(source_slice.get("source_query_ms") or 0)
        normalize_ms = 0.0 if loaded.cache_hit else float(source_slice.get("normalize_ms") or 0)
        serialize_ms = round(normalize_ms + filter_ms, 3)
        degrade_reason = source_slice.get("degrade_reason") if actual_resolution > requested_resolution else None
        bounds = requested_bbox or coverage.get("bounds")
        return {
            "rows": rows,
            "row_count": len(rows),
            "source_row_count": source_row_count,
            "source_slice_row_count": len(_list(source_slice.get("rows"))),
            "limit": effective_limit,
            "offset": offset_value,
            "column_profile": column_profile or "render",
            "columns": list(self.dataset.get("display_columns") or []),
            "bounds": None if bounds is None else {
                "min_lon": bounds["west"],
                "min_lat": bounds["south"],
                "max_lon": bounds["east"],
                "max_lat": bounds["north"],
            },
            "grid": {
                "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
                "requested_resolution_km": requested_resolution,
                "actual_resolution_km": actual_resolution,
                "available_resolutions_km": self.available_resolutions,
                "lod_degraded": actual_resolution > requested_resolution,
                "degrade_reason": degrade_reason,
                "coverage_status": coverage_status,
                "coverage_id": coverage.get("id"),
                "zero_is_data": bool(self.descriptor.get("zero_is_data", True)),
                "alignment": deepcopy(_mapping(self.descriptor.get("alignment"))),
            },
            "timing": {
                "cache_hit": loaded.cache_hit,
                "cache_waited": loaded.waited,
                "cache_lookup_ms": cache_lookup_ms,
                "query_ms": round(source_query_ms, 3),
                "normalize_ms": round(normalize_ms, 3),
                "filter_ms": filter_ms,
                "serialize_ms": serialize_ms,
                "server_total_ms": round(cache_lookup_ms + filter_ms, 3),
            },
            "backend": {
                "kind": "sampled_grid_http",
                "connection_ref": self.dataset.get("connection_ref"),
            },
        }

    def _empty_packet(
        self,
        *,
        requested_bbox: dict[str, float] | None,
        requested_resolution: float,
        coverage_status: str,
    ) -> dict[str, Any]:
        return {
            "rows": [],
            "row_count": 0,
            "source_row_count": 0,
            "columns": list(self.dataset.get("display_columns") or []),
            "bounds": None if requested_bbox is None else {
                "min_lon": requested_bbox["west"],
                "min_lat": requested_bbox["south"],
                "max_lon": requested_bbox["east"],
                "max_lat": requested_bbox["north"],
            },
            "grid": {
                "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
                "requested_resolution_km": requested_resolution,
                "actual_resolution_km": None,
                "available_resolutions_km": self.available_resolutions,
                "lod_degraded": False,
                "degrade_reason": None,
                "coverage_status": coverage_status,
                "coverage_id": None,
                "zero_is_data": bool(self.descriptor.get("zero_is_data", True)),
                "alignment": deepcopy(_mapping(self.descriptor.get("alignment"))),
            },
            "timing": {
                "cache_hit": False,
                "query_ms": 0,
                "serialize_ms": 0,
                "server_total_ms": 0,
            },
            "backend": {
                "kind": "sampled_grid_http",
                "connection_ref": self.dataset.get("connection_ref"),
            },
        }
