from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any


DATASET_CACHE_NAMESPACE_VERSION = "rrkal.dataset_cache.v1"
QUERY_TRANSPORT_KEY_VERSION = "rrkal.query_transport.v1"


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _canonical(nested)
            for key, nested in sorted(value.items(), key=lambda item: str(item[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, set):
        return sorted((_canonical(item) for item in value), key=repr)
    if isinstance(value, Decimal):
        return str(value.normalize())
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _endpoint_location(dataset: dict[str, Any]) -> dict[str, Any]:
    route = _mapping(dataset.get("endpoint_source"))
    endpoint = _mapping(route.get("endpoint"))
    return {
        key: endpoint.get(key)
        for key in ("base_url", "scheme", "host", "port", "base_path")
        if endpoint.get(key) not in (None, "")
    }


def dataset_contract_identity(dataset: dict[str, Any]) -> dict[str, Any]:
    """Return only fields that determine canonical query results.

    Credentials, visualization settings, cache budgets, and other operational
    values are deliberately excluded. A mapping or source-route change creates
    a new namespace without leaking secrets into cache keys or API responses.
    """

    sampled_grid = _mapping(dataset.get("sampled_grid"))
    grid_profile = _mapping(sampled_grid.get("grid_profile"))
    return {
        "version": DATASET_CACHE_NAMESPACE_VERSION,
        "dataset": {
            "id": dataset.get("dataset_id") or dataset.get("data_layer") or dataset.get("layer_id"),
            "layer": dataset.get("data_layer") or dataset.get("layer_id"),
            "backend": dataset.get("backend"),
            "source_backend": dataset.get("source_backend"),
            "connection_ref": dataset.get("connection_ref"),
            "database": dataset.get("database"),
            "table": dataset.get("table") or dataset.get("mysql_table"),
            "mapping_id": dataset.get("__runtime_mapping_id"),
            "source_config": dataset.get("__runtime_source_config_path"),
            "source_route_group": dataset.get("__runtime_source_route_group"),
        },
        "columns": {
            "time": dataset.get("time_column"),
            "id": dataset.get("id_column"),
            "lat": dataset.get("lat_column"),
            "lon": dataset.get("lon_column"),
            "display": list(dataset.get("display_columns") or []),
            "metrics": list(dataset.get("metric_columns") or []),
            "categories": list(dataset.get("category_columns") or []),
        },
        "sampled_grid": {
            "contract_version": sampled_grid.get("contract_version"),
            "mapping_version": sampled_grid.get("mapping_version"),
            "source_fields": _mapping(sampled_grid.get("source_fields")),
            "request_fields": _mapping(sampled_grid.get("request_fields")),
            "extension_fields": _mapping(sampled_grid.get("extension_fields")),
            "status_semantics": _mapping(sampled_grid.get("status_semantics")),
            "geometry": _mapping(sampled_grid.get("geometry")),
            "alignment": _mapping(sampled_grid.get("alignment")),
            "cell_identity": _mapping(sampled_grid.get("cell_identity")),
            "available_resolutions_km": list(sampled_grid.get("available_resolutions_km") or []),
            "source_parameters": _mapping(sampled_grid.get("source_parameters")),
            "query": _mapping(sampled_grid.get("query")),
            "grid_profile": {
                "profile_id": grid_profile.get("profile_id"),
                "signature": grid_profile.get("signature"),
                "signature_version": grid_profile.get("signature_version"),
            },
            "zero_is_data": bool(sampled_grid.get("zero_is_data", True)),
        },
        "endpoint": _endpoint_location(dataset),
    }


def dataset_contract_fingerprint(dataset: dict[str, Any]) -> str:
    payload = json.dumps(
        _canonical(dataset_contract_identity(dataset)),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def dataset_cache_namespace(dataset: dict[str, Any]) -> str:
    return f"{DATASET_CACHE_NAMESPACE_VERSION}:{dataset_contract_fingerprint(dataset)[:24]}"


def dataset_query_transport_identity(dataset: dict[str, Any]) -> dict[str, Any]:
    """Return the physical provider identity used to serialize query transport.

    Dataset and metric identities are deliberately excluded so datasets backed by
    the same provider can share one batch lane. Credentials are never included.
    """

    return {
        "version": QUERY_TRANSPORT_KEY_VERSION,
        "source_route_group": dataset.get("__runtime_source_route_group"),
        "source_config": dataset.get("__runtime_source_config_path"),
        "connection_ref": dataset.get("connection_ref"),
        "backend": dataset.get("backend"),
        "source_backend": dataset.get("source_backend"),
        "endpoint": _endpoint_location(dataset),
    }


def dataset_query_transport_key(dataset: dict[str, Any]) -> str:
    payload = json.dumps(
        _canonical(dataset_query_transport_identity(dataset)),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    )
    fingerprint = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"{QUERY_TRANSPORT_KEY_VERSION}:{fingerprint[:24]}"
