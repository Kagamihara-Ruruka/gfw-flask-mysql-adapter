from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from common_adapter.query.immutable import freeze_json, thaw_json


SAMPLED_GRID_CONTRACT_VERSION = "rrkal.sampled_grid.v1"
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


@dataclass(frozen=True)
class CompiledSampledGridMapping:
    """Immutable dataset mapping context shared by every row in one adapter."""

    source_fields: Mapping[str, str]
    request_fields: Mapping[str, str]
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


def _canonical_columns(
    fields: Mapping[str, str],
    available_resolutions: Iterable[float],
) -> tuple[str, ...]:
    columns = [column for role, column in CANONICAL_ROLE_COLUMNS if role in fields]
    if tuple(available_resolutions) and "resolution_km" not in columns:
        columns.append("resolution_km")
    return tuple(columns)


def compile_sampled_grid_mapping(dataset: dict[str, Any]) -> CompiledSampledGridMapping:
    """Compile a sampled-grid contract once before mapping any source rows."""

    contract = sampled_grid_contract(dataset)
    if contract is None:
        raise ValueError("dataset has no sampled-grid contract")
    source_fields = sampled_grid_source_fields(dataset)
    request_fields = sampled_grid_request_fields(dataset)
    available = tuple(sampled_grid_available_resolutions(dataset))
    frozen_source_fields = freeze_json(source_fields)
    frozen_request_fields = freeze_json(request_fields)
    coverage_areas = freeze_json(contract.get("coverage_areas") or [])
    return CompiledSampledGridMapping(
        source_fields=frozen_source_fields,
        request_fields=frozen_request_fields,
        geometry=freeze_json(_mapping(contract.get("geometry"))),
        alignment=freeze_json(_mapping(contract.get("alignment"))),
        available_resolutions_km=available,
        canonical_columns=_canonical_columns(frozen_source_fields, available),
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
    )


def sampled_grid_render_columns(dataset: dict[str, Any]) -> list[str]:
    columns: list[str] = []
    for column in sampled_grid_source_fields(dataset).values():
        if column not in columns:
            columns.append(column)
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
    }


def _row_value(row: dict[str, Any], fields: dict[str, str], role: str) -> Any:
    column = fields.get(role)
    if column and column in row:
        return row.get(column)
    canonical_column = CANONICAL_COLUMN_BY_ROLE.get(role)
    if canonical_column and canonical_column in row:
        return row.get(canonical_column)
    return row.get(role) if role in row else None


def _context_value(context: dict[str, Any], path: str | None) -> Any:
    current: Any = context
    for part in str(path or "").split("."):
        if not part:
            continue
        if not isinstance(current, dict) or part not in current:
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
    available = mapping.available_resolutions_km
    if canonical["resolution_km"] is None and len(available) == 1:
        canonical["resolution_km"] = available[0]
    return freeze_json(canonical)


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
