from __future__ import annotations

import time
from typing import Any

from flask import Flask, jsonify, request

from common_adapter.db.connect import (
    dataset_backend_info,
    parse_bbox,
    query_policy,
    records_range_packet,
    records_packet,
    schema_packet,
    time_series_packet,
)
from common_adapter.endpoint.runtime import endpoint_datasets_from_routes
from common_adapter.layers.runtime import (
    active_config_files_by_group,
    active_layer_contract_rows,
    database_datasets_from_mappings,
    dataset_layer_id,
    is_layer_imported,
)
from common_adapter.spatial.overlay import elapsed_ms
from common_adapter.query.sampled_grid import (
    sampled_grid_public_contract,
    sampled_grid_public_fields,
)
from common_adapter.query.identity import dataset_cache_namespace
from common_adapter.query.snapshot_cache import CANONICAL_SNAPSHOT_CACHE


class DatasetRoutes:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        CANONICAL_SNAPSHOT_CACHE.configure(
            max_total_rows=query_policy(config)["snapshot_cache_max_rows"]
        )
        self.database_datasets: dict[str, dict[str, Any]] = {}
        self.database_errors: list[dict[str, Any]] = []
        self.endpoint_datasets: dict[str, dict[str, Any]] = {}
        self.endpoint_errors: list[dict[str, Any]] = []

    def refresh_database_datasets(self) -> dict[str, dict[str, Any]]:
        self.database_datasets, self.database_errors = database_datasets_from_mappings(self.config)
        return self.database_datasets

    def refresh_endpoint_datasets(self) -> dict[str, dict[str, Any]]:
        self.endpoint_datasets, self.endpoint_errors = endpoint_datasets_from_routes(
            active_config_files_by_group("database", self.config),
            source_route_group="database",
        )
        endpoint_route_datasets, endpoint_route_errors = endpoint_datasets_from_routes(
            active_config_files_by_group("endpoint", self.config),
            source_route_group="endpoint",
        )
        self.endpoint_datasets.update(endpoint_route_datasets)
        self.endpoint_errors.extend(endpoint_route_errors)
        return self.endpoint_datasets

    def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        if dataset_id not in self.database_datasets:
            self.refresh_database_datasets()
        dataset = self.database_datasets.get(dataset_id)
        if dataset is None:
            if dataset_id not in self.endpoint_datasets:
                self.refresh_endpoint_datasets()
            dataset = self.endpoint_datasets.get(dataset_id)
        if dataset is None:
            raise ValueError(f"unknown dataset: {dataset_id}")
        runtime = {
            "layer_id": dataset_layer_id(dataset_id, dataset),
            "source": dataset.get("__runtime_source"),
        }
        layer_id = dataset_layer_id(dataset_id, dataset)
        if not is_layer_imported(layer_id):
            raise ValueError(f"data layer is not imported: {layer_id}")
        if runtime["source"] != "mapping_controller_contract":
            raise ValueError(f"data layer has no generated mapping contract: {layer_id}")
        return dataset

    @staticmethod
    def sampled_grid_packet(dataset: dict[str, Any]) -> dict[str, Any] | None:
        return sampled_grid_public_contract(dataset)

    @staticmethod
    def query_context() -> dict[str, Any]:
        return {
            "requested_resolution_km": request.args.get("resolution"),
            "zoom": request.args.get("zoom"),
            "latitude": request.args.get("latitude"),
        }

    @staticmethod
    def runtime_packet(dataset_id: str, dataset: dict[str, Any]) -> dict[str, Any]:
        return {
            "layer_id": dataset_layer_id(dataset_id, dataset),
            "source": dataset.get("__runtime_source", "unmapped_database_route"),
            "contract_group": dataset.get("__runtime_contract_group"),
            "source_route_group": dataset.get("__runtime_source_route_group"),
            "mapping_id": dataset.get("__runtime_mapping_id"),
            "config_path": dataset.get("__runtime_config_path"),
            "source_config_path": dataset.get("__runtime_source_config_path"),
        }

    def register(self, app: Flask) -> None:
        config = self.config

        @app.get("/api/datasets")
        def datasets():
            safe = {}
            policy = query_policy(config)
            database_datasets = self.refresh_database_datasets()
            endpoint_datasets = self.refresh_endpoint_datasets()
            layer_rows = active_layer_contract_rows(config, endpoint_datasets=endpoint_datasets)
            imported_layers = {
                str(row.get("layer_id") or "").strip().lower()
                for row in layer_rows
                if row.get("imported") and str(row.get("layer_id") or "").strip()
            }
            for dataset_id, runtime_dataset in database_datasets.items():
                runtime = self.runtime_packet(dataset_id, runtime_dataset)
                if runtime["layer_id"] not in imported_layers:
                    continue
                backend_kind, connection_ref, _connection = dataset_backend_info(config, runtime_dataset)
                public_fields = sampled_grid_public_fields(runtime_dataset)
                safe[dataset_id] = {
                    "label": runtime_dataset.get("label", dataset_id),
                    "backend": backend_kind,
                    "connection_ref": connection_ref,
                    "contract_group": runtime["contract_group"],
                    "source_route_group": runtime["source_route_group"],
                    "layer_id": runtime["layer_id"],
                    "source_config": runtime_dataset.get("__runtime_source_config_path"),
                    "runtime_config": runtime["config_path"],
                    "source_config_path": runtime["source_config_path"],
                    "cache_namespace": dataset_cache_namespace(runtime_dataset),
                    **public_fields,
                    "sampled_grid": self.sampled_grid_packet(runtime_dataset),
                    "runtime": runtime,
                }
            for dataset_id, runtime_dataset in endpoint_datasets.items():
                layer_id = dataset_layer_id(dataset_id, runtime_dataset)
                if layer_id not in imported_layers:
                    continue
                public_fields = sampled_grid_public_fields(runtime_dataset)
                safe[dataset_id] = {
                    "label": runtime_dataset.get("label", dataset_id),
                    "backend": runtime_dataset.get("backend"),
                    "connection_ref": runtime_dataset.get("connection_ref"),
                    "contract_group": runtime_dataset.get("__runtime_contract_group"),
                    "source_route_group": runtime_dataset.get("__runtime_source_route_group"),
                    "layer_id": layer_id,
                    "source_config": runtime_dataset.get("__runtime_source_config_path"),
                    "runtime_config": runtime_dataset.get("__runtime_config_path"),
                    "source_config_path": runtime_dataset.get("__runtime_source_config_path"),
                    "cache_namespace": dataset_cache_namespace(runtime_dataset),
                    **public_fields,
                    "sampled_grid": self.sampled_grid_packet(runtime_dataset),
                    "runtime": self.runtime_packet(dataset_id, runtime_dataset),
                }
            return jsonify(
                {
                    "sql_backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                    "query_policy": policy,
                    "datasets": safe,
                    "imported_layers": sorted(imported_layers),
                    "layers": layer_rows,
                    "source_errors": [*self.database_errors, *self.endpoint_errors],
                }
            )

        @app.get("/api/datasets/<dataset_id>/schema")
        def schema(dataset_id: str):
            try:
                dataset = self.get_dataset(dataset_id)
                packet = schema_packet(config, dataset)
                packet["dataset_id"] = dataset_id
                packet["runtime"] = self.runtime_packet(dataset_id, dataset)
                return jsonify(packet)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/datasets/<dataset_id>/records")
        def records(dataset_id: str):
            request_start = time.perf_counter()
            try:
                dataset = self.get_dataset(dataset_id)
                packet = records_packet(
                    config,
                    dataset,
                    date_value=request.args.get("date"),
                    bbox=parse_bbox(request.args.get("bbox")),
                    limit=request.args.get("limit", query_policy(config)["default_limit"]),
                    offset=int(request.args.get("offset", "0")),
                    column_profile=request.args.get("columns"),
                    query_context=self.query_context(),
                )
                packet["dataset_id"] = dataset_id
                packet["runtime"] = self.runtime_packet(dataset_id, dataset)
                packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
                return jsonify(packet)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/datasets/<dataset_id>/records/range")
        def records_range(dataset_id: str):
            request_start = time.perf_counter()
            try:
                dataset = self.get_dataset(dataset_id)
                start_date = request.args.get("start") or request.args.get("start_date")
                end_date = request.args.get("end") or request.args.get("end_date")
                if not start_date or not end_date:
                    return jsonify({"error": "range records requires start and end"}), 400
                packet = records_range_packet(
                    config,
                    dataset,
                    start_date=start_date,
                    end_date=end_date,
                    bbox=parse_bbox(request.args.get("bbox")),
                    limit=request.args.get("limit", query_policy(config)["default_limit"]),
                    column_profile=request.args.get("columns") or "render",
                    query_context=self.query_context(),
                )
                packet["dataset_id"] = dataset_id
                packet["runtime"] = self.runtime_packet(dataset_id, dataset)
                packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
                return jsonify(packet)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/datasets/<dataset_id>/time-series")
        def time_series(dataset_id: str):
            request_start = time.perf_counter()
            try:
                dataset = self.get_dataset(dataset_id)
                start_date = request.args.get("start") or request.args.get("start_date")
                end_date = request.args.get("end") or request.args.get("end_date")
                if not start_date or not end_date:
                    return jsonify({"error": "time series requires start and end"}), 400
                packet = time_series_packet(
                    config,
                    dataset,
                    start_date=start_date,
                    end_date=end_date,
                    bbox=parse_bbox(request.args.get("bbox")),
                    metric=request.args.get("metric"),
                    aggregation=request.args.get("aggregation"),
                    identity_column=request.args.get("identity_column"),
                    identity_value=request.args.get("identity_value"),
                    query_context=self.query_context(),
                )
                packet["dataset_id"] = dataset_id
                packet["runtime"] = self.runtime_packet(dataset_id, dataset)
                packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
                return jsonify(packet)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400


def register_dataset_routes(app: Flask, config: dict[str, Any]) -> None:
    DatasetRoutes(config).register(app)
