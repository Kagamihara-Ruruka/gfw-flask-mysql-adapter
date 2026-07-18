from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from common_adapter.query.grid_frame import (
    CANONICAL_GRID_FRAME_FIELDS,
    CANONICAL_GRID_ROW_FIELDS,
    CanonicalGridFrame,
    CanonicalGridFrameBuilder,
)
from common_adapter.query.immutable import freeze_json, thaw_json


SAMPLED_GRID_CONTRACT_VERSION = "rrkal.sampled_grid.v1"
SAMPLED_GRID_MAPPING_VERSION = "rrkal.mapping.sampled_grid.v1"
KM_PER_LATITUDE_DEGREE = 111.32
CANONICAL_ROLE_COLUMNS = (
    ("time", "date"),
    ("id", "cell_id"),
    ("lat", "lat"),
    ("lon", "lon"),
    ("value", "value"),
    ("resolution", "resolution_km"),
    ("coverage", "coverage_ratio"),
    ("status", "data_status"),
)
CANONICAL_COLUMN_BY_ROLE = dict(CANONICAL_ROLE_COLUMNS)
CANONICAL_EXTENSION_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$")


@dataclass(frozen=True)
class CompiledSampledGridRowPlan:
    role_candidates: Mapping[str, tuple[str, ...]]
    request_paths: Mapping[str, str]
    geometry_encoding: str
    origin_lat: float | None
    origin_lon: float | None
    index_units_per_degree: float | None
    base_resolution_km: float | None
    cell_width_degrees: float | None
    cell_height_degrees: float | None


@dataclass(frozen=True)
class CompiledSampledGridMapping:
    """Immutable dataset mapping context shared by every row in one adapter."""

    source_fields: Mapping[str, str]
    request_fields: Mapping[str, str]
    extension_fields: Mapping[str, str]
    mapping_version: str
    geometry: Mapping[str, Any]
    alignment: Mapping[str, Any]
    available_resolutions_km: tuple[float, ...]
    canonical_columns: tuple[str, ...]
    grid_profile: Mapping[str, Any]
    coverage_areas: tuple[Mapping[str, Any], ...]
    snapshot_cache: Mapping[str, Any]
    value_domain: Mapping[str, Any]
    visualization: Mapping[str, Any]
    default_coverage_id: str | None
    zero_is_data: bool
    row_plan: CompiledSampledGridRowPlan


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _positive_numbers(values: Iterable[Any]) -> list[float]:
    normalized = {_number(value) for value in values}
    return sorted(value for value in normalized if value is not None and value > 0)


def sampled_grid_contract(dataset: dict[str, Any]) -> dict[str, Any] | None:
    contract = dataset.get("sampled_grid")
    return contract if isinstance(contract, dict) else None


def sampled_grid_available_resolutions(dataset: dict[str, Any]) -> list[float]:
    contract = sampled_grid_contract(dataset) or {}
    available = _positive_numbers(contract.get("available_resolutions_km") or [])
    if available:
        return available
    geometry = _mapping(contract.get("geometry"))
    height_degrees = _number(geometry.get("cell_height_degrees") or geometry.get("cell_size_degrees"))
    if height_degrees is not None and height_degrees > 0:
        return [height_degrees * KM_PER_LATITUDE_DEGREE]
    return []


def sampled_grid_source_fields(dataset: dict[str, Any]) -> dict[str, str]:
    contract = sampled_grid_contract(dataset) or {}
    fields = _mapping(contract.get("source_fields"))
    normalized = {
        str(role): str(column)
        for role, column in fields.items()
        if str(role).strip() and str(column).strip()
    }
    if "time" not in normalized and dataset.get("time_column"):
        normalized["time"] = str(dataset["time_column"])
    if "id" not in normalized and dataset.get("id_column"):
        normalized["id"] = str(dataset["id_column"])
    if "lat" not in normalized and dataset.get("lat_column"):
        normalized["lat"] = str(dataset["lat_column"])
    if "lon" not in normalized and dataset.get("lon_column"):
        normalized["lon"] = str(dataset["lon_column"])
    if "value" not in normalized:
        metrics = [str(column) for column in dataset.get("metric_columns") or [] if str(column).strip()]
        if len(metrics) == 1:
            normalized["value"] = metrics[0]
    return normalized


