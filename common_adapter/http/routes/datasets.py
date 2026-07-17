from __future__ import annotations

import json
import time
import zlib
from collections.abc import Callable, Mapping
from typing import Any

from flask import Flask, Response, jsonify, request, stream_with_context

from common_adapter.db.connect import (
    dataset_backend_info,
    parse_bbox,
    query_policy,
    records_range_packet,
    records_packet,
    schema_packet,
    time_series_packet,
)
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.layers.runtime import dataset_layer_id
from common_adapter.spatial.overlay import elapsed_ms
from common_adapter.query.sampled_grid import (
    sampled_grid_public_contract,
    sampled_grid_public_fields,
)
from common_adapter.query.identity import dataset_cache_namespace, dataset_query_transport_key
from common_adapter.query.snapshot_cache import CANONICAL_SNAPSHOT_CACHE


class DatasetRoutes:
    def __init__(self, config: dict[str, Any], layer_registry: RuntimeLayerRegistry) -> None:
        self.config = config
        self.layer_registry = layer_registry
        self.batch_handlers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}
        self.register_batch_handler("sampled_grid.records", self.sampled_grid_records_operation)
        CANONICAL_SNAPSHOT_CACHE.configure(
            max_total_rows=query_policy(config)["snapshot_cache_max_rows"]
        )

    def register_batch_handler(
        self,
        kind: str,
        handler: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> None:
        normalized = str(kind or "").strip()
        if not normalized or not callable(handler):
            raise ValueError("query batch handler requires kind and callable")
        if normalized in self.batch_handlers:
            raise ValueError(f"duplicate query batch handler: {normalized}")
        self.batch_handlers[normalized] = handler

    def sampled_grid_records_operation(self, operation: dict[str, Any]) -> dict[str, Any]:
        dataset_id = str(operation.get("dataset_id") or "").strip()
        if not dataset_id:
            raise ValueError("sampled_grid.records requires dataset_id")
        return self.records_result(dataset_id, operation["params"])

    def execute_batch_operation(self, operation: dict[str, Any]) -> dict[str, Any]:
        kind = str(operation.get("kind") or "")
        handler = self.batch_handlers.get(kind)
        if handler is None:
            raise ValueError(f"unsupported query batch operation: {kind or '<missing>'}")
        return handler(operation)

    def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        dataset = self.layer_registry.get_dataset(dataset_id)
        if dataset is None:
            raise ValueError(f"unknown or unavailable dataset: {dataset_id}")
        runtime = {
            "layer_id": dataset_layer_id(dataset_id, dataset),
            "source": dataset.get("__runtime_source"),
        }
        layer_id = dataset_layer_id(dataset_id, dataset)
        if runtime["source"] != "mapping_controller_contract":
            raise ValueError(f"data layer has no generated mapping contract: {layer_id}")
        return dataset

    @staticmethod
    def sampled_grid_packet(dataset: dict[str, Any]) -> dict[str, Any] | None:
        return sampled_grid_public_contract(dataset)

    @staticmethod
    def query_context_from(values: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "requested_resolution_km": values.get("resolution"),
            "zoom": values.get("zoom"),
            "latitude": values.get("latitude"),
        }

    @classmethod
    def query_context(cls) -> dict[str, Any]:
        return cls.query_context_from(request.args)

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
            "query_transport_key": dataset.get("__runtime_query_transport_key")
            or dataset_query_transport_key(dataset),
        }

    def records_result(self, dataset_id: str, values: Mapping[str, Any]) -> dict[str, Any]:
        request_start = time.perf_counter()
        dataset = self.get_dataset(dataset_id)
        packet = records_packet(
            self.config,
            dataset,
            date_value=values.get("date"),
            bbox=parse_bbox(values.get("bbox")),
            limit=values.get("limit", query_policy(self.config)["default_limit"]),
            offset=int(values.get("offset", 0)),
            column_profile=values.get("columns"),
            query_context=self.query_context_from(values),
        )
        packet["dataset_id"] = dataset_id
        packet["runtime"] = self.runtime_packet(dataset_id, dataset)
        packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
        return packet

    @staticmethod
    def batch_payload(payload: Any, *, max_operations: int) -> tuple[str, list[dict[str, Any]]]:
        if not isinstance(payload, dict):
            raise ValueError("query batch body must be an object")
        if str(payload.get("schema") or "") != "query_batch.v1":
            raise ValueError("query batch schema must be query_batch.v1")
        batch_id = str(payload.get("batch_id") or "").strip()
        if not batch_id:
            raise ValueError("query batch requires batch_id")
        operations = payload.get("operations")
        if not isinstance(operations, list) or not operations:
            raise ValueError("query batch requires at least one operation")
        if len(operations) > max_operations:
            raise ValueError(f"query batch exceeds max operations: {max_operations}")
        seen: set[str] = set()
        normalized: list[dict[str, Any]] = []
        for raw_operation in operations:
            if not isinstance(raw_operation, dict):
                raise ValueError("query batch operation must be an object")
            operation_id = str(raw_operation.get("operation_id") or "").strip()
            if not operation_id or operation_id in seen:
                raise ValueError("query batch operation_id must be unique and non-empty")
            kind = str(raw_operation.get("kind") or "").strip()
            dataset_id = str(raw_operation.get("dataset_id") or "").strip()
            params = raw_operation.get("params")
            if not kind or not isinstance(params, dict):
                raise ValueError("query batch operation requires kind and params")
            seen.add(operation_id)
            normalized.append(
                {
                    "operation_id": operation_id,
                    "kind": kind,
                    "dataset_id": dataset_id,
                    "params": params,
                }
            )
        return batch_id, normalized

    @staticmethod
    def gzip_stream(chunks):
        compressor = zlib.compressobj(wbits=16 + zlib.MAX_WBITS)
        for chunk in chunks:
            encoded = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
            compressed = compressor.compress(encoded) + compressor.flush(zlib.Z_SYNC_FLUSH)
            if compressed:
                yield compressed
        tail = compressor.flush(zlib.Z_FINISH)
        if tail:
            yield tail

    def register(self, app: Flask) -> None:
        config = self.config

        @app.get("/api/datasets")
        def datasets():
            safe = {}
            policy = query_policy(config)
            registry = self.layer_registry.snapshot(force=True)
            for dataset_id, runtime_dataset in registry["datasets"].items():
                runtime = self.runtime_packet(dataset_id, runtime_dataset)
                public_fields = sampled_grid_public_fields(runtime_dataset)
                if str(runtime_dataset.get("backend") or "") == "sampled_grid_http":
                    backend_kind = runtime_dataset.get("backend")
                    connection_ref = runtime_dataset.get("connection_ref")
                else:
                    backend_kind, connection_ref, _connection = dataset_backend_info(config, runtime_dataset)
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
                    "query_transport_key": runtime["query_transport_key"],
                    **public_fields,
                    "sampled_grid": self.sampled_grid_packet(runtime_dataset),
                    "runtime": runtime,
                }
            return jsonify(
                {
                    "sql_backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                    "query_policy": policy,
                    "datasets": safe,
                    "imported_layers": registry["imported_layers"],
                    "layers": registry["layers"],
                    "source_errors": registry["source_errors"],
                    "registry_generation": registry["generation"],
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
            try:
                return jsonify(self.records_result(dataset_id, request.args))
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.post("/api/query/batch")
        def query_batch():
            policy = query_policy(config)
            try:
                batch_id, operations = self.batch_payload(
                    request.get_json(silent=True),
                    max_operations=policy["batch_max_operations"],
                )
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

            def event_stream():
                yield json.dumps(
                    {
                        "type": "batch.started",
                        "batch_id": batch_id,
                        "operation_count": len(operations),
                    },
                    ensure_ascii=True,
                    separators=(",", ":"),
                ) + "\n"
                completed = 0
                for operation in operations:
                    event: dict[str, Any] = {
                        "type": "batch.result",
                        "batch_id": batch_id,
                        "operation_id": operation["operation_id"],
                    }
                    try:
                        event["status"] = "ok"
                        event["packet"] = self.execute_batch_operation(operation)
                    except Exception as exc:
                        event["status"] = "error"
                        event["error"] = str(exc)
                    completed += 1
                    yield json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n"
                yield json.dumps(
                    {
                        "type": "batch.completed",
                        "batch_id": batch_id,
                        "operation_count": len(operations),
                        "completed_count": completed,
                    },
                    ensure_ascii=True,
                    separators=(",", ":"),
                ) + "\n"

            accepts_gzip = "gzip" in request.headers.get("Accept-Encoding", "").lower()
            chunks = stream_with_context(event_stream())
            response = Response(
                self.gzip_stream(chunks) if accepts_gzip else chunks,
                mimetype="application/x-ndjson",
            )
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Accel-Buffering"] = "no"
            if accepts_gzip:
                response.headers["Content-Encoding"] = "gzip"
                response.headers["Vary"] = "Accept-Encoding"
            return response

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


def register_dataset_routes(
    app: Flask,
    config: dict[str, Any],
    *,
    layer_registry: RuntimeLayerRegistry,
) -> None:
    DatasetRoutes(config, layer_registry).register(app)
