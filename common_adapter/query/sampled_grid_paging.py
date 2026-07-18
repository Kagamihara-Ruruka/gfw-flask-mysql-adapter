from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from common_adapter.query.grid_frame import (
    CanonicalGridFrame,
    merge_canonical_grid_frame_views,
)
from common_adapter.query.sampled_grid import (
    CompiledSampledGridMapping,
    canonicalize_sampled_grid_rows,
)


GEOGRAPHIC_INTERSECTION_EPSILON = 1e-9


@dataclass(frozen=True)
class SampledGridShardPlan:
    index: int
    shard_id: str
    offset: int
    limit: int
    row_start: int
    row_stop: int
    source_has_more: bool


@dataclass(frozen=True)
class SampledGridShardQueryPlan:
    source_column_count: int
    source_row_count: int
    source_expected_row_count: int
    query_column_start: int
    query_column_stop: int
    query_row_start: int
    query_row_stop: int
    expected_row_count: int
    column_index_start: float
    row_index_start: float
    index_step: float
    effective_bbox: Mapping[str, float]
    shards: tuple[SampledGridShardPlan, ...]
    topology_shard_count: int

    @property
    def query_column_count(self) -> int:
        return self.query_column_stop - self.query_column_start

    @property
    def query_row_count(self) -> int:
        return self.query_row_stop - self.query_row_start


@dataclass(frozen=True)
class CanonicalSampledGridShard:
    frame: CanonicalGridFrame
    source_row_count: int
    duplicate_row_count: int


@dataclass(frozen=True)
class AssembledSampledGridFrame:
    frame: CanonicalGridFrame
    source_row_count: int
    duplicate_row_count: int
    shard_count: int


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive_integer(value: Any, *, name: str) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if numeric < 1:
        raise ValueError(f"{name} must be a positive integer")
    return numeric


def _normalized_bounds(value: Mapping[str, Any], *, name: str) -> dict[str, float]:
    bounds = {
        direction: _number(value.get(direction))
        for direction in ("west", "south", "east", "north")
    }
    if any(item is None for item in bounds.values()):
        raise ValueError(f"sampled-grid {name} requires complete bounds")
    normalized = {direction: float(item) for direction, item in bounds.items() if item is not None}
    if normalized["west"] >= normalized["east"] or normalized["south"] >= normalized["north"]:
        raise ValueError(f"sampled-grid {name} bounds are invalid")
    return normalized


def effective_query_bbox(
    viewport_bbox: Mapping[str, Any] | None,
    coverage_bounds: Mapping[str, Any],
) -> dict[str, float] | None:
    """Clip the CC viewport to source coverage without changing either owner."""

    coverage = _normalized_bounds(coverage_bounds, name="coverage")
    if viewport_bbox is None:
        return coverage
    viewport = _normalized_bounds(viewport_bbox, name="viewport")
    effective = {
        "west": max(viewport["west"], coverage["west"]),
        "south": max(viewport["south"], coverage["south"]),
        "east": min(viewport["east"], coverage["east"]),
        "north": min(viewport["north"], coverage["north"]),
    }
    if effective["west"] >= effective["east"] or effective["south"] >= effective["north"]:
        return None
    return effective


def _aligned_count(span: float, cell_span: float, *, axis: str) -> int:
    if span <= 0 or cell_span <= 0:
        raise ValueError(f"sampled-grid {axis} span must be positive")
    raw = span / cell_span
    rounded = round(raw)
    if rounded < 1 or not math.isclose(raw, rounded, rel_tol=0, abs_tol=1e-7):
        raise ValueError(f"sampled-grid coverage is not aligned on the {axis} axis")
    return int(rounded)


def _floor_slot(value: float) -> int:
    return math.floor(value + 1e-9)


def _ceil_slot(value: float) -> int:
    return math.ceil(value - 1e-9)