def sampled_grid_request_fields(dataset: dict[str, Any]) -> dict[str, str]:
    contract = sampled_grid_contract(dataset) or {}
    return {
        str(role): str(path)
        for role, path in _mapping(contract.get("request_fields")).items()
        if str(role).strip() and str(path).strip()
    }


def sampled_grid_extension_fields(dataset: dict[str, Any]) -> dict[str, str]:
    contract = sampled_grid_contract(dataset) or {}
    reserved = {column for _role, column in CANONICAL_ROLE_COLUMNS}
    reserved.update({"bounds", "bounds.west", "bounds.south", "bounds.east", "bounds.north"})
    normalized: dict[str, str] = {}
    for canonical_column, source_path in _mapping(contract.get("extension_fields")).items():
        column = str(canonical_column).strip()
        path = str(source_path).strip()
        if not column or not path:
            continue
        if not CANONICAL_EXTENSION_NAME.fullmatch(column):
            raise ValueError(f"invalid canonical extension column: {column!r}")
        if column in reserved or column.startswith("bounds."):
            raise ValueError(f"canonical extension column is reserved: {column!r}")
        normalized[column] = path
    return normalized


def _canonical_columns(
    fields: Mapping[str, str],
    available_resolutions: Iterable[float],
    extension_fields: Mapping[str, str],
) -> tuple[str, ...]:
    columns = [column for role, column in CANONICAL_ROLE_COLUMNS if role in fields]
    if tuple(available_resolutions) and "resolution_km" not in columns:
        columns.append("resolution_km")
    columns.extend(column for column in extension_fields if column not in columns)
    return tuple(columns)


def _role_candidates(fields: Mapping[str, str], role: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(
        str(value)
        for value in (
            fields.get(role),
            CANONICAL_COLUMN_BY_ROLE.get(role),
            role,
        )
        if value
    ))


def _compile_row_plan(
    fields: Mapping[str, str],
    request_fields: Mapping[str, str],
    geometry: Mapping[str, Any],
    available_resolutions: tuple[float, ...],
) -> CompiledSampledGridRowPlan:
    base_resolution = _number(geometry.get("base_resolution_km"))
    if base_resolution is None and available_resolutions:
        base_resolution = available_resolutions[0]
    width = _number(geometry.get("cell_width_degrees") or geometry.get("cell_size_degrees"))
    height = _number(geometry.get("cell_height_degrees") or geometry.get("cell_size_degrees"))
    roles = tuple(dict.fromkeys((
        *(role for role, _column in CANONICAL_ROLE_COLUMNS),
        "row",
        "column",
        "west",
        "south",
        "east",
        "north",
    )))
    return CompiledSampledGridRowPlan(
        role_candidates=freeze_json({role: _role_candidates(fields, role) for role in roles}),
        request_paths=freeze_json(dict(request_fields)),
        geometry_encoding=str(geometry.get("encoding") or "center").strip().lower(),
        origin_lat=_number(geometry.get("origin_lat")),
        origin_lon=_number(geometry.get("origin_lon")),
        index_units_per_degree=_number(geometry.get("index_units_per_degree")),
        base_resolution_km=base_resolution,
        cell_width_degrees=width,
        cell_height_degrees=height,
    )


def compile_sampled_grid_mapping(dataset: dict[str, Any]) -> CompiledSampledGridMapping:
    """Compile a sampled-grid contract once before mapping any source rows."""

    contract = sampled_grid_contract(dataset)
    if contract is None:
        raise ValueError("dataset has no sampled-grid contract")
    source_fields = sampled_grid_source_fields(dataset)
    request_fields = sampled_grid_request_fields(dataset)
    extension_fields = sampled_grid_extension_fields(dataset)
    available = tuple(sampled_grid_available_resolutions(dataset))
    frozen_source_fields = freeze_json(source_fields)
    frozen_request_fields = freeze_json(request_fields)
    coverage_areas = freeze_json(contract.get("coverage_areas") or [])
    frozen_geometry = freeze_json(_mapping(contract.get("geometry")))
    return CompiledSampledGridMapping(
        source_fields=frozen_source_fields,
        request_fields=frozen_request_fields,
        extension_fields=freeze_json(extension_fields),
        mapping_version=str(contract.get("mapping_version") or SAMPLED_GRID_MAPPING_VERSION),
        geometry=frozen_geometry,
        alignment=freeze_json(_mapping(contract.get("alignment"))),
        available_resolutions_km=available,
        canonical_columns=_canonical_columns(frozen_source_fields, available, extension_fields),
        grid_profile=freeze_json(_mapping(contract.get("grid_profile"))),
        coverage_areas=tuple(coverage_areas),
        snapshot_cache=freeze_json(_mapping(contract.get("snapshot_cache"))),
        value_domain=freeze_json(_mapping(contract.get("value_domain"))),
        visualization=freeze_json(_mapping(contract.get("visualization"))),
        default_coverage_id=(
            str(contract.get("default_coverage_id"))
            if contract.get("default_coverage_id") is not None
            else None
        ),
        zero_is_data=bool(contract.get("zero_is_data", True)),
        row_plan=_compile_row_plan(
            frozen_source_fields,
            frozen_request_fields,
            frozen_geometry,
            available,
        ),
    )


