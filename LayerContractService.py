from __future__ import annotations

from typing import Any

from DeveloperConfigService import load_layer_mappings, spatial_status_from_config


LAYER_CONTRACT_VERSION = "rrkal.layer_contract.v1"


def _text(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _layer_label(layer_id: str, fallback: str = "") -> str:
    labels = {
        "gfw": "GFW 漁業活動",
        "ais": "AIS 船舶動態",
        "eez": "EEZ 經濟海域",
    }
    return labels.get(layer_id, fallback or layer_id)


def _database_contracts(active_routes: list[tuple[str, Any, dict[str, Any]]]) -> list[dict[str, Any]]:
    contracts: list[dict[str, Any]] = []
    for config_ref, _path, route_config in active_routes:
        datasets = route_config.get("datasets") if isinstance(route_config.get("datasets"), dict) else {}
        for dataset_id, dataset in datasets.items():
            if not isinstance(dataset, dict):
                continue
            layer_id = _text(dataset.get("data_layer") or dataset.get("layer_id") or "gfw").lower()
            table_ref = _text(dataset.get("mysql_table") or dataset.get("table"))
            connection_ref = _text(dataset.get("connection_ref") or route_config.get("default_connection_ref"), "local_mysql")
            label = _text(dataset.get("label"), str(dataset_id))
            contracts.append(
                {
                    "contract_version": LAYER_CONTRACT_VERSION,
                    "contract_source": "legacy_dataset_contract",
                    "contract_status": "active",
                    "route_group": "database",
                    "config_path": config_ref,
                    "source_ref": str(dataset_id),
                    "source_label": label,
                    "layer_id": layer_id,
                    "label": _layer_label(layer_id, label),
                    "backend": _text(route_config.get("sql_backend", {}).get("kind"), "mysql"),
                    "connection_ref": connection_ref,
                    "table_ref": table_ref,
                    "detail": f"{connection_ref} / {table_ref or '-'}",
                    "mapping": {
                        "time_column": dataset.get("time_column"),
                        "lat_column": dataset.get("lat_column"),
                        "lon_column": dataset.get("lon_column"),
                        "id_column": dataset.get("id_column"),
                        "display_columns": dataset.get("display_columns") or [],
                        "metric_columns": dataset.get("metric_columns") or [],
                        "category_columns": dataset.get("category_columns") or [],
                    },
                    "capabilities": {
                        "relational_query": True,
                        "schema_inspection": True,
                        "manual_mapping": False,
                    },
                }
            )
    return contracts


def _mapping_contracts() -> list[dict[str, Any]]:
    contracts: list[dict[str, Any]] = []
    for mapping in load_layer_mappings().get("mappings", []):
        if not mapping.get("enabled", True):
            continue
        layer_id = _text(mapping.get("layer_id")).lower()
        roles = mapping.get("roles") if isinstance(mapping.get("roles"), dict) else {}
        table_ref = _text(mapping.get("table"))
        connection_ref = _text(mapping.get("connection_ref"), "local_mysql")
        label = _text(mapping.get("label"), layer_id or table_ref)
        contracts.append(
            {
                "contract_version": LAYER_CONTRACT_VERSION,
                "contract_source": "manual_mapping_contract",
                "contract_status": "active",
                "route_group": "database",
                "config_path": _text(mapping.get("config_path")),
                "source_ref": _text(mapping.get("mapping_id")),
                "source_label": label,
                "layer_id": layer_id,
                "label": _layer_label(layer_id, label),
                "backend": _text(mapping.get("backend"), "mysql"),
                "connection_ref": connection_ref,
                "table_ref": table_ref,
                "detail": f"{connection_ref} / {table_ref or '-'}",
                "mapping": {
                    "time_column": roles.get("time"),
                    "lat_column": roles.get("lat"),
                    "lon_column": roles.get("lon"),
                    "id_column": roles.get("id"),
                    "selected_columns": mapping.get("selected_columns") or [],
                    "display_columns": mapping.get("display_columns") or [],
                    "metric_columns": mapping.get("metric_columns") or [],
                    "category_columns": mapping.get("category_columns") or [],
                },
                "capabilities": {
                    "relational_query": True,
                    "schema_inspection": True,
                    "manual_mapping": True,
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
        contracts.append(
            {
                "contract_version": LAYER_CONTRACT_VERSION,
                "contract_source": "websocket_route_contract",
                "contract_status": "active",
                "route_group": "websocket",
                "config_path": config_ref,
                "source_ref": str(provider),
                "source_label": "AIS WebSocket",
                "layer_id": "ais",
                "label": _layer_label("ais"),
                "backend": "websocket",
                "detail": str(endpoint),
                "mapping": {},
                "capabilities": {
                    "relational_query": False,
                    "schema_inspection": False,
                    "manual_mapping": False,
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
                    "contract_status": "active",
                    "route_group": "spatial",
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
                        "manual_mapping": False,
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
        *_database_contracts(database_routes),
        *_mapping_contracts(),
        *_websocket_contracts(websocket_routes),
        *_spatial_contracts(spatial_routes),
    ]
    layer_order = {"gfw": 0, "ais": 1, "eez": 2}
    source_order = {
        "manual_mapping_contract": 0,
        "legacy_dataset_contract": 1,
        "websocket_route_contract": 2,
        "spatial_route_contract": 3,
    }
    return sorted(
        contracts,
        key=lambda row: (
            layer_order.get(str(row.get("layer_id")), 99),
            str(row.get("layer_id")),
            source_order.get(str(row.get("contract_source")), 99),
            str(row.get("config_path")),
            str(row.get("source_ref")),
        ),
    )
