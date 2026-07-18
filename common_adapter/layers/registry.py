from __future__ import annotations

import time
from copy import deepcopy
from threading import RLock
from typing import Any, Callable

from common_adapter.developer.config_service import load_layer_mappings
from common_adapter.endpoint.runtime import endpoint_datasets_from_routes
from common_adapter.layers.runtime import (
    active_config_files_by_group,
    active_layer_contract_rows,
    database_datasets_from_mappings,
    dataset_layer_id,
    imported_layer_ids,
)
from common_adapter.query.identity import dataset_query_transport_key


class RuntimeLayerRegistry:
    """Owns the materialized layer registry shared by consumer and developer APIs."""

    def __init__(
        self,
        config: dict[str, Any],
        *,
        refresh_ttl_seconds: float = 0.5,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        self.refresh_ttl_seconds = max(0.0, float(refresh_ttl_seconds))
        self.monotonic = monotonic
        self._lock = RLock()
        self._last_refresh = float("-inf")
        self._invalidated = True
        self._generation = 0
        self._known_layers: dict[str, dict[str, Any]] = {}
        self._snapshot: dict[str, Any] = {
            "generation": 0,
            "datasets": {},
            "layers": [],
            "imported_layers": [],
            "source_errors": [],
        }

    def invalidate(self) -> None:
        with self._lock:
            self._invalidated = True
            self._last_refresh = float("-inf")

    def snapshot(
        self,
        *,
        force: bool = False,
        refresh_if_expired: bool = True,
    ) -> dict[str, Any]:
        with self._lock:
            now = self.monotonic()
            expired = now - self._last_refresh >= self.refresh_ttl_seconds
            if (
                force
                or self._invalidated
                or self._generation == 0
                or (refresh_if_expired and expired)
            ):
                self._snapshot = self._build_snapshot()
                self._generation += 1
                self._snapshot["generation"] = self._generation
                self._last_refresh = now
                self._invalidated = False
            return deepcopy(self._snapshot)

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        # Frame queries consume the materialized registry. Discovery belongs to
        # explicit catalog refreshes and developer invalidation, not every HTTP frame.
        with self._lock:
            requires_refresh = self._generation == 0 or self._invalidated
            snapshot = deepcopy(self._snapshot) if not requires_refresh else None
        if snapshot is None:
            snapshot = self.snapshot()
        dataset = snapshot["datasets"].get(dataset_id)
        if dataset is None:
            dataset = self.snapshot(force=True)["datasets"].get(dataset_id)
        return deepcopy(dataset) if dataset is not None else None

    def _build_snapshot(self) -> dict[str, Any]:
        database_datasets, database_errors = database_datasets_from_mappings(self.config)
        endpoint_datasets, endpoint_errors = endpoint_datasets_from_routes(
            active_config_files_by_group("database", self.config),
            source_route_group="database",
        )
        routed_endpoint_datasets, routed_endpoint_errors = endpoint_datasets_from_routes(
            active_config_files_by_group("endpoint", self.config),
            source_route_group="endpoint",
        )
        endpoint_datasets.update(routed_endpoint_datasets)
        endpoint_errors.extend(routed_endpoint_errors)

        source_errors = [*database_errors, *endpoint_errors]
        contracts = active_layer_contract_rows(
            self.config,
            endpoint_datasets=endpoint_datasets,
        )
        requested_layers = imported_layer_ids()
        datasets = {**database_datasets, **endpoint_datasets}
        for dataset_id, dataset in datasets.items():
            dataset.setdefault("dataset_id", dataset_id)
            dataset["__runtime_query_transport_key"] = dataset_query_transport_key(dataset)
        materialized_dataset_layers = {
            dataset_layer_id(dataset_id, dataset)
            for dataset_id, dataset in datasets.items()
        }

        actual_layers: dict[str, dict[str, Any]] = {}
        for contract in contracts:
            layer_id = str(contract.get("layer_id") or "").strip().lower()
            if not layer_id or layer_id in actual_layers:
                continue
            requested = layer_id in requested_layers
            row = {
                **contract,
                "layer_id": layer_id,
                "imported": requested,
                "import_requested": requested,
                "registered": requested,
                "materialized": True,
                "dataset_materialized": layer_id in materialized_dataset_layers,
                "available": True,
                "runtime_status": "ready" if requested else "not_imported",
                "availability_error": None,
            }
            actual_layers[layer_id] = row
            self._known_layers[layer_id] = deepcopy(row)

        for layer_id in sorted(requested_layers - set(actual_layers)):
            actual_layers[layer_id] = self._unavailable_layer_row(layer_id, source_errors)

        registered_datasets = {
            dataset_id: dataset
            for dataset_id, dataset in datasets.items()
            if dataset_layer_id(dataset_id, dataset) in requested_layers
        }
        return {
            "generation": self._generation,
            "datasets": registered_datasets,
            "layers": sorted(actual_layers.values(), key=lambda row: str(row.get("layer_id") or "")),
            "imported_layers": sorted(requested_layers),
            "source_errors": source_errors,
        }

    def _unavailable_layer_row(
        self,
        layer_id: str,
        source_errors: list[dict[str, Any]],
    ) -> dict[str, Any]:
        known = deepcopy(self._known_layers.get(layer_id) or {})
        mapping = self._mapping_for_declared_layer(layer_id)
        config_path = str(
            known.get("source_config_path")
            or mapping.get("config_path")
            or ""
        )
        mapping_id = str(known.get("mapping_id") or mapping.get("mapping_id") or "")
        source_error = next(
            (
                error
                for error in source_errors
                if (mapping_id and str(error.get("mapping_id") or "") == mapping_id)
                or (config_path and str(error.get("config_path") or "") == config_path)
            ),
            None,
        )
        error_text = str((source_error or {}).get("error") or "").strip()
        status = "source_unavailable" if error_text else "awaiting_materialization"
        label = str(
            known.get("label")
            or mapping.get("label")
            or layer_id.rsplit(".", 1)[-1].replace("_", " ")
        )
        return {
            **known,
            "contract_version": known.get("contract_version") or "rrkal.layer_contract.v1",
            "contract_source": known.get("contract_source") or "registry_declaration",
            "contract_group": known.get("contract_group") or "mapping",
            "contract_status": "unavailable",
            "config_path": known.get("config_path") or "config/artifacts/layer_mappings.local.json",
            "source_config_path": config_path or None,
            "source_route_group": known.get("source_route_group") or "database",
            "source_ref": known.get("source_ref") or layer_id,
            "source_label": known.get("source_label") or label,
            "layer_id": layer_id,
            "dataset_id": known.get("dataset_id") or layer_id,
            "label": label,
            "backend": known.get("backend") or mapping.get("backend"),
            "connection_ref": known.get("connection_ref") or mapping.get("connection_ref"),
            "mapping_id": mapping_id or None,
            "detail": error_text or "Layer is registered but its runtime contract is not materialized.",
            "imported": True,
            "import_requested": True,
            "registered": True,
            "materialized": False,
            "dataset_materialized": False,
            "available": False,
            "runtime_status": status,
            "availability_error": source_error,
        }

    @staticmethod
    def _mapping_for_declared_layer(layer_id: str) -> dict[str, Any]:
        candidates: list[dict[str, Any]] = []
        for mapping in load_layer_mappings().get("mappings", []):
            if not mapping.get("enabled", True):
                continue
            prefix = str(mapping.get("layer_id") or "").strip().lower()
            if not prefix:
                continue
            sampled_grid = mapping.get("sampled_grid")
            catalog = sampled_grid.get("catalog") if isinstance(sampled_grid, dict) else None
            if layer_id == prefix or (isinstance(catalog, dict) and layer_id.startswith(f"{prefix}.")):
                candidates.append(mapping)
        return min(candidates, key=lambda row: str(row.get("mapping_id") or ""), default={})