def plan_sampled_grid_shards(
    *,
    viewport_bbox: Mapping[str, Any] | None,
    coverage_bounds: Mapping[str, Any],
    resolution_km: float,
    mapping: CompiledSampledGridMapping,
    pagination: Mapping[str, Any],
) -> SampledGridShardQueryPlan:
    """Resolve stable source shards for the snapped CC query extent."""

    mode = str(pagination.get("mode") or "").strip().lower()
    if mode != "offset_limit":
        raise ValueError("sampled-grid source must advertise offset_limit pagination")
    max_page_size = _positive_integer(
        pagination.get("max_page_size"),
        name="pagination.max_page_size",
    )
    stable_order = tuple(str(value) for value in pagination.get("stable_order") or ())
    expected_order = (
        str(mapping.source_fields.get("row") or ""),
        str(mapping.source_fields.get("column") or ""),
    )
    if not all(expected_order) or stable_order[:2] != expected_order:
        raise ValueError("sampled-grid pagination order does not match mapped row/column identity")

    row_plan = mapping.row_plan
    if row_plan.geometry_encoding != "global_index":
        raise ValueError("sampled-grid pagination currently requires global_index geometry")
    if (
        row_plan.index_units_per_degree is None
        or row_plan.index_units_per_degree <= 0
        or row_plan.base_resolution_km is None
        or row_plan.base_resolution_km <= 0
        or row_plan.origin_lat is None
        or row_plan.origin_lon is None
        or resolution_km <= 0
    ):
        raise ValueError("sampled-grid pagination requires complete Scout geometry")

    coverage = _normalized_bounds(coverage_bounds, name="coverage")
    effective = effective_query_bbox(viewport_bbox, coverage)
    if effective is None:
        raise ValueError("sampled-grid viewport is outside source coverage")

    index_step = resolution_km / row_plan.base_resolution_km
    cell_span = index_step / row_plan.index_units_per_degree
    source_column_count = _aligned_count(
        coverage["east"] - coverage["west"],
        cell_span,
        axis="longitude",
    )
    source_row_count = _aligned_count(
        coverage["north"] - coverage["south"],
        cell_span,
        axis="latitude",
    )
    source_expected_row_count = source_column_count * source_row_count

    query_column_start = max(
        0,
        _floor_slot((effective["west"] - coverage["west"]) / cell_span),
    )
    query_column_stop = min(
        source_column_count,
        _ceil_slot((effective["east"] - coverage["west"]) / cell_span),
    )
    query_row_start = max(
        0,
        _floor_slot((coverage["north"] - effective["north"]) / cell_span),
    )
    query_row_stop = min(
        source_row_count,
        _ceil_slot((coverage["north"] - effective["south"]) / cell_span),
    )
    if query_column_start >= query_column_stop or query_row_start >= query_row_stop:
        raise ValueError("sampled-grid snapped viewport has no cells")

    max_rows_per_shard = max_page_size // source_column_count
    if max_rows_per_shard < 1:
        raise ValueError("source page limit cannot hold one complete sampled-grid row")
    topology_shard_count = math.ceil(source_row_count / max_rows_per_shard)
    rows_per_shard = math.ceil(source_row_count / topology_shard_count)
    shards: list[SampledGridShardPlan] = []
    for row_start in range(0, source_row_count, rows_per_shard):
        row_stop = min(source_row_count, row_start + rows_per_shard)
        if row_stop <= query_row_start or row_start >= query_row_stop:
            continue
        offset = row_start * source_column_count
        limit = (row_stop - row_start) * source_column_count
        shards.append(
            SampledGridShardPlan(
                index=row_start // rows_per_shard,
                shard_id=f"rows-{row_start:06d}-{row_stop:06d}",
                offset=offset,
                limit=limit,
                row_start=row_start,
                row_stop=row_stop,
                source_has_more=offset + limit < source_expected_row_count,
            )
        )

    snapped_bbox = {
        "west": coverage["west"] + query_column_start * cell_span,
        "south": coverage["north"] - query_row_stop * cell_span,
        "east": coverage["west"] + query_column_stop * cell_span,
        "north": coverage["north"] - query_row_start * cell_span,
    }
    return SampledGridShardQueryPlan(
        source_column_count=source_column_count,
        source_row_count=source_row_count,
        source_expected_row_count=source_expected_row_count,
        query_column_start=query_column_start,
        query_column_stop=query_column_stop,
        query_row_start=query_row_start,
        query_row_stop=query_row_stop,
        expected_row_count=(query_column_stop - query_column_start)
        * (query_row_stop - query_row_start),
        column_index_start=(coverage["west"] - row_plan.origin_lon)
        * row_plan.index_units_per_degree,
        row_index_start=(row_plan.origin_lat - coverage["north"])
        * row_plan.index_units_per_degree,
        index_step=index_step,
        effective_bbox=snapped_bbox,
        shards=tuple(shards),
        topology_shard_count=topology_shard_count,
    )


def _value_at(row: Mapping[str, Any], path: str) -> Any:
    current: Any = row
    for part in str(path or "").split("."):
        if not part:
            continue
        if not isinstance(current, Mapping) or part not in current:
            return None
        current = current[part]
    return current


