from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from common_adapter.db.connect import dataset_backend_info, validate_identifier
from common_adapter.developer.config_service import (
    discover_config_files,
    has_builtin_probe,
    load_layer_mappings,
    load_router_manifest,
    normalize_config_ref,
    normalize_imported_layers,
    read_config_json,
    resolve_config_ref,
    summarize_config_file,
)
from common_adapter.layers.contracts import build_layer_contracts


LAYER_MAPPINGS_CONFIG_REF = "config/artifacts/layer_mappings.local.json"


def dataset_layer_id(dataset_id: str, dataset: dict[str, Any]) -> str:
    configured = str(dataset.get("data_layer") or dataset.get("layer_id") or "").strip().lower()
    if configured:
        return configured
    return dataset_id.strip().lower()


def imported_layer_ids() -> set[str]:
    manifest = load_router_manifest()
    return set(normalize_imported_layers(manifest.get("imported_layers")))


def runtime_config_ref(runtime_config: dict[str, Any] | None) -> str | None:
    if not runtime_config:
        return None
    config_path = runtime_config.get("__config_path")
    if not config_path:
        return None
    try:
        ref = normalize_config_ref(str(config_path))
        path = resolve_config_ref(ref)
    except Exception:
        return None
    return ref if path.exists() else None


def runtime_config_refs(runtime_config: dict[str, Any] | None) -> set[str]:
    ref = runtime_config_ref(runtime_config)
    return {ref} if ref else set()


def active_refs_with_runtime(runtime_config: dict[str, Any] | None) -> set[str]:
    return set(load_router_manifest()["active_configs"])


def locked_refs_with_runtime(runtime_config: dict[str, Any] | None) -> set[str]:
    return set(load_router_manifest()["locked_configs"]) | runtime_config_refs(runtime_config)


def config_paths_with_runtime(runtime_config: dict[str, Any] | None) -> list[Path]:
    return sorted({path.resolve() for path in discover_config_files()}, key=lambda item: str(item).lower())


def config_supports_group(data: dict[str, Any], summary: dict[str, Any], group: str) -> bool:
    return str(summary.get("group") or "") == group and has_builtin_probe(group)


def active_config_files_by_group(
    group: str,
    runtime_config: dict[str, Any] | None = None,
) -> list[tuple[str, Path, dict[str, Any]]]:
    active_refs = active_refs_with_runtime(runtime_config)
    locked_refs = locked_refs_with_runtime(runtime_config)
    runtime_refs = runtime_config_refs(runtime_config)
    rows: list[tuple[str, Path, dict[str, Any]]] = []
    for path in config_paths_with_runtime(runtime_config):
        ref = normalize_config_ref(path)
        if ref not in active_refs:
            continue
        summary = summarize_config_file(path, active_refs, locked_refs, runtime_refs)
        data, error = read_config_json(path)
        if error or data is None:
            continue
        if not config_supports_group(data, summary, group):
            continue
        rows.append((ref, path, data))
    return rows