def sampled_grid_render_columns(dataset: dict[str, Any]) -> list[str]:
    columns: list[str] = []
    for column in sampled_grid_source_fields(dataset).values():
        if column not in columns:
            columns.append(column)
    for source_path in sampled_grid_extension_fields(dataset).values():
        if source_path not in columns:
            columns.append(source_path)
    return columns


def sampled_grid_canonical_columns(dataset: dict[str, Any]) -> list[str]:
    if sampled_grid_contract(dataset) is None:
        return list(dataset.get("display_columns") or [])
    return list(compile_sampled_grid_mapping(dataset).canonical_columns)


def sampled_grid_public_fields(dataset: dict[str, Any]) -> dict[str, Any]:
    if sampled_grid_contract(dataset) is None:
        return {
            "time_column": dataset.get("time_column"),
            "id_column": dataset.get("id_column"),
            "lat_column": dataset.get("lat_column"),
            "lon_column": dataset.get("lon_column"),
            "display_columns": list(dataset.get("display_columns") or []),
            "metric_columns": list(dataset.get("metric_columns") or []),
            "category_columns": list(dataset.get("category_columns") or []),
        }
    fields = sampled_grid_source_fields(dataset)
    return {
        "time_column": "date",
        "id_column": "cell_id" if "id" in fields else None,
        "lat_column": "lat",
        "lon_column": "lon",
        "display_columns": sampled_grid_canonical_columns(dataset),
        "metric_columns": ["value"] if "value" in fields else [],
        "category_columns": ["data_status"] if "status" in fields else [],
    }


def sampled_grid_public_contract(dataset: dict[str, Any]) -> dict[str, Any] | None:
    contract = sampled_grid_contract(dataset)
    if contract is None:
        return None
    compiled = compile_sampled_grid_mapping(dataset)
    return {
        "contract_version": contract.get("contract_version"),
        "mapping_version": compiled.mapping_version,
        "default_coverage_id": compiled.default_coverage_id,
        "available_resolutions_km": list(compiled.available_resolutions_km),
        "grid_profile": thaw_json(compiled.grid_profile),
        "coverage_areas": thaw_json(compiled.coverage_areas),
        "alignment": thaw_json(compiled.alignment),
        "geometry": thaw_json(compiled.geometry),
        "snapshot_cache": thaw_json(compiled.snapshot_cache),
        "value_domain": thaw_json(compiled.value_domain),
        "visualization": thaw_json(compiled.visualization),
        "zero_is_data": compiled.zero_is_data,
        "extension_columns": list(compiled.extension_fields),
    }


def _row_value(row: dict[str, Any], fields: dict[str, str], role: str) -> Any:
    column = fields.get(role)
    if column and column in row:
        return row.get(column)
    canonical_column = CANONICAL_COLUMN_BY_ROLE.get(role)
    if canonical_column and canonical_column in row:
        return row.get(canonical_column)
    return row.get(role) if role in row else None


def _context_value(context: Mapping[str, Any], path: str | None) -> Any:
    if not str(path or "").strip():
        return None
    current: Any = context
    for part in str(path or "").split("."):
        if not part:
            continue
        if not isinstance(current, Mapping) or part not in current:
            return None
        current = current[part]
    return current


def _canonical_role_value(
    row: dict[str, Any],
    fields: dict[str, str],
    request_fields: dict[str, str],
    context: dict[str, Any],
    role: str,
) -> Any:
    source_column = fields.get(role)
    canonical_column = CANONICAL_COLUMN_BY_ROLE.get(role)
    if (source_column and source_column in row) or (canonical_column and canonical_column in row) or role in row:
        return _row_value(row, fields, role)
    return _context_value(context, request_fields.get(role))


