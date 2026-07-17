from __future__ import annotations

import math
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
from typing import Any

from common_adapter.endpoint.client import EndpointHttpClient, EndpointRequestError
from common_adapter.endpoint.runtime import value_at
from common_adapter.query.registry import query_adapter
from common_adapter.query.sampled_grid import (
    SAMPLED_GRID_CONTRACT_VERSION,
    canonicalize_sampled_grid_rows,
    compile_sampled_grid_mapping,
)
from common_adapter.query.snapshot_cache import (
    CANONICAL_SNAPSHOT_CACHE,
    SnapshotCachePolicy,
    SnapshotLoad,
)
from common_adapter.query.identity import dataset_cache_namespace


WEB_MERCATOR_KM_PER_CSS_PIXEL_AT_ZOOM_ZERO = 156.54303392804097
GEOGRAPHIC_INTERSECTION_EPSILON = 1e-9
TIME_SERIES_AGGREGATIONS = {"sum", "avg", "min", "max", "count"}


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
    return result if (
        result["west"] + GEOGRAPHIC_INTERSECTION_EPSILON < result["east"]
        and result["south"] + GEOGRAPHIC_INTERSECTION_EPSILON < result["north"]
    ) else None


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
    default_coverage_id: str = "",
) -> tuple[dict[str, Any] | None, str]:
    valid = [row for row in coverages if isinstance(row.get("bounds"), dict)]
    if not valid:
        return None, "outside_coverage"
    if bbox is None:
        configured = next(
            (row for row in valid if str(row.get("id") or "") == default_coverage_id),
            None,
        )
        if configured is not None:
            return configured, "covered"
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


def _time_series_aggregation(value: Any) -> str:
    aggregation = str(value or "sum").strip().lower()
    if aggregation not in TIME_SERIES_AGGREGATIONS:
        allowed = ", ".join(sorted(TIME_SERIES_AGGREGATIONS))
        raise ValueError(f"unsupported time-series aggregation: {aggregation}; expected one of {allowed}")
    return aggregation


def _aggregate_rows(rows: list[dict[str, Any]], aggregation: str) -> float | int | None:
    if aggregation == "count":
        return len(rows)
    values = []
    for row in rows:
        value = _number(row.get("value"))
        if value is not None and math.isfinite(value):
            values.append(value)
    if not values:
        return None
    if aggregation == "avg":
        return sum(values) / len(values)
    if aggregation == "min":
        return min(values)
    if aggregation == "max":
        return max(values)
    return sum(values)