def canonicalize_sampled_grid_shard(
    *,
    rows: Iterable[Mapping[str, Any]],
    page_metadata: Mapping[str, Any],
    mapping: CompiledSampledGridMapping,
    query_plan: SampledGridShardQueryPlan,
    shard_plan: SampledGridShardPlan,
    context: Mapping[str, Any],
) -> CanonicalSampledGridShard:
    """Validate one stable source shard and map it exactly once."""

    materialized = tuple(row for row in rows if isinstance(row, Mapping))
    if str(page_metadata.get("mode") or "") != "offset_limit":
        raise ValueError("sampled-grid source returned an incompatible page mode")
    if int(page_metadata.get("offset", -1)) != shard_plan.offset:
        raise ValueError("sampled-grid source returned the wrong page offset")
    if int(page_metadata.get("limit", -1)) != shard_plan.limit:
        raise ValueError("sampled-grid source returned the wrong page limit")
    if int(page_metadata.get("returned", -1)) != len(materialized):
        raise ValueError("sampled-grid source page metadata does not match its rows")
    if len(materialized) != shard_plan.limit:
        raise ValueError(
            f"sampled-grid shard {shard_plan.shard_id} is incomplete: "
            f"expected {shard_plan.limit}, received {len(materialized)}"
        )
    if bool(page_metadata.get("has_more")) != shard_plan.source_has_more:
        raise ValueError("sampled-grid source continuation does not match the Scout topology")

    row_path = str(mapping.source_fields.get("row") or "")
    column_path = str(mapping.source_fields.get("column") or "")
    seen: set[tuple[float, float]] = set()
    duplicate_row_count = 0
    for position, row in enumerate(materialized):
        row_index = _number(_value_at(row, row_path))
        column_index = _number(_value_at(row, column_path))
        if row_index is None or column_index is None:
            raise ValueError("sampled-grid source row has no mapped row/column identity")
        row_slot = (row_index - query_plan.row_index_start) / query_plan.index_step
        column_slot = (column_index - query_plan.column_index_start) / query_plan.index_step
        if (
            not math.isclose(row_slot, round(row_slot), rel_tol=0, abs_tol=1e-7)
            or not math.isclose(column_slot, round(column_slot), rel_tol=0, abs_tol=1e-7)
        ):
            raise ValueError("sampled-grid source row is not aligned to the Scout grid")
        row_number = int(round(row_slot))
        column_number = int(round(column_slot))
        if (
            not shard_plan.row_start <= row_number < shard_plan.row_stop
            or not 0 <= column_number < query_plan.source_column_count
        ):
            raise ValueError("sampled-grid source row is outside its stable shard")
        identity = (row_index, column_index)
        if identity in seen:
            duplicate_row_count += 1
        seen.add(identity)
        linear_index = row_number * query_plan.source_column_count + column_number
        if linear_index != shard_plan.offset + position:
            raise ValueError("sampled-grid source shard order or completeness drifted")

    frame = canonicalize_sampled_grid_rows(materialized, mapping, context=context)
    if duplicate_row_count or len(seen) != shard_plan.limit or frame.row_count != shard_plan.limit:
        raise ValueError("sampled-grid source shard contains duplicate or missing cells")
    return CanonicalSampledGridShard(
        frame=frame,
        source_row_count=len(materialized),
        duplicate_row_count=duplicate_row_count,
    )


class SampledGridFrameAssembler:
    """Owns stable-shard stitching for one effective CC query extent."""

    def __init__(self, *, plan: SampledGridShardQueryPlan) -> None:
        self._plan = plan
        self._shards: dict[str, CanonicalSampledGridShard] = {}

    def add_shard(
        self,
        shard_plan: SampledGridShardPlan,
        shard: CanonicalSampledGridShard,
    ) -> None:
        if shard_plan.shard_id in self._shards:
            raise ValueError(f"sampled-grid shard {shard_plan.shard_id} was added twice")
        if shard.frame.row_count != shard_plan.limit:
            raise ValueError(f"sampled-grid shard {shard_plan.shard_id} has the wrong row count")
        self._shards[shard_plan.shard_id] = shard

    def finish(self) -> AssembledSampledGridFrame:
        missing = [
            shard.shard_id
            for shard in self._plan.shards
            if shard.shard_id not in self._shards
        ]
        if missing:
            raise ValueError(f"sampled-grid frame is missing shards: {missing}")
        selected_views = [
            self._shards[shard.shard_id]
            .frame.view()
            .intersecting(
                self._plan.effective_bbox,
                epsilon=GEOGRAPHIC_INTERSECTION_EPSILON,
            )
            for shard in self._plan.shards
        ]
        frame = merge_canonical_grid_frame_views(selected_views)
        if frame.row_count != self._plan.expected_row_count:
            raise ValueError(
                "sampled-grid frame is incomplete after stitching: "
                f"expected {self._plan.expected_row_count}, received {frame.row_count} cells"
            )
        cell_ids = frame.column("cell_id")
        if cell_ids is not None and len(set(cell_ids)) != frame.row_count:
            raise ValueError("sampled-grid frame contains duplicate canonical cell identities")
        return AssembledSampledGridFrame(
            frame=frame,
            source_row_count=sum(
                self._shards[shard.shard_id].source_row_count
                for shard in self._plan.shards
            ),
            duplicate_row_count=sum(
                self._shards[shard.shard_id].duplicate_row_count
                for shard in self._plan.shards
            ),
            shard_count=len(self._plan.shards),
        )
