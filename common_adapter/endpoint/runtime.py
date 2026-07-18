from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from common_adapter.developer.config_service import load_layer_mappings
from common_adapter.endpoint.client import EndpointHttpClient, EndpointRequestError
from common_adapter.query.grid_registry import GridRegistry


SAMPLED_GRID_MAPPING_VERSION = "rrkal.mapping.sampled_grid.v1"
SAMPLED_GRID_CONTRACT_VERSION = "rrkal.sampled_grid.v1"
LAYER_MAPPINGS_CONFIG_REF = "config/artifacts/layer_mappings.local.json"
SAMPLED_GRID_CANONICAL_ROLES = {
    "time": "date",
    "id": "cell_id",
    "lat": "lat",
    "lon": "lon",
    "value": "value",
    "resolution": "resolution_km",
    "coverage": "coverage_ratio",
    "status": "data_status",
}


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def value_at(payload: Any, path: Any, fallback: Any = None) -> Any:
    if path in (None, "", []):
        return payload
    parts = path if isinstance(path, list) else str(path).split(".")
    current = payload
    for part in parts:
        if isinstance(current, dict) and str(part) in current:
            current = current[str(part)]
            continue
        if isinstance(current, list) and str(part).isdigit():
            index = int(part)
            if 0 <= index < len(current):
                current = current[index]
                continue
        return fallback
    return current


