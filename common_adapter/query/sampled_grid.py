from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable


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


def sampled_grid_render_columns(dataset: dict[str, Any]) -> list[str]:
    columns: list[str] = []
    for column in sampled_grid_source_fields(dataset).values():
        if column not in columns:
            columns.append(column)
    return columns


def sampled_grid_canonical_columns(dataset: dict[str, Any]) -> list[str]:
    if sampled_grid_contract(dataset) is None:
        return list(dataset.get("display_columns") or [])
    fields = sampled_grid_source_fields(dataset)
    columns = [column for role, column in CANONICAL_ROLE_COLUMNS if role in fields]
    if sampled_grid_available_resolutions(dataset) and "resolution_km" not in columns:
        columns.append("resolution_km")
    return columns


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
    return {
        "contract_version": contract.get("contract_version"),
        "available_resolutions_km": sampled_grid_available_resolutions(dataset),
        "grid_profile": deepcopy(contract.get("grid_profile") or {}),
        "coverage_areas": deepcopy(contract.get("coverage_areas") or []),
        "alignment": deepcopy(contract.get("alignment") or {}),
        "geometry": deepcopy(contract.get("geometry") or {}),
        "snapshot_cache": deepcopy(contract.get("snapshot_cache") or {}),
        "value_domain": deepcopy(contract.get("value_domain") or {}),
        "visualization": deepcopy(contract.get("visualization") or {}),
        "zero_is_data": bool(contract.get("zero_is_data", True)),
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


def sampled_grid_row_bounds(row: dict[str, Any], dataset: dict[str, Any]) -> dict[str, float] | None:
    contract = sampled_grid_contract(dataset) or {}
    fields = sampled_grid_source_fields(dataset)
    explicit = _explicit_bounds(row, fields)
    if explicit is not None:
        return explicit
    geometry = _mapping(contract.get("geometry"))
    encoding = str(geometry.get("encoding") or "center").strip().lower()
    available = sampled_grid_available_resolutions(dataset)
    if encoding == "global_index":
        return _global_index_bounds(row, fields, geometry, available)
    if encoding == "center":
        return _center_bounds(row, fields, geometry)
    return None


def canonicalize_sampled_grid_row(
    row: dict[str, Any],
    dataset: dict[str, Any],
    *,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fields = sampled_grid_source_fields(dataset)
    request_fields = sampled_grid_request_fields(dataset)
    request_context = _mapping(context)
    bounds = sampled_grid_row_bounds(row, dataset)
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
    available = sampled_grid_available_resolutions(dataset)
    if canonical["resolution_km"] is None and len(available) == 1:
        canonical["resolution_km"] = available[0]
    return canonical


def _actual_resolution(rows: list[dict[str, Any]], dataset: dict[str, Any]) -> float | None:
    values = _positive_numbers(row.get("resolution_km") for row in rows)
    if len(values) == 1:
        return values[0]
    configured = sampled_grid_available_resolutions(dataset)
    return configured[0] if len(configured) == 1 else None


def canonicalize_sampled_grid_packet(
    packet: dict[str, Any],
    dataset: dict[str, Any],
) -> dict[str, Any]:
    contract = sampled_grid_contract(dataset)
    if contract is None:
        return packet
    if packet.get("row_contract_version") == SAMPLED_GRID_CONTRACT_VERSION:
        return deepcopy(packet)
    normalized = deepcopy(packet)
    rows = [
        canonicalize_sampled_grid_row(row, dataset)
        for row in packet.get("rows") or []
        if isinstance(row, dict)
    ]
    existing_grid = _mapping(packet.get("grid"))
    available = _positive_numbers(
        existing_grid.get("available_resolutions_km")
        or sampled_grid_available_resolutions(dataset)
        or []
    )
    actual = _number(existing_grid.get("actual_resolution_km"))
    if actual is None:
        actual = _actual_resolution(rows, dataset)
    requested = _number(existing_grid.get("requested_resolution_km"))
    if requested is None and len(available) == 1:
        requested = available[0]
    normalized["rows"] = rows
    normalized["row_count"] = len(rows)
    normalized["row_contract_version"] = SAMPLED_GRID_CONTRACT_VERSION
    normalized["columns"] = sampled_grid_canonical_columns(dataset)
    normalized["grid"] = {
        "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
        "grid_profile": deepcopy(existing_grid.get("grid_profile") or contract.get("grid_profile") or {}),
        "available_resolutions_km": available,
        "requested_resolution_km": requested,
        "actual_resolution_km": actual,
        "lod_degraded": bool(existing_grid.get("lod_degraded", requested is not None and actual is not None and actual > requested)),
        "degrade_reason": existing_grid.get("degrade_reason"),
        "coverage_status": existing_grid.get("coverage_status", "covered"),
        "coverage_id": existing_grid.get("coverage_id"),
        "zero_is_data": bool(existing_grid.get("zero_is_data", contract.get("zero_is_data", True))),
        "alignment": deepcopy(existing_grid.get("alignment") or contract.get("alignment") or {}),
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