def _time_series_workers(config: dict[str, Any], date_count: int) -> int:
    try:
        workers = int(config.get("max_workers", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("sampled-grid query.time_series.max_workers must be a positive integer") from exc
    if workers < 1:
        raise ValueError("sampled-grid query.time_series.max_workers must be a positive integer")
    return min(workers, max(1, date_count))


def _endpoint_error_matches(
    exc: EndpointRequestError,
    policy: dict[str, Any],
    *,
    status_key: str = "status_codes",
    text_key: str = "error_contains",
) -> bool:
    status_codes = {
        int(value)
        for value in _list(policy.get(status_key))
        if str(value).isdigit()
    }
    fragments = [str(value).lower() for value in _list(policy.get(text_key)) if str(value)]
    if not status_codes and not fragments:
        return False
    body_text = str(exc.body or exc).lower()
    status_match = not status_codes or exc.status_code in status_codes
    text_match = not fragments or any(fragment in body_text for fragment in fragments)
    return status_match and text_match


def _retryable_resolution_error(exc: EndpointRequestError, policy: dict[str, Any]) -> bool:
    return _endpoint_error_matches(
        exc,
        policy,
        status_key="retry_status_codes",
        text_key="retry_error_contains",
    )


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
        self.mapping_context = compile_sampled_grid_mapping(dataset)
        self.query = _mapping(self.descriptor.get("query"))
        self.client = EndpointHttpClient.from_config(_mapping(dataset.get("endpoint_source")))
        self.available_resolutions = list(self.mapping_context.available_resolutions_km)
        self.coverages = [row for row in _list(self.descriptor.get("coverage_areas")) if isinstance(row, dict)]
        self.default_coverage_id = str(self.descriptor.get("default_coverage_id") or "").strip()
        self.dataset_id = str(dataset.get("dataset_id") or dataset.get("data_layer") or "").strip()
        if not self.dataset_id:
            raise ValueError("sampled-grid dataset is missing its canonical dataset_id")
        self.snapshot_cache_policy = SnapshotCachePolicy.from_contract(self.descriptor)
        self.snapshot_cache_namespace = dataset_cache_namespace(dataset)
        self.grid_profile = deepcopy(_mapping(self.descriptor.get("grid_profile")))

    def _availability_dates(
        self,
        *,
        coverage: dict[str, Any] | None,
        resolution: float | None,
    ) -> list[str]:
        availability = _mapping(self.query.get("availability"))
        path = str(availability.get("path") or "").strip()
        if not path:
            return []
        params = _query_parameters(
            self.query,
            self.descriptor,
            {
                "aoi": coverage.get("id") if coverage else None,
                "resolution": resolution,
            },
        )
        body = self.client.get_json(path, params=params)
        return sorted({
            str(value).strip()
            for value in _list(value_at(body, availability.get("dates_path", "dates")))
            if str(value).strip()
        })

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
            source_http_ms = 0.0
            source_json_decode_ms = 0.0
            source_response_bytes = 0
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
                    return replace(cached, actual_identity=candidate_identity, payload=payload)

                params = _query_parameters(
                    self.query,
                    self.descriptor,
                    {
                        "date": date_value,
                        "aoi": coverage_id,
                        "resolution": resolution,
                    },
                )
                no_data_policy = _mapping(snapshot.get("no_data"))
                retry_policy = _mapping(snapshot.get("retry"))
                try:
                    max_attempts = max(1, int(retry_policy.get("max_attempts", 1)))
                    backoff_seconds = max(0.0, float(retry_policy.get("backoff_seconds", 0)))
                except (TypeError, ValueError) as exc:
                    raise ValueError("sampled-grid snapshot retry policy is invalid") from exc
                attempt = 0
                fallback_to_next = False
                while True:
                    attempt += 1
                    query_started = time.perf_counter()
                    try:
                        timed_get = getattr(self.client, "get_json_timed", None)
                        if callable(timed_get):
                            response = timed_get(path, params=params)
                            body = response.body
                            source_http_ms += float(response.http_read_ms)
                            source_json_decode_ms += float(response.json_decode_ms)
                            source_response_bytes += int(response.response_bytes)
                        else:
                            body = self.client.get_json(path, params=params)
                            source_http_ms += (time.perf_counter() - query_started) * 1000
                        break
                    except EndpointRequestError as exc:
                        source_http_ms += (time.perf_counter() - query_started) * 1000
                        if no_data_policy and _endpoint_error_matches(exc, no_data_policy):
                            return SnapshotLoad(
                                candidate_identity,
                                {
                                    "frame": canonicalize_sampled_grid_rows(
                                        [],
                                        self.mapping_context,
                                        context={"date": date_value, "resolution": resolution},
                                    ),
                                    "actual_resolution_km": resolution,
                                    "source_http_ms": round(source_http_ms, 3),
                                    "source_json_decode_ms": round(source_json_decode_ms, 3),
                                    "source_response_bytes": source_response_bytes,
                                    "canonicalize_rows_ms": 0.0,
                                    "degrade_reason": None,
                                    "empty_reason": str(
                                        no_data_policy.get("reason") or "source_snapshot_unavailable"
                                    ),
                                },
                            )
                        if (
                            retry_policy
                            and attempt < max_attempts
                            and _endpoint_error_matches(exc, retry_policy)
                        ):
                            if backoff_seconds:
                                time.sleep(backoff_seconds * attempt)
                            continue
                        has_coarser = index + 1 < len(candidates)
                        if (
                            not allow_fallback
                            or not has_coarser
                            or not _retryable_resolution_error(exc, resolution_policy)
                        ):
                            raise
                        degrade_reason = "source_resolution_limit"
                        fallback_to_next = True
                        break
                if fallback_to_next:
                    continue

                canonicalize_started = time.perf_counter()
                canonical_frame = canonicalize_sampled_grid_rows(
                    _list(value_at(body, snapshot.get("rows_path", "rows"))),
                    self.mapping_context,
                    context={"date": date_value, "resolution": resolution},
                )
                canonicalize_rows_ms = (time.perf_counter() - canonicalize_started) * 1000
                return SnapshotLoad(
                    candidate_identity,
                    {
                        "frame": canonical_frame,
                        "actual_resolution_km": resolution,
                        "source_http_ms": round(source_http_ms, 3),
                        "source_json_decode_ms": round(source_json_decode_ms, 3),
                        "source_response_bytes": source_response_bytes,
                        "canonicalize_rows_ms": round(canonicalize_rows_ms, 3),
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
        coverage, _status = _coverage_choice(
            self.coverages,
            None,
            self.default_coverage_id,
        )
        resolution = self.available_resolutions[-1] if self.available_resolutions else None
        dates = self._availability_dates(coverage=coverage, resolution=resolution)
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
                "grid_profile": deepcopy(self.grid_profile),
                "default_coverage_id": self.default_coverage_id or None,
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
        total_started = time.perf_counter()
        if not start_date or not end_date:
            raise ValueError("sampled-grid time series requires start and end")
        if start_date > end_date:
            start_date, end_date = end_date, start_date
        canonical_metric = str(metric or "value").strip()
        if canonical_metric != "value":
            raise ValueError("sampled-grid time series only exposes the canonical value metric")
        if bbox is None:
            detail = "identity filters are not a source query contract" if identity_column or identity_value else "bbox is required"
            raise ValueError(f"sampled-grid time series requires a canonical bbox; {detail}")

        series_config = _mapping(self.query.get("time_series"))
        mode = str(series_config.get("mode") or "").strip().lower()
        if mode != "snapshot_fold":
            raise ValueError("sampled-grid mapping must declare query.time_series.mode=snapshot_fold")
        aggregate = _time_series_aggregation(aggregation)
        context = _mapping(query_context)
        requested_bbox = _bbox_mapping(bbox)
        requested_resolution = _resolution_for_request(self.available_resolutions, requested_bbox, context)
        coverage, coverage_status = _coverage_choice(
            self.coverages,
            requested_bbox,
            self.default_coverage_id,
        )

        availability_started = time.perf_counter()
        available_dates = self._availability_dates(coverage=coverage, resolution=requested_resolution)
        availability_ms = round((time.perf_counter() - availability_started) * 1000, 3)
        dates = [date for date in available_dates if start_date <= date <= end_date]
        if coverage is None:
            dates = []

        worker_context = {**context, "requested_resolution_km": requested_resolution}

        def fold_date(date_value: str) -> tuple[dict[str, Any], dict[str, Any]]:
            packet = self.records_packet(
                date_value=date_value,
                bbox=bbox,
                limit="max",
                offset=0,
                column_profile="render",
                query_context=worker_context,
            )
            rows = [row for row in _list(packet.get("rows")) if isinstance(row, dict)]
            return {
                "date": date_value,
                "value": _aggregate_rows(rows, aggregate),
                "row_count": len(rows),
            }, packet

        folded: list[tuple[dict[str, Any], dict[str, Any]]] = []
        if dates:
            workers = _time_series_workers(series_config, len(dates))
            if workers == 1:
                folded = [fold_date(date) for date in dates]
            else:
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    folded = list(executor.map(fold_date, dates))
        else:
            workers = 0

        points = [point for point, _packet in folded]
        packets = [packet for _point, packet in folded]
        actual_resolutions = sorted({
            float(actual)
            for packet in packets
            if (actual := _number(_mapping(packet.get("grid")).get("actual_resolution_km"))) is not None
        })
        grids = [_mapping(packet.get("grid")) for packet in packets]
        timings = [_mapping(packet.get("timing")) for packet in packets]
        actual_resolution = max(actual_resolutions) if actual_resolutions else None
        return {
            "start": start_date,
            "end": end_date,
            "metric": canonical_metric,
            "aggregation": aggregate,
            "points": points,
            "point_count": len(points),
            "row_count": sum(point["row_count"] for point in points),
            "bbox": requested_bbox,
            "identity": None,
            "grid": {
                "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
                "grid_profile": deepcopy(self.grid_profile),
                "requested_resolution_km": requested_resolution,
                "actual_resolution_km": actual_resolution,
                "actual_resolutions_km": actual_resolutions,
                "available_resolutions_km": self.available_resolutions,
                "lod_degraded": any(bool(grid.get("lod_degraded")) for grid in grids),
                "degrade_reason": next((grid.get("degrade_reason") for grid in grids if grid.get("degrade_reason")), None),
                "coverage_status": coverage_status,
                "coverage_id": coverage.get("id") if coverage else None,
                "zero_is_data": bool(self.descriptor.get("zero_is_data", True)),
                "alignment": deepcopy(_mapping(self.descriptor.get("alignment"))),
            },
            "query_mode": mode,
            "timing": {
                "cache_hit": bool(timings) and all(bool(timing.get("cache_hit")) for timing in timings),
                "availability_ms": availability_ms,
                "query_ms": round(sum(float(timing.get("query_ms") or 0) for timing in timings), 3),
                "normalize_ms": round(sum(float(timing.get("normalize_ms") or 0) for timing in timings), 3),
                "filter_ms": round(sum(float(timing.get("filter_ms") or 0) for timing in timings), 3),
                "serialize_ms": round(sum(float(timing.get("serialize_ms") or 0) for timing in timings), 3),
                "source_request_count": sum(not bool(timing.get("cache_hit")) for timing in timings),
                "worker_count": workers,
                "server_total_ms": round((time.perf_counter() - total_started) * 1000, 3),
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
        output_profile = str(context.get("output_profile") or "rows").strip().lower()
        requested_bbox = _bbox_mapping(bbox)
        requested_resolution = _resolution_for_request(self.available_resolutions, requested_bbox, context)
        coverage, coverage_status = _coverage_choice(
            self.coverages,
            requested_bbox,
            self.default_coverage_id,
        )
        if coverage is None:
            return self._empty_packet(
                requested_bbox=requested_bbox,
                requested_resolution=requested_resolution,
                coverage_status=coverage_status,
                output_profile=output_profile,
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
        source_slice = _mapping(loaded.payload)
        actual_resolution = _number(source_slice.get("actual_resolution_km"))
        if actual_resolution is None:
            actual_resolution = _number(loaded.actual_identity.get("resolution_km"))
        if actual_resolution is None:
            raise RuntimeError("mapped snapshot has no actual resolution")

        frame = source_slice.get("frame")
        if frame is None or not hasattr(frame, "view"):
            raise RuntimeError("mapped snapshot has no canonical grid frame")
        filter_started = time.perf_counter()
        view = frame.view().intersecting(requested_bbox, epsilon=GEOGRAPHIC_INTERSECTION_EPSILON)
        source_row_count = view.row_count
        offset_value = max(0, int(offset))
        effective_limit = _effective_limit(limit)
        view = view.sliced(offset_value, effective_limit)
        filter_ms = round((time.perf_counter() - filter_started) * 1000, 3)
        cache_stats = CANONICAL_SNAPSHOT_CACHE.stats(self.snapshot_cache_namespace)
        source_http_ms = 0.0 if loaded.cache_hit else float(source_slice.get("source_http_ms") or 0)
        source_json_decode_ms = (
            0.0 if loaded.cache_hit else float(source_slice.get("source_json_decode_ms") or 0)
        )
        source_response_bytes = (
            0 if loaded.cache_hit else int(source_slice.get("source_response_bytes") or 0)
        )
        canonicalize_rows_ms = (
            0.0 if loaded.cache_hit else float(source_slice.get("canonicalize_rows_ms") or 0)
        )
        packet_projection_started = time.perf_counter()
        frame_transport = view.transport() if output_profile == "canonical_frame" else None
        projected_rows = None if frame_transport is not None else view.rows()
        packet_projection_ms = round((time.perf_counter() - packet_projection_started) * 1000, 3)
        tracked_server_ms = sum(
            (
                loaded.cache_lookup_ms,
                loaded.cache_wait_ms,
                source_http_ms,
                source_json_decode_ms,
                canonicalize_rows_ms,
                loaded.cache_commit_ms,
                loaded.cache_evict_ms,
                filter_ms,
                packet_projection_ms,
            )
        )
        degrade_reason = source_slice.get("degrade_reason") if actual_resolution > requested_resolution else None
        bounds = requested_bbox or coverage.get("bounds")
        packet = {
            "row_contract_version": SAMPLED_GRID_CONTRACT_VERSION,
            "row_count": view.row_count,
            "source_row_count": source_row_count,
            "source_slice_row_count": frame.row_count,
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
                "grid_profile": deepcopy(self.grid_profile),
                "requested_resolution_km": requested_resolution,
                "actual_resolution_km": actual_resolution,
                "available_resolutions_km": self.available_resolutions,
                "lod_degraded": actual_resolution > requested_resolution,
                "degrade_reason": degrade_reason,
                "empty_reason": source_slice.get("empty_reason"),
                "coverage_status": coverage_status,
                "coverage_id": coverage.get("id"),
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
                "cache_lookup_ms": loaded.cache_lookup_ms,
                "cache_wait_ms": loaded.cache_wait_ms,
                "cache_commit_ms": loaded.cache_commit_ms,
                "cache_evict_ms": loaded.cache_evict_ms,
                "source_http_ms": round(source_http_ms, 3),
                "source_json_decode_ms": round(source_json_decode_ms, 3),
                "source_response_bytes": source_response_bytes,
                "canonicalize_rows_ms": round(canonicalize_rows_ms, 3),
                "canonical_packet_copy_ms": 0.0,
                "filter_ms": filter_ms,
                "packet_projection_ms": packet_projection_ms,
                "query_ms": round(source_http_ms + source_json_decode_ms, 3),
                "normalize_ms": round(canonicalize_rows_ms, 3),
                "serialize_ms": 0.0,
                "server_total_ms": round(tracked_server_ms, 3),
            },
            "backend": {
                "kind": "sampled_grid_http",
                "connection_ref": self.dataset.get("connection_ref"),
            },
        }
        if frame_transport is not None:
            packet["canonical_frame"] = frame_transport
        else:
            packet["rows"] = projected_rows
        return packet

    def _empty_packet(
        self,
        *,
        requested_bbox: dict[str, float] | None,
        requested_resolution: float,
        coverage_status: str,
        output_profile: str = "rows",
    ) -> dict[str, Any]:
        packet = {
            "row_contract_version": SAMPLED_GRID_CONTRACT_VERSION,
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
                "grid_profile": deepcopy(self.grid_profile),
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
                "cache_waited": False,
                "cache_lookup_ms": 0.0,
                "cache_wait_ms": 0.0,
                "cache_commit_ms": 0.0,
                "cache_evict_ms": 0.0,
                "source_http_ms": 0.0,
                "source_json_decode_ms": 0.0,
                "source_response_bytes": 0,
                "canonicalize_rows_ms": 0.0,
                "canonical_packet_copy_ms": 0.0,
                "filter_ms": 0.0,
                "packet_projection_ms": 0.0,
                "query_ms": 0,
                "serialize_ms": 0,
                "server_total_ms": 0,
            },
            "backend": {
                "kind": "sampled_grid_http",
                "connection_ref": self.dataset.get("connection_ref"),
            },
        }
        if output_profile == "canonical_frame":
            packet["canonical_frame"] = canonicalize_sampled_grid_rows(
                [],
                self.mapping_context,
                context={"resolution": requested_resolution},
            ).view().transport()
        else:
            packet["rows"] = []
        return packet