def _explicit_bounds(row: dict[str, Any], fields: dict[str, str]) -> dict[str, float] | None:
    nested = _mapping(row.get("bounds"))
    values = {
        direction: _number(nested.get(direction) if direction in nested else _row_value(row, fields, direction))
        for direction in ("west", "south", "east", "north")
    }
    if any(value is None for value in values.values()):
        return None
    return {direction: float(value) for direction, value in values.items() if value is not None}


def _global_index_bounds(
    row: dict[str, Any],
    fields: dict[str, str],
    geometry: dict[str, Any],
    available_resolutions: list[float],
) -> dict[str, float] | None:
    row_index = _number(_row_value(row, fields, "row"))
    column_index = _number(_row_value(row, fields, "column"))
    resolution = _number(_row_value(row, fields, "resolution"))
    units_per_degree = _number(geometry.get("index_units_per_degree"))
    base_resolution = _number(geometry.get("base_resolution_km"))
    if base_resolution is None and available_resolutions:
        base_resolution = available_resolutions[0]
    origin_lat = _number(geometry.get("origin_lat"))
    origin_lon = _number(geometry.get("origin_lon"))
    if any(value is None for value in (row_index, column_index, resolution, units_per_degree, base_resolution, origin_lat, origin_lon)):
        return None
    if units_per_degree <= 0 or base_resolution <= 0 or resolution <= 0:
        return None
    span = (resolution / base_resolution) / units_per_degree
    north = origin_lat - (row_index / units_per_degree)
    west = origin_lon + (column_index / units_per_degree)
    return {
        "west": west,
        "south": north - span,
        "east": west + span,
        "north": north,
    }


def _center_bounds(
    row: dict[str, Any],
    fields: dict[str, str],
    geometry: dict[str, Any],
) -> dict[str, float] | None:
    lat = _number(_row_value(row, fields, "lat"))
    lon = _number(_row_value(row, fields, "lon"))
    width = _number(geometry.get("cell_width_degrees") or geometry.get("cell_size_degrees"))
    height = _number(geometry.get("cell_height_degrees") or geometry.get("cell_size_degrees"))
    if any(value is None for value in (lat, lon, width, height)):
        return None
    return {
        "west": lon - (width / 2),
        "south": lat - (height / 2),
        "east": lon + (width / 2),
        "north": lat + (height / 2),
    }


def sampled_grid_row_bounds(
    row: dict[str, Any],
    mapping: CompiledSampledGridMapping,
) -> dict[str, float] | None:
    fields = mapping.source_fields
    explicit = _explicit_bounds(row, fields)
    if explicit is not None:
        return explicit
    geometry = mapping.geometry
    encoding = str(geometry.get("encoding") or "center").strip().lower()
    available = list(mapping.available_resolutions_km)
    if encoding == "global_index":
        return _global_index_bounds(row, fields, geometry, available)
    if encoding == "center":
        return _center_bounds(row, fields, geometry)
    return None


