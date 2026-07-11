from __future__ import annotations

import time
from pathlib import Path
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
from common_adapter.developer.config_service import normalize_config_ref, read_config_json
from common_adapter.layers.runtime import dataset_layer_id, imported_layer_ids, is_layer_imported, resolve_runtime_dataset
from common_adapter.spatial.overlay import elapsed_ms


class DatasetRoutes:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    def source_config(self, dataset_id: str) -> str | None:
        for fragment_path in self.config.get("__config_fragments", []):
            fragment, error = read_config_json(Path(fragment_path))
            if error or fragment is None:
                continue
            if dataset_id in fragment.get("datasets", {}):
                return normalize_config_ref(fragment_path)
        if dataset_id in self.config.get("datasets", {}):
            config_path = self.config.get("__config_path")
            if config_path:
                try:
                    return normalize_config_ref(config_path)
                except Exception:
                    return str(config_path)
        return None

    def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        if dataset_id not in self.config["datasets"]:
            raise ValueError(f"unknown dataset: {dataset_id}")
        dataset, runtime = resolve_runtime_dataset(self.config, dataset_id, self.config["datasets"][dataset_id])
        layer_id = dataset_layer_id(dataset_id, dataset)
        if not is_layer_imported(layer_id):
            raise ValueError(f"data layer is not imported: {layer_id}")
        if runtime["source"] != "mapping_controller_contract":
            raise ValueError(f"data layer has no generated mapping contract: {layer_id}")
        return dataset

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
            imported_layers = imported_layer_ids()
            for dataset_id, dataset in config["datasets"].items():
                runtime_dataset, runtime = resolve_runtime_dataset(config, dataset_id, dataset)
                if runtime["layer_id"] not in imported_layers:
                    continue
                if runtime["source"] != "mapping_controller_contract":
                    continue
                backend_kind, connection_ref, _connection = dataset_backend_info(config, runtime_dataset)
                safe[dataset_id] = {
                    "label": runtime_dataset.get("label", dataset_id),
                    "backend": backend_kind,
                    "connection_ref": connection_ref,
                    "contract_group": runtime["contract_group"],
                    "source_route_group": runtime["source_route_group"],
                    "layer_id": runtime["layer_id"],
                    "source_config": self.source_config(dataset_id),
                    "runtime_config": runtime["config_path"],
                    "source_config_path": runtime["source_config_path"],
                    "time_column": runtime_dataset["time_column"],
                    "id_column": runtime_dataset.get("id_column"),
                    "lat_column": runtime_dataset["lat_column"],
                    "lon_column": runtime_dataset["lon_column"],
                    "display_columns": runtime_dataset["display_columns"],
                    "metric_columns": runtime_dataset.get("metric_columns", []),
                    "category_columns": runtime_dataset.get("category_columns", []),
                    "runtime": runtime,
                }
            configured_default = str(config.get("default_dataset") or "")
            default_dataset = configured_default if configured_default in safe else (next(iter(safe.keys()), None))
            return jsonify(
                {
                    "default_dataset": default_dataset,
                    "sql_backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                    "query_policy": policy,
                    "datasets": safe,
                    "imported_layers": sorted(imported_layers),
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
                )
                packet["dataset_id"] = dataset_id
                packet["runtime"] = self.runtime_packet(dataset_id, dataset)
                packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
                return jsonify(packet)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400


def register_dataset_routes(app: Flask, config: dict[str, Any]) -> None:
    DatasetRoutes(config).register(app)