def active_layer_contract_rows(
    runtime_config: dict[str, Any] | None = None,
    endpoint_datasets: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    imported_layers = imported_layer_ids()
    contracts = build_layer_contracts(
        database_routes=active_config_files_by_group("database", runtime_config),
        websocket_routes=active_config_files_by_group("websocket", runtime_config),
        spatial_routes=active_config_files_by_group("spatial", runtime_config),
    )
    from common_adapter.endpoint.runtime import endpoint_datasets_from_routes, endpoint_layer_contracts

    if endpoint_datasets is None:
        endpoint_datasets, _endpoint_errors = endpoint_datasets_from_routes(
            active_config_files_by_group("endpoint", runtime_config)
        )
    contracts.extend(endpoint_layer_contracts(endpoint_datasets))
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for contract in contracts:
        layer_id = str(contract.get("layer_id") or "").strip().lower()
        if not layer_id or layer_id in seen:
            continue
        seen.add(layer_id)
        rows.append({**contract, "imported": layer_id in imported_layers})
    return rows


def is_layer_imported(layer_id: str) -> bool:
    layer = str(layer_id or "").strip().lower()
    return layer in imported_layer_ids()


def _mapping_selected_columns(mapping: dict[str, Any]) -> list[str]:
    columns: list[str] = []
    for column in mapping.get("selected_columns") or []:
        if column and column not in columns:
            columns.append(column)
    roles = mapping.get("roles") if isinstance(mapping.get("roles"), dict) else {}
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
    ):
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

    sampled_grid = deepcopy(mapping.get("sampled_grid")) if isinstance(mapping.get("sampled_grid"), dict) else None
    if sampled_grid is not None:
        source_fields = sampled_grid.get("source_fields") if isinstance(sampled_grid.get("source_fields"), dict) else {}
        source_fields = {**source_fields, **roles}
        metrics = list(mapping.get("metric_columns") or [])
        if not source_fields.get("value") and len(metrics) == 1:
            source_fields["value"] = metrics[0]
        sampled_grid["source_fields"] = source_fields

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
    if sampled_grid is not None:
        runtime["sampled_grid"] = sampled_grid
    return runtime


def database_datasets_from_mappings(
    config: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Build runtime datasets from Mapping Controller artifacts, not source config schemas."""
    manifest = load_router_manifest()
    active_configs = set(str(item) for item in manifest.get("active_configs") or [])
    imported_layers = set(normalize_imported_layers(manifest.get("imported_layers")))
    datasets: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    for mapping in load_layer_mappings().get("mappings", []):
        if not mapping.get("enabled", True):
            continue
        sampled_grid = mapping.get("sampled_grid") if isinstance(mapping.get("sampled_grid"), dict) else {}
        if isinstance(sampled_grid.get("catalog"), dict):
            continue
        config_path = str(mapping.get("config_path") or "")
        if active_configs and config_path and config_path not in active_configs:
            continue
        layer_id = str(mapping.get("layer_id") or "").strip().lower()
        if layer_id not in imported_layers:
            continue
        dataset_id = str(mapping.get("dataset_id") or layer_id).strip().lower()
        try:
            if not dataset_id:
                raise ValueError("mapping dataset id is required")
            runtime_dataset = _dataset_from_mapping(mapping, {})
            dataset_backend_info(config, runtime_dataset)
            if dataset_id in datasets:
                raise ValueError(f"duplicate mapping dataset id: {dataset_id}")
            datasets[dataset_id] = runtime_dataset
        except (KeyError, TypeError, ValueError) as exc:
            errors.append(
                {
                    "config_path": config_path,
                    "mapping_id": mapping.get("mapping_id"),
                    "error": str(exc),
                }
            )
    return datasets, errors


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


def active_mapping_for_dataset(dataset: dict[str, Any]) -> dict[str, Any] | None:
    table = str(dataset.get("table") or dataset.get("mysql_table") or "").strip()
    connection_ref = str(dataset.get("connection_ref") or "").strip()
    if not table:
        return None
    manifest = load_router_manifest()
    imported_layers = set(normalize_imported_layers(manifest.get("imported_layers")))
    active_configs = set(str(item) for item in manifest.get("active_configs") or [])
    candidates: list[dict[str, Any]] = []
    for mapping in load_layer_mappings().get("mappings", []):
        if not mapping.get("enabled", True):
            continue
        if str(mapping.get("table") or "").strip() != table:
            continue
        if connection_ref and str(mapping.get("connection_ref") or "").strip() != connection_ref:
            continue
        layer_id = str(mapping.get("layer_id") or "").strip().lower()
        if layer_id not in imported_layers:
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
    mapping = active_mapping_for_dataset(base_dataset)
    layer_id = str(mapping.get("layer_id") or "").strip().lower() if mapping else dataset_layer_id(dataset_id, base_dataset)
    if mapping is None:
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
