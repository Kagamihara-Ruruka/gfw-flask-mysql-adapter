from __future__ import annotations

from typing import Any

from common_adapter.db.connect import validate_identifier
from common_adapter.developer.config_service import load_layer_mappings, load_router_manifest, normalize_imported_layers


LAYER_MAPPINGS_CONFIG_REF = "config/artifacts/layer_mappings.local.json"


def dataset_layer_id(dataset_id: str, dataset: dict[str, Any]) -> str:
    configured = str(dataset.get("data_layer") or dataset.get("layer_id") or "").strip().lower()
    if configured:
        return configured
    if dataset_id.lower().startswith("gfw"):
        return "gfw"
    return dataset_id.strip().lower()


def imported_layer_ids() -> set[str]:
    manifest = load_router_manifest()
    return set(normalize_imported_layers(manifest.get("imported_layers")))


def is_layer_imported(layer_id: str) -> bool:
    layer = str(layer_id or "").strip().lower()
    return layer in imported_layer_ids()


def _mapping_selected_columns(mapping: dict[str, Any]) -> list[str]:
    columns: list[str] = []
    for column in mapping.get("selected_columns") or []:
        if column and column not in columns:
            columns.append(column)
    roles = mapping.get("roles") if isinstance(mapping.get("roles"), dict) else {}
    for role in ("time", "id", "lat", "lon"):
        column = roles.get(role)
        if column and column not in columns:
            columns.append(column)
    for key in ("display_columns", "metric_columns", "category_columns"):
        for column in mapping.get(key) or []:
            if column and column not in columns:
                columns.append(column)
    return columns


def _dataset_from_mapping(mapping: dict[str, Any], fallback_dataset: dict[str, Any]) -> dict[str, Any]:
    roles = mapping.get("roles") if isinstance(mapping.get("roles"), dict) else {}
    time_column = validate_identifier(roles.get("time"), "mapping time_column")
    lat_column = validate_identifier(roles.get("lat"), "mapping lat_column")
    lon_column = validate_identifier(roles.get("lon"), "mapping lon_column")
    table = validate_identifier(mapping.get("table"), "mapping table")
    selected_columns = _mapping_selected_columns(mapping)
    if not selected_columns:
        selected_columns = [time_column, lat_column, lon_column]
    for column in selected_columns:
        validate_identifier(column, "mapping selected column")

    runtime = dict(fallback_dataset)
    runtime.update(
        {
            "label": mapping.get("label") or fallback_dataset.get("label") or mapping.get("layer_id"),
            "backend": mapping.get("backend") or fallback_dataset.get("backend") or "mysql",
            "connection_ref": mapping.get("connection_ref") or fallback_dataset.get("connection_ref"),
            "database": mapping.get("database") or fallback_dataset.get("database"),
            "table": table,
            "mysql_table": table,
            "time_column": time_column,
            "lat_column": lat_column,
            "lon_column": lon_column,
            "id_column": roles.get("id") or fallback_dataset.get("id_column"),
            "display_columns": selected_columns,
            "metric_columns": mapping.get("metric_columns") or [],
            "category_columns": mapping.get("category_columns") or [],
            "data_layer": mapping.get("layer_id"),
            "__runtime_source": "mapping_controller_contract",
            "__runtime_contract_group": "mapping",
            "__runtime_source_route_group": "database",
            "__runtime_mapping_id": mapping.get("mapping_id"),
            "__runtime_config_path": LAYER_MAPPINGS_CONFIG_REF,
            "__runtime_source_config_path": mapping.get("config_path"),
        }
    )
    return runtime


def active_mapping_for_layer(layer_id: str) -> dict[str, Any] | None:
    layer = str(layer_id or "").strip().lower()
    manifest = load_router_manifest()
    imported_layers = set(normalize_imported_layers(manifest.get("imported_layers")))
    if layer not in imported_layers:
        return None
    active_configs = set(str(item) for item in manifest.get("active_configs") or [])
    candidates: list[dict[str, Any]] = []
    for mapping in load_layer_mappings().get("mappings", []):
        if not mapping.get("enabled", True):
            continue
        if str(mapping.get("layer_id") or "").strip().lower() != layer:
            continue
        config_path = str(mapping.get("config_path") or "")
        if active_configs and config_path and config_path not in active_configs:
            continue
        candidates.append(mapping)
    return sorted(candidates, key=lambda row: str(row.get("mapping_id") or ""))[0] if candidates else None


def resolve_runtime_dataset(
    config: dict[str, Any],
    dataset_id: str,
    dataset: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    base_dataset = dict(dataset or config["datasets"][dataset_id])
    layer_id = dataset_layer_id(dataset_id, base_dataset)
    mapping = active_mapping_for_layer(layer_id)
    if not mapping:
        return base_dataset, {
            "layer_id": layer_id,
            "source": "unmapped_database_route",
            "contract_group": None,
            "source_route_group": "database",
            "mapping_id": None,
            "config_path": None,
            "source_config_path": None,
        }
    runtime_dataset = _dataset_from_mapping(mapping, base_dataset)
    return runtime_dataset, {
        "layer_id": layer_id,
        "source": "mapping_controller_contract",
        "contract_group": "mapping",
        "source_route_group": "database",
        "mapping_id": mapping.get("mapping_id"),
        "config_path": LAYER_MAPPINGS_CONFIG_REF,
        "source_config_path": mapping.get("config_path"),
    }