def _text(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive_numbers(value: Any) -> list[float]:
    values = {_number(item) for item in _list(value)}
    return sorted(item for item in values if item is not None and item > 0)


def _layer_token(value: Any, fallback: str = "layer") -> str:
    token = re.sub(r"[^a-z0-9_.-]+", "_", _text(value).lower()).strip("._-")
    token = re.sub(r"^[^a-z]+", "", token)
    return token[:64] or fallback


def _catalog_mapping(mapping: dict[str, Any]) -> dict[str, Any] | None:
    sampled_grid = _mapping(mapping.get("sampled_grid"))
    catalog = sampled_grid.get("catalog")
    if not isinstance(catalog, dict):
        return None
    return sampled_grid


def sampled_grid_catalog_mappings(config_ref: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for mapping in load_layer_mappings().get("mappings", []):
        if not mapping.get("enabled", True):
            continue
        if _text(mapping.get("config_path")) != config_ref:
            continue
        if _catalog_mapping(mapping) is None:
            continue
        rows.append(mapping)
    return sorted(rows, key=lambda row: _text(row.get("mapping_id")))


def resolved_mapping_for_dataset(dataset_id: str, dataset: dict[str, Any]) -> dict[str, Any]:
    """Expose the exact canonical mapping consumed by a generated runtime dataset."""
    roles = {
        str(role): str(column)
        for role, column in (
            _mapping(dataset.get("canonical_roles")) or SAMPLED_GRID_CANONICAL_ROLES
        ).items()
        if _text(role) and _text(column)
    }
    selected_columns: list[str] = []
    for column in [
        *roles.values(),
        *_list(dataset.get("display_columns")),
        *_list(dataset.get("metric_columns")),
        *_list(dataset.get("category_columns")),
    ]:
        name = _text(column)
        if name and name not in selected_columns:
            selected_columns.append(name)
    return {
        "source_mapping_id": dataset.get("__runtime_mapping_id"),
        "dataset_id": dataset_id,
        "layer_id": dataset.get("data_layer") or dataset_id,
        "label": dataset.get("label") or dataset_id,
        "roles": roles,
        "selected_columns": selected_columns,
        "display_columns": list(_list(dataset.get("display_columns"))),
        "metric_columns": list(_list(dataset.get("metric_columns"))),
        "category_columns": list(_list(dataset.get("category_columns"))),
    }


def _field(item: dict[str, Any], fields: dict[str, Any], role: str, fallback: Any = None) -> Any:
    return value_at(item, fields.get(role), fallback)


def _coverage_rows(catalog_body: Any, catalog: dict[str, Any]) -> list[dict[str, Any]]:
    fields = _mapping(catalog.get("coverage_fields"))
    rows: list[dict[str, Any]] = []
    for item in _list(value_at(catalog_body, catalog.get("coverages_path"))):
        if not isinstance(item, dict):
            continue
        coverage_id = _text(_field(item, fields, "id"))
        west = _number(_field(item, fields, "west"))
        south = _number(_field(item, fields, "south"))
        east = _number(_field(item, fields, "east"))
        north = _number(_field(item, fields, "north"))
        if not coverage_id or any(value is None for value in (west, south, east, north)):
            continue
        if west >= east or south >= north:
            continue
        rows.append(
            {
                "id": coverage_id,
                "label": _text(_field(item, fields, "label"), coverage_id),
                "bounds": {"west": west, "south": south, "east": east, "north": north},
            }
        )
    return rows


def _dataset_from_catalog_item(
    *,
    config_ref: str,
    route_config: dict[str, Any],
    mapping: dict[str, Any],
    sampled_grid: dict[str, Any],
    catalog_body: Any,
    item: dict[str, Any],
    source_route_group: str,
    grid_registry: GridRegistry,
) -> tuple[str, dict[str, Any]] | None:
    catalog = _mapping(sampled_grid.get("catalog"))
    fields = _mapping(catalog.get("layer_fields"))
    source_layer_id = _text(_field(item, fields, "id"))
    if not source_layer_id:
        return None
    prefix = _layer_token(mapping.get("layer_id") or route_config.get("name") or mapping.get("connection_ref"), "endpoint")
    layer_id = _layer_token(f"{prefix}.{source_layer_id}")
    dataset_id = layer_id
    label = _text(_field(item, fields, "label"), source_layer_id)
    product_value = _field(item, fields, "product")
    metric_value = _field(item, fields, "metric", source_layer_id)
    resolutions = _positive_numbers(value_at(catalog_body, catalog.get("resolutions_path")))
    coverages = _coverage_rows(catalog_body, catalog)
    default_coverage_id = _text(sampled_grid.get("default_coverage_id"))
    if default_coverage_id and not any(
        coverage.get("id") == default_coverage_id for coverage in coverages
    ):
        raise ValueError(
            f"mapping default_coverage_id is not advertised by catalog: {default_coverage_id}"
        )
    row_fields = {
        str(role): str(path)
        for role, path in _mapping(sampled_grid.get("row_fields")).items()
        if _text(role) and _text(path)
    }
    request_fields = {
        str(role): str(path)
        for role, path in _mapping(sampled_grid.get("request_fields")).items()
        if _text(role) and _text(path)
    }
    query = deepcopy(_mapping(sampled_grid.get("query")))
    snapshot_capabilities = _mapping(
        value_at(catalog_body, catalog.get("snapshot_capabilities_path"))
    )
    pagination = _mapping(snapshot_capabilities.get("pagination"))
    if pagination:
        snapshot = deepcopy(_mapping(query.get("snapshot")))
        snapshot["pagination"] = deepcopy(pagination)
        query["snapshot"] = snapshot
    source_parameters = deepcopy(_mapping(query.get("static_parameters")))
    source_parameters.update({"product": product_value, "metric": metric_value})
    higher_is_better = _field(item, fields, "higher_is_better")
    value_domain = {
        "min": _number(_field(item, fields, "min")),
        "max": _number(_field(item, fields, "max")),
        "unit": _text(_field(item, fields, "unit")),
        "higher_is_better": higher_is_better if isinstance(higher_is_better, bool) else None,
        "interpretation": _text(_field(item, fields, "interpretation")),
    }
    descriptor = {
        "contract_version": SAMPLED_GRID_CONTRACT_VERSION,
        "mapping_version": _text(sampled_grid.get("mapping_version"), SAMPLED_GRID_MAPPING_VERSION),
        "default_coverage_id": default_coverage_id,
        "available_resolutions_km": resolutions,
        "coverage_areas": coverages,
        "source_fields": row_fields,
        "request_fields": request_fields,
        "extension_fields": deepcopy(_mapping(sampled_grid.get("extension_fields"))),
        "geometry": deepcopy(_mapping(sampled_grid.get("geometry"))),
        "alignment": deepcopy(_mapping(sampled_grid.get("alignment"))),
        "query": query,
        "source_parameters": source_parameters,
        "resolution_policy": deepcopy(_mapping(sampled_grid.get("resolution_policy"))),
        "snapshot_cache": deepcopy(_mapping(sampled_grid.get("snapshot_cache"))),
        "value_domain": value_domain,
        "visualization": deepcopy(_mapping(sampled_grid.get("visualization"))),
        "zero_is_data": bool(sampled_grid.get("zero_is_data", True)),
    }
    grid_profile = grid_registry.register(descriptor)
    descriptor["grid_profile"] = grid_profile.as_contract()
    display_columns = [
        "date",
        "cell_id",
        "lat",
        "lon",
        "value",
        "resolution_km",
        "coverage_ratio",
        "data_status",
        *descriptor["extension_fields"].keys(),
    ]
    backend = _mapping(route_config.get("backend"))
    dataset = {
        "dataset_id": dataset_id,
        "label": label,
        "backend": "sampled_grid_http",
        "source_backend": _text(backend.get("kind"), "endpoint"),
        "connection_ref": _text(mapping.get("connection_ref"), _text(route_config.get("name"), "endpoint")),
        "data_layer": layer_id,
        "time_column": "date",
        "id_column": "cell_id",
        "lat_column": "lat",
        "lon_column": "lon",
        "display_columns": display_columns,
        "metric_columns": ["value"],
        "category_columns": ["data_status"],
        "canonical_roles": deepcopy(SAMPLED_GRID_CANONICAL_ROLES),
        "sampled_grid": descriptor,
        "grid_profile_id": grid_profile.profile_id,
        "endpoint_source": deepcopy(route_config),
        "__runtime_source": "mapping_controller_contract",
        "__runtime_contract_group": "mapping",
        "__runtime_source_route_group": source_route_group,
        "__runtime_mapping_id": mapping.get("mapping_id"),
        "__runtime_config_path": LAYER_MAPPINGS_CONFIG_REF,
        "__runtime_source_config_path": config_ref,
    }
    return dataset_id, dataset


def endpoint_datasets_from_routes(
    active_routes: list[tuple[str, Any, dict[str, Any]]],
    *,
    source_route_group: str = "endpoint",
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    datasets: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    grid_registry = GridRegistry()
    for config_ref, _path, route_config in active_routes:
        for mapping in sampled_grid_catalog_mappings(config_ref):
            sampled_grid = _catalog_mapping(mapping)
            if sampled_grid is None:
                continue
            catalog_mapping = _mapping(sampled_grid.get("catalog"))
            try:
                client = EndpointHttpClient.from_config(route_config)
                configured_path = _text(catalog_mapping.get("path"))
                if configured_path:
                    _path, catalog_body = configured_path, client.get_json(configured_path)
                else:
                    _path, catalog_body = client.first_json(client.target.catalog_paths)
                layer_items = _list(value_at(catalog_body, catalog_mapping.get("layers_path")))
                if not layer_items:
                    raise ValueError("mapping catalog layers_path did not resolve to a non-empty list")
                for item in layer_items:
                    if not isinstance(item, dict):
                        continue
                    generated = _dataset_from_catalog_item(
                        config_ref=config_ref,
                        route_config=route_config,
                        mapping=mapping,
                        sampled_grid=sampled_grid,
                        catalog_body=catalog_body,
                        item=item,
                        source_route_group=source_route_group,
                        grid_registry=grid_registry,
                    )
                    if generated is not None:
                        dataset_id, dataset = generated
                        datasets[dataset_id] = dataset
            except (EndpointRequestError, ValueError) as exc:
                errors.append(
                    {
                        "config_path": config_ref,
                        "mapping_id": mapping.get("mapping_id"),
                        "error": str(exc),
                    }
                )
    return datasets, errors


def endpoint_layer_contracts(datasets: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    contracts: list[dict[str, Any]] = []
    for dataset_id, dataset in datasets.items():
        descriptor = _mapping(dataset.get("sampled_grid"))
        source_route_group = _text(dataset.get("__runtime_source_route_group"), "endpoint")
        canonical_roles = deepcopy(
            _mapping(dataset.get("canonical_roles")) or SAMPLED_GRID_CANONICAL_ROLES
        )
        canonical_roles.setdefault("bounds", "bounds")
        contracts.append(
            {
                "contract_version": "rrkal.layer_contract.v1",
                "contract_source": "mapping_controller_contract",
                "contract_group": "mapping",
                "contract_status": "active",
                "config_path": LAYER_MAPPINGS_CONFIG_REF,
                "source_route_group": source_route_group,
                "source_config_path": dataset.get("__runtime_source_config_path"),
                "source_ref": dataset_id,
                "source_label": dataset.get("label") or dataset_id,
                "layer_id": dataset.get("data_layer") or dataset_id,
                "dataset_id": dataset_id,
                "label": dataset.get("label") or dataset_id,
                "backend": dataset.get("backend"),
                "connection_ref": dataset.get("connection_ref"),
                "detail": f"{source_route_group.upper()} {dataset.get('connection_ref') or '-'}",
                "mapping": {
                    "canonical_roles": canonical_roles,
                    "sampled_grid": {
                        "contract_version": descriptor.get("contract_version"),
                        "grid_profile": descriptor.get("grid_profile") or {},
                        "default_coverage_id": descriptor.get("default_coverage_id"),
                        "available_resolutions_km": descriptor.get("available_resolutions_km") or [],
                        "coverage_areas": descriptor.get("coverage_areas") or [],
                        "alignment": descriptor.get("alignment") or {},
                        "geometry": descriptor.get("geometry") or {},
                        "value_domain": descriptor.get("value_domain") or {},
                        "snapshot_cache": descriptor.get("snapshot_cache") or {},
                        "visualization": descriptor.get("visualization") or {},
                    },
                },
                "capabilities": {
                    "relational_query": False,
                    "schema_inspection": True,
                    "mapping_controller": True,
                    "sampled_grid": True,
                    "viewport_lod": True,
                    "time_series": bool(_mapping(descriptor.get("query")).get("time_series")),
                },
            }
        )
    return contracts
