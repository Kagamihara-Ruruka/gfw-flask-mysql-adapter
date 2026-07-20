from __future__ import annotations

from copy import deepcopy
from typing import Any

from common_adapter.developer.config_service import load_layer_mappings, spatial_status_from_config
from common_adapter.layers.capabilities import (
    eez_high_seas_overlay_capability,
    eez_land_mask_provider_capability,
    land_mask_consumer_capability,
    spatial_interpolation_capability,
)
from common_adapter.query.grid_registry import grid_profile_contract
from common_adapter.query.sampled_grid import sampled_grid_available_resolutions


LAYER_CONTRACT_VERSION = "rrkal.layer_contract.v1"
LAYER_MAPPINGS_CONFIG_REF = "config/artifacts/layer_mappings.local.json"


def _text(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _layer_label(layer_id: str, fallback: str = "") -> str:
    return fallback or layer_id.upper()


def _mapping_contracts(database_routes: list[tuple[str, Any, dict[str, Any]]]) -> list[dict[str, Any]]:
    contracts: list[dict[str, Any]] = []
    active_config_refs = {str(config_ref) for config_ref, _path, _route in database_routes}
    for mapping in load_layer_mappings().get("mappings", []):
        if not mapping.get("enabled", True):
            continue
        if str(mapping.get("config_path") or "") not in active_config_refs:
            continue
        sampled_grid = deepcopy(mapping.get("sampled_grid")) if isinstance(mapping.get("sampled_grid"), dict) else None
        if sampled_grid and isinstance(sampled_grid.get("catalog"), dict):
            continue
        if sampled_grid:
            sampled_grid["grid_profile"] = grid_profile_contract(sampled_grid)
        layer_id = _text(mapping.get("layer_id")).lower()
        roles = mapping.get("roles") if isinstance(mapping.get("roles"), dict) else {}
        table_ref = _text(mapping.get("table"))
        connection_ref = _text(mapping.get("connection_ref"), "local_mysql")
        label = _text(mapping.get("label"), layer_id or table_ref)
        contracts.append(
            {
                "contract_version": LAYER_CONTRACT_VERSION,
                "contract_source": "mapping_controller_contract",
                "contract_group": "mapping",
                "contract_status": "active",
                "config_path": LAYER_MAPPINGS_CONFIG_REF,
                "source_route_group": "database",
                "source_config_path": _text(mapping.get("config_path")),
                "source_ref": _text(mapping.get("mapping_id")),
                "source_label": label,
                "layer_id": layer_id,
                "label": _layer_label(layer_id, label),
                "backend": _text(mapping.get("backend"), "mysql"),
                "connection_ref": connection_ref,
                "table_ref": table_ref,
                "detail": f"DATABASE {connection_ref} / {table_ref or '-'}",
                "mapping": {
                    "time_column": roles.get("time"),
                    "lat_column": roles.get("lat"),
                    "lon_column": roles.get("lon"),
                    "id_column": roles.get("id"),
                    "selected_columns": mapping.get("selected_columns") or [],
                    "display_columns": mapping.get("display_columns") or [],
                    "metric_columns": mapping.get("metric_columns") or [],
                    "category_columns": mapping.get("category_columns") or [],
                    "sampled_grid": sampled_grid or {},
                },
                "capabilities": {
                    "relational_query": True,
                    "schema_inspection": True,
                    "mapping_controller": True,
                    "sampled_grid": bool(sampled_grid),
                    "viewport_lod": bool(sampled_grid and sampled_grid_available_resolutions({"sampled_grid": sampled_grid})),
                    "spatial_interpolation": spatial_interpolation_capability(sampled_grid),
                    "land_mask_consumer": land_mask_consumer_capability(sampled_grid),
                },
            }
        )
    return contracts


def _websocket_contracts(active_routes: list[tuple[str, Any, dict[str, Any]]]) -> list[dict[str, Any]]:
    contracts: list[dict[str, Any]] = []
    for config_ref, _path, route_config in active_routes:
        live_ais = route_config.get("live", {}).get("ais", {}) if isinstance(route_config.get("live"), dict) else {}
        provider = route_config.get("provider") or route_config.get("stream_provider") or live_ais.get("provider") or "websocket"
        endpoint = route_config.get("stream_url") or route_config.get("endpoint") or live_ais.get("stream_url") or "-"
        connection_ref = _text(live_ais.get("connection_ref"))
        table_ref = _text(live_ais.get("table"))
        contracts.append(
            {
                "contract_version": LAYER_CONTRACT_VERSION,
                "contract_source": "websocket_route_contract",
                "contract_group": "websocket",
                "contract_status": "active",
                "route_group": "websocket",
                "source_route_group": "websocket",
                "source_config_path": config_ref,
                "config_path": config_ref,
                "source_ref": str(provider),
                "source_label": "AISStream WebSocket",
                "layer_id": "ais",
                "label": _layer_label("ais"),
                "backend": "mysql",
                "source_backend": "websocket",
                "connection_ref": connection_ref,
                "table_ref": table_ref,
                "detail": f"{endpoint} -> MYSQL {connection_ref} / {table_ref}",
                "mapping": {},
                "capabilities": {
                    "relational_query": True,
                    "schema_inspection": False,
                    "mapping_controller": False,
                    "delta_ingest": True,
                    "sql_read_model": True,
                    "spatial_interpolation": spatial_interpolation_capability(None),
                },
            }
        )
    return contracts


def _spatial_contracts(active_routes: list[tuple[str, Any, dict[str, Any]]]) -> list[dict[str, Any]]:
    contracts: list[dict[str, Any]] = []
    for config_ref, _path, route_config in active_routes:
        for row in spatial_status_from_config(config_ref, route_config):
            overlay_ref = _text(row.get("overlay_ref")).lower()
            if not overlay_ref:
                continue
            contracts.append(
                {
                    "contract_version": LAYER_CONTRACT_VERSION,
                    "contract_source": "spatial_route_contract",
                    "contract_group": "spatial",
                    "contract_status": "active",
                    "route_group": "spatial",
                    "source_route_group": "spatial",
                    "source_config_path": config_ref,
                    "config_path": config_ref,
                    "source_ref": overlay_ref,
                    "source_label": "PostGIS 空間圖層",
                    "layer_id": overlay_ref,
                    "label": _layer_label(overlay_ref),
                    "backend": _text(row.get("backend"), "postgis"),
                    "detail": str(row.get("tables") or row.get("detail") or "-"),
                    "mapping": {},
                    "capabilities": {
                        "relational_query": False,
                        "schema_inspection": False,
                        "mapping_controller": False,
                        "spatial_interpolation": spatial_interpolation_capability(None),
                        "land_mask_provider": eez_land_mask_provider_capability(route_config, overlay_ref),
                        "high_seas_overlay": eez_high_seas_overlay_capability(route_config, overlay_ref),
                    },
                }
            )
    return contracts


def build_layer_contracts(
    *,
    database_routes: list[tuple[str, Any, dict[str, Any]]],
    websocket_routes: list[tuple[str, Any, dict[str, Any]]],
    spatial_routes: list[tuple[str, Any, dict[str, Any]]],
) -> list[dict[str, Any]]:
    contracts = [
        *_mapping_contracts(database_routes),
        *_websocket_contracts(websocket_routes),
        *_spatial_contracts(spatial_routes),
    ]
    source_order = {
        "mapping_controller_contract": 0,
        "websocket_route_contract": 2,
        "spatial_route_contract": 3,
    }
    return sorted(
        contracts,
        key=lambda row: (
            source_order.get(str(row.get("contract_source")), 99),
            str(row.get("layer_id")),
            str(row.get("config_path")),
            str(row.get("source_ref")),
        ),
    )