def canonicalize_sampled_grid_row(
    row: dict[str, Any],
    mapping: CompiledSampledGridMapping,
    *,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fields = mapping.source_fields
    request_fields = mapping.request_fields
    request_context = _mapping(context)
    bounds = sampled_grid_row_bounds(row, mapping)
    lat = _number(_row_value(row, fields, "lat"))
    lon = _number(_row_value(row, fields, "lon"))
    canonical: dict[str, Any] = {}
    if bounds is not None:
        lat = (bounds["south"] + bounds["north"]) / 2
        lon = (bounds["west"] + bounds["east"]) / 2
        canonical["bounds"] = bounds
    canonical.update(
        {
            "cell_id": _canonical_role_value(row, fields, request_fields, request_context, "id"),
            "date": _canonical_role_value(row, fields, request_fields, request_context, "time"),
            "lat": lat,
            "lon": lon,
            "value": _canonical_role_value(row, fields, request_fields, request_context, "value"),
            "resolution_km": _number(
                _canonical_role_value(row, fields, request_fields, request_context, "resolution")
            ),
            "coverage_ratio": _number(
                _canonical_role_value(row, fields, request_fields, request_context, "coverage")
            ),
            "data_status": _canonical_role_value(row, fields, request_fields, request_context, "status"),
        }
    )
    for canonical_column, source_path in mapping.extension_fields.items():
        canonical[canonical_column] = _context_value(row, source_path)
    available = mapping.available_resolutions_km
    if canonical["resolution_km"] is None and len(available) == 1:
        canonical["resolution_km"] = available[0]
    return freeze_json(canonical)


def _compiled_value(
    row: Mapping[str, Any],
    candidates: tuple[str, ...],
    context_value: Any = None,
) -> Any:
    for field_name in candidates:
        if field_name in row:
            return row.get(field_name)
    return context_value


def canonicalize_sampled_grid_rows(
    rows: Iterable[Mapping[str, Any]],
    mapping: CompiledSampledGridMapping,
    *,
    context: Mapping[str, Any] | None = None,
) -> CanonicalGridFrame:
    """Map a source snapshot to one immutable frame in a single row pass."""

    plan = mapping.row_plan
    request_context = dict(context or {})
    context_values = {
        role: _context_value(request_context, path)
        for role, path in plan.request_paths.items()
    }
    candidates = plan.role_candidates
    available = mapping.available_resolutions_km
    single_resolution = available[0] if len(available) == 1 else None
    extension_fields = tuple(mapping.extension_fields.items())
    source_fields = mapping.source_fields
    primary_fields = {
        role: str(source_fields.get(role) or "")
        for role in (
            "time",
            "id",
            "lat",
            "lon",
            "value",
            "resolution",
            "coverage",
            "status",
            "row",
            "column",
            "west",
            "south",
            "east",
            "north",
        )
    }
    has_explicit_bounds = all(
        primary_fields[role]
        for role in ("west", "south", "east", "north")
    )
    columns: dict[str, list[Any]] = {
        field_name: []
        for field_name in (
            *CANONICAL_GRID_ROW_FIELDS,
            *(field_name for field_name, _source_path in extension_fields),
            *CANONICAL_GRID_FRAME_FIELDS,
        )
    }
    compiled_value = _compiled_value
    as_number = _number
    mapping_type = Mapping
    append_cell_id = columns["cell_id"].append
    append_lat = columns["lat"].append
    append_lon = columns["lon"].append
    append_value = columns["value"].append
    append_coverage = columns["coverage_ratio"].append
    append_status = columns["data_status"].append
    append_west = columns["bounds.west"].append
    append_south = columns["bounds.south"].append
    append_east = columns["bounds.east"].append
    append_north = columns["bounds.north"].append
    append_date = columns["date"].append
    append_resolution = columns["resolution_km"].append
    extension_appenders = tuple(
        (columns[field_name].append, source_path)
        for field_name, source_path in extension_fields
    )
    missing = object()
    for row in rows:
        if not isinstance(row, mapping_type):
            continue
        nested_bounds = row.get("bounds")
        west = south = east = north = None
        if isinstance(nested_bounds, mapping_type):
            west = as_number(nested_bounds.get("west"))
            south = as_number(nested_bounds.get("south"))
            east = as_number(nested_bounds.get("east"))
            north = as_number(nested_bounds.get("north"))
            if None in (west, south, east, north):
                west = south = east = north = None
        if west is None and has_explicit_bounds:
            west = as_number(row.get(primary_fields["west"]))
            south = as_number(row.get(primary_fields["south"]))
            east = as_number(row.get(primary_fields["east"]))
            north = as_number(row.get(primary_fields["north"]))
            if None in (west, south, east, north):
                west = south = east = north = None

        resolution = (
            row.get(primary_fields["resolution"], missing)
            if primary_fields["resolution"]
            else missing
        )
        if resolution is missing:
            resolution = compiled_value(
                row,
                candidates["resolution"],
                context_values.get("resolution"),
            )
        resolution = as_number(resolution)
        if resolution is None:
            resolution = single_resolution
        lat = row.get(primary_fields["lat"], missing) if primary_fields["lat"] else missing
        if lat is missing:
            lat = compiled_value(row, candidates["lat"], context_values.get("lat"))
        lon = row.get(primary_fields["lon"], missing) if primary_fields["lon"] else missing
        if lon is missing:
            lon = compiled_value(row, candidates["lon"], context_values.get("lon"))
        lat = as_number(lat)
        lon = as_number(lon)
        if west is None and plan.geometry_encoding == "global_index":
            row_index = (
                row.get(primary_fields["row"], missing)
                if primary_fields["row"]
                else missing
            )
            if row_index is missing:
                row_index = compiled_value(row, candidates["row"], context_values.get("row"))
            column_index = (
                row.get(primary_fields["column"], missing)
                if primary_fields["column"]
                else missing
            )
            if column_index is missing:
                column_index = compiled_value(
                    row,
                    candidates["column"],
                    context_values.get("column"),
                )
            row_index = as_number(row_index)
            column_index = as_number(column_index)
            if (
                row_index is not None
                and column_index is not None
                and resolution is not None
                and resolution > 0
                and plan.index_units_per_degree is not None
                and plan.index_units_per_degree > 0
                and plan.base_resolution_km is not None
                and plan.base_resolution_km > 0
                and plan.origin_lat is not None
                and plan.origin_lon is not None
            ):
                span = (resolution / plan.base_resolution_km) / plan.index_units_per_degree
                north = plan.origin_lat - (row_index / plan.index_units_per_degree)
                west = plan.origin_lon + (column_index / plan.index_units_per_degree)
                south = north - span
                east = west + span
        elif west is None and plan.geometry_encoding == "center":
            if (
                lat is not None
                and lon is not None
                and plan.cell_width_degrees is not None
                and plan.cell_height_degrees is not None
            ):
                west = lon - (plan.cell_width_degrees / 2)
                south = lat - (plan.cell_height_degrees / 2)
                east = lon + (plan.cell_width_degrees / 2)
                north = lat + (plan.cell_height_degrees / 2)
        if west is not None:
            lat = (south + north) / 2
            lon = (west + east) / 2

        cell_id = row.get(primary_fields["id"], missing) if primary_fields["id"] else missing
        if cell_id is missing:
            cell_id = compiled_value(row, candidates["id"], context_values.get("id"))
        value = (
            row.get(primary_fields["value"], missing)
            if primary_fields["value"]
            else missing
        )
        if value is missing:
            value = compiled_value(row, candidates["value"], context_values.get("value"))
        coverage = (
            row.get(primary_fields["coverage"], missing)
            if primary_fields["coverage"]
            else missing
        )
        if coverage is missing:
            coverage = compiled_value(
                row,
                candidates["coverage"],
                context_values.get("coverage"),
            )
        status = (
            row.get(primary_fields["status"], missing)
            if primary_fields["status"]
            else missing
        )
        if status is missing:
            status = compiled_value(row, candidates["status"], context_values.get("status"))
        date = row.get(primary_fields["time"], missing) if primary_fields["time"] else missing
        if date is missing:
            date = compiled_value(row, candidates["time"], context_values.get("time"))

        append_cell_id(cell_id)
        append_lat(lat)
        append_lon(lon)
        append_value(value)
        append_coverage(as_number(coverage))
        append_status(status)
        append_west(west)
        append_south(south)
        append_east(east)
        append_north(north)
        append_date(date)
        append_resolution(resolution)
        for append_extension, source_path in extension_appenders:
            append_extension(_context_value(row, source_path))

    row_count = len(columns["cell_id"])
    frame_fields: dict[str, Any] = {}
    row_fields = [*CANONICAL_GRID_ROW_FIELDS, *(name for name, _path in extension_fields)]
    for field_name in CANONICAL_GRID_FRAME_FIELDS:
        values = columns[field_name]
        first = values[0] if values else None
        if not values or all(value == first for value in values[1:]):
            frame_fields[field_name] = first
        else:
            row_fields.append(field_name)
    return CanonicalGridFrame(
        row_fields=tuple(row_fields),
        columns=tuple(tuple(columns[field_name]) for field_name in row_fields),
        frame_fields=frame_fields,
        row_count=row_count,
    )


def canonicalize_sampled_grid_columns(
    source_columns: Mapping[str, Sequence[Any]],
    mapping: CompiledSampledGridMapping,
    *,
    context: Mapping[str, Any] | None = None,
    row_count: int | None = None,
) -> CanonicalGridFrame:
    """Map a source column packet without inflating it into row dictionaries."""

    columns = {
        str(name): values
        for name, values in source_columns.items()
        if isinstance(values, Sequence) and not isinstance(values, (str, bytes, bytearray))
    }
    inferred_count = len(next(iter(columns.values()))) if columns else 0
    count = inferred_count if row_count is None else int(row_count)
    if count < 0 or any(len(values) != count for values in columns.values()):
        raise ValueError("sampled-grid source column lengths do not match row_count")

    source_paths = tuple(
        path
        for path in (*mapping.source_fields.values(), *mapping.extension_fields.values())
        if path
    )
    direct_paths = all("." not in str(path) for path in source_paths)
    plan = mapping.row_plan
    row_path = str(mapping.source_fields.get("row") or "")
    column_path = str(mapping.source_fields.get("column") or "")
    if (
        plan.geometry_encoding != "global_index"
        or not direct_paths
        or row_path not in columns
        or column_path not in columns
        or plan.origin_lat is None
        or plan.origin_lon is None
        or plan.index_units_per_degree is None
        or plan.index_units_per_degree <= 0
        or plan.base_resolution_km is None
        or plan.base_resolution_km <= 0
    ):
        names = tuple(columns)
        return canonicalize_sampled_grid_rows(
            (
                {name: columns[name][index] for name in names}
                for index in range(count)
            ),
            mapping,
            context=context,
        )

    request_context = dict(context or {})

    def role_values(role: str) -> Sequence[Any] | None:
        primary = str(mapping.source_fields.get(role) or "")
        if primary in columns:
            return columns[primary]
        for candidate in plan.role_candidates.get(role, ()):
            if candidate in columns:
                return columns[candidate]
        return None

    def role_constant(role: str) -> Any:
        path = plan.request_paths.get(role)
        return _context_value(request_context, path) if path else None

    row_indexes = tuple(_number(value) for value in columns[row_path])
    column_indexes = tuple(_number(value) for value in columns[column_path])
    resolution_source = role_values("resolution")
    if resolution_source is None:
        resolution_constant = role_constant("resolution")
        if resolution_constant is None and len(mapping.available_resolutions_km) == 1:
            resolution_constant = mapping.available_resolutions_km[0]
        resolutions = tuple(_number(resolution_constant) for _ in range(count))
    else:
        resolutions = tuple(_number(value) for value in resolution_source)

    units = plan.index_units_per_degree
    base_resolution = plan.base_resolution_km
    spans = tuple(
        None if resolution is None or resolution <= 0 else (resolution / base_resolution) / units
        for resolution in resolutions
    )
    north = tuple(
        None if row_index is None else plan.origin_lat - (row_index / units)
        for row_index in row_indexes
    )
    west = tuple(
        None if column_index is None else plan.origin_lon + (column_index / units)
        for column_index in column_indexes
    )
    south = tuple(
        None if top is None or span is None else top - span
        for top, span in zip(north, spans, strict=True)
    )
    east = tuple(
        None if left is None or span is None else left + span
        for left, span in zip(west, spans, strict=True)
    )
    latitudes = tuple(
        None if top is None or bottom is None else (top + bottom) / 2
        for top, bottom in zip(north, south, strict=True)
    )
    longitudes = tuple(
        None if left is None or right is None else (left + right) / 2
        for left, right in zip(west, east, strict=True)
    )

    def direct_or_constant(role: str, *, numeric: bool = False) -> tuple[Any, ...]:
        values = role_values(role)
        if values is None:
            constant = role_constant(role)
            return tuple(_number(constant) if numeric else constant for _ in range(count))
        if numeric:
            return tuple(_number(value) for value in values)
        return tuple(values)

    canonical: dict[str, tuple[Any, ...]] = {
        "cell_id": direct_or_constant("id"),
        "lat": latitudes,
        "lon": longitudes,
        "value": direct_or_constant("value"),
        "coverage_ratio": direct_or_constant("coverage", numeric=True),
        "data_status": direct_or_constant("status"),
        "bounds.west": west,
        "bounds.south": south,
        "bounds.east": east,
        "bounds.north": north,
    }
    for canonical_name, source_path in mapping.extension_fields.items():
        canonical[str(canonical_name)] = tuple(columns.get(str(source_path), (None,) * count))

    frame_fields: dict[str, Any] = {}
    row_fields = [*CANONICAL_GRID_ROW_FIELDS, *mapping.extension_fields]
    frame_values = {
        "date": direct_or_constant("time"),
        "resolution_km": resolutions,
    }
    for field_name, values in frame_values.items():
        first = values[0] if values else None
        if not values or all(value == first for value in values[1:]):
            frame_fields[field_name] = first
        else:
            row_fields.append(field_name)
            canonical[field_name] = values

    return CanonicalGridFrame(
        row_fields=tuple(row_fields),
        columns=tuple(canonical[field_name] for field_name in row_fields),
        frame_fields=frame_fields,
        row_count=count,
    )


def _actual_resolution(
    rows: list[dict[str, Any]],
    mapping: CompiledSampledGridMapping,
) -> float | None:
    values = _positive_numbers(row.get("resolution_km") for row in rows)
    if len(values) == 1:
        return values[0]
    configured = list(mapping.available_resolutions_km)
    return configured[0] if len(configured) == 1 else None


def canonicalize_sampled_grid_packet(
    packet: dict[str, Any],
    dataset: dict[str, Any],
) -> dict[str, Any]:
    contract = sampled_grid_contract(dataset)
    if contract is None:
        return packet
    if packet.get("row_contract_version") == SAMPLED_GRID_CONTRACT_VERSION:
        return dict(packet)
    mapping = compile_sampled_grid_mapping(dataset)
    normalized = dict(packet)
    rows = freeze_json([
        canonicalize_sampled_grid_row(row, mapping)
        for row in packet.get("rows") or []
        if isinstance(row, dict)
    ])
    existing_grid = _mapping(packet.get("grid"))
    available = _positive_numbers(
        existing_grid.get("available_resolutions_km")
        or mapping.available_resolutions_km
        or []
    )
    actual = _number(existing_grid.get("actual_resolution_km"))
    if actual is None:
        actual = _actual_resolution(rows, mapping)
    requested = _number(existing_grid.get("requested_resolution_km"))
    if requested is None and len(available) == 1:
        requested = available[0]
    normalized["rows"] = rows
    normalized["row_count"] = len(rows)
    normalized["row_contract_version"] = SAMPLED_GRID_CONTRACT_VERSION
    normalized["columns"] = list(mapping.canonical_columns)
    normalized["grid"] = {
        "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
        "grid_profile": thaw_json(existing_grid.get("grid_profile") or mapping.grid_profile),
        "available_resolutions_km": available,
        "requested_resolution_km": requested,
        "actual_resolution_km": actual,
        "lod_degraded": bool(existing_grid.get("lod_degraded", requested is not None and actual is not None and actual > requested)),
        "degrade_reason": existing_grid.get("degrade_reason"),
        "coverage_status": existing_grid.get("coverage_status", "covered"),
        "coverage_id": existing_grid.get("coverage_id"),
        "zero_is_data": bool(existing_grid.get("zero_is_data", mapping.zero_is_data)),
        "alignment": thaw_json(existing_grid.get("alignment") or mapping.alignment),
    }
    return normalized


def canonicalize_sampled_grid_schema_packet(
    packet: dict[str, Any],
    dataset: dict[str, Any],
) -> dict[str, Any]:
    if sampled_grid_contract(dataset) is None:
        return packet
    normalized = deepcopy(packet)
    normalized["columns"] = [
        {"Field": column, "Type": "canonical"}
        for column in sampled_grid_canonical_columns(dataset)
    ]
    normalized["sampled_grid"] = sampled_grid_public_contract(dataset)
    return normalized


def canonicalize_sampled_grid_range_packet(
    packet: dict[str, Any],
    dataset: dict[str, Any],
) -> dict[str, Any]:
    if sampled_grid_contract(dataset) is None:
        return packet
    normalized = deepcopy(packet)
    snapshots: dict[str, list[dict[str, Any]]] = {}
    for date_value, rows in _mapping(packet.get("snapshots")).items():
        snapshot = canonicalize_sampled_grid_packet({"rows": rows}, dataset)
        snapshots[str(date_value)] = snapshot["rows"]
    normalized["snapshots"] = snapshots
    normalized["grid"] = canonicalize_sampled_grid_packet({"rows": []}, dataset)["grid"]
    normalized["columns"] = sampled_grid_canonical_columns(dataset)
    return normalized


def canonicalize_sampled_grid_time_series_packet(
    packet: dict[str, Any],
    dataset: dict[str, Any],
) -> dict[str, Any]:
    if sampled_grid_contract(dataset) is None:
        return packet
    normalized = deepcopy(packet)
    normalized.pop("source_metric", None)
    return normalized
