from __future__ import annotations

import time
import zlib
from collections.abc import Callable, Mapping
from typing import Any

import orjson
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
from common_adapter.query.batch import QueryBatchExecutor, dataset_query_concurrency
from common_adapter.query.identity import dataset_cache_namespace, dataset_query_transport_key
from common_adapter.query.sampled_grid import (
    sampled_grid_public_contract,
    sampled_grid_public_fields,
)
from common_adapter.query.snapshot_cache import CANONICAL_SNAPSHOT_CACHE
from common_adapter.query.transport import project_sampled_grid_render_packet
from common_adapter.spatial.overlay import elapsed_ms


class BatchStreamTiming:
    """Owns monotonic timing for the 5081 NDJSON transport boundary."""

    def __init__(self, *, compression_level: int = 3) -> None:
        self.started_at = time.perf_counter()
        self.compression_level = max(1, min(9, int(compression_level)))
        self.batch_encode_ms = 0.0
        self.batch_gzip_ms = 0.0
        self.batch_yield_ms = 0.0
        self.response_bytes = 0
        self.uncompressed_bytes = 0

    def encode(self, event: dict[str, Any]) -> bytes:
        started_at = time.perf_counter()
        encoded = orjson.dumps(event, option=orjson.OPT_APPEND_NEWLINE)
        self.batch_encode_ms += elapsed_ms(started_at)
        self.uncompressed_bytes += len(encoded)
        return encoded

    def snapshot(self) -> dict[str, Any]:
        return {
            "batch_encode_ms": round(self.batch_encode_ms, 3),
            "batch_codec": "orjson",
            "batch_gzip_ms": round(self.batch_gzip_ms, 3),
            "batch_gzip_level": self.compression_level,
            "batch_yield_ms": round(self.batch_yield_ms, 3),
            "response_bytes": self.response_bytes,
            "uncompressed_bytes": self.uncompressed_bytes,
            "batch_total_ms": round(elapsed_ms(self.started_at), 3),
        }


class DatasetRoutes:
    API_TIMING_PHASES = (
        "cache_lookup_ms",
        "cache_wait_ms",
        "source_http_wall_ms",
        "canonicalize_rows_ms",
        "canonical_packet_copy_ms",
        "cache_commit_ms",
        "cache_evict_ms",
        "filter_ms",
        "packet_projection_ms",
        "serialize_ms",
    )

    def __init__(
        self,
        config: dict[str, Any],
        layer_registry: RuntimeLayerRegistry,
        *,
        batch_executor: QueryBatchExecutor,
    ) -> None:
        self.config = config
        self.layer_registry = layer_registry
        self.batch_executor = batch_executor
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
        return self.records_result(
            dataset_id,
            operation["params"],
            output_profile="canonical_frame",
        )

    def execute_batch_operation(self, operation: dict[str, Any]) -> dict[str, Any]:
        kind = str(operation.get("kind") or "")
        handler = self.batch_handlers.get(kind)
        if handler is None:
            raise ValueError(f"unsupported query batch operation: {kind or '<missing>'}")
        return handler(operation)

    def batch_operation_source_key(self, operation: dict[str, Any]) -> str:
        dataset_id = str(operation.get("dataset_id") or "").strip()
        if not dataset_id:
            return f"{operation.get('kind') or 'unknown'}|<missing-dataset>"
        try:
            dataset = self.get_dataset(dataset_id)
        except Exception:  # The operation handler will expose the canonical error.
            return f"{operation.get('kind') or 'unknown'}|{dataset_id}"
        return str(dataset.get("__runtime_query_transport_key") or dataset_query_transport_key(dataset))

    def batch_operation_source_limit(self, operation: dict[str, Any]) -> int:
        dataset_id = str(operation.get("dataset_id") or "").strip()
        if not dataset_id:
            return 1
        try:
            return dataset_query_concurrency(self.get_dataset(dataset_id))
        except Exception:
            return 1

    def batch_source_capacities(self, operations: list[dict[str, Any]]) -> dict[str, int]:
        capacities: dict[str, int] = {}
        counts: dict[str, int] = {}
        for operation in operations:
            source_key = self.batch_operation_source_key(operation)
            capacity = self.batch_operation_source_limit(operation)
            capacities[source_key] = min(capacities.get(source_key, capacity), capacity)
            counts[source_key] = counts.get(source_key, 0) + 1
        exceeded = [
            f"{source_key}: {counts[source_key]} > {capacity}"
            for source_key, capacity in capacities.items()
            if counts[source_key] > capacity
        ]
        if exceeded:
            raise ValueError(
                "query batch exceeds source capacity: " + ", ".join(exceeded)
            )
        return capacities

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
            "source": dataset["__runtime_source"],
            "contract_group": dataset.get("__runtime_contract_group"),
            "source_route_group": dataset.get("__runtime_source_route_group"),
            "mapping_id": dataset.get("__runtime_mapping_id"),
            "config_path": dataset.get("__runtime_config_path"),
            "source_config_path": dataset.get("__runtime_source_config_path"),
            "query_transport_key": dataset.get("__runtime_query_transport_key")
            or dataset_query_transport_key(dataset),
        }

    @classmethod
    def finalize_api_timing(cls, packet: dict[str, Any], api_total_ms: float) -> None:
        timing = dict(packet.get("timing") or {})
        tracked = sum(float(timing.get(key) or 0) for key in cls.API_TIMING_PHASES)
        timing["api_total_ms"] = round(float(api_total_ms), 3)
        timing["api_unattributed_ms"] = round(max(0.0, float(api_total_ms) - tracked), 3)
        timing["api_accounted_ms"] = round(tracked + timing["api_unattributed_ms"], 3)
        packet["timing"] = timing

    def records_result(
        self,
        dataset_id: str,
        values: Mapping[str, Any],
        *,
        output_profile: str = "rows",
    ) -> dict[str, Any]:
        request_start = time.perf_counter()
        dataset = self.get_dataset(dataset_id)
        query_context = self.query_context_from(values)
        query_context["output_profile"] = output_profile
        packet = records_packet(
            self.config,
            dataset,
            date_value=values.get("date"),
            bbox=parse_bbox(values.get("bbox")),
            limit=values.get("limit", query_policy(self.config)["default_limit"]),
            offset=int(values.get("offset", 0)),
            column_profile=values.get("columns"),
            query_context=query_context,
        )
        packet["dataset_id"] = dataset_id
        packet["runtime"] = self.runtime_packet(dataset_id, dataset)
        self.finalize_api_timing(packet, elapsed_ms(request_start))
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
    def plain_stream(chunks, timing: BatchStreamTiming):
        for chunk in chunks:
            timing.response_bytes += len(chunk)
            yield chunk

    @staticmethod
    def gzip_stream(chunks, timing: BatchStreamTiming):
        compressor = zlib.compressobj(
            level=timing.compression_level,
            wbits=16 + zlib.MAX_WBITS,
        )
        for chunk in chunks:
            encoded = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
            gzip_started = time.perf_counter()
            compressed = compressor.compress(encoded) + compressor.flush(zlib.Z_SYNC_FLUSH)
            timing.batch_gzip_ms += elapsed_ms(gzip_started)
            if compressed:
                timing.response_bytes += len(compressed)
                yield compressed
        gzip_started = time.perf_counter()
        tail = compressor.flush(zlib.Z_FINISH)
        timing.batch_gzip_ms += elapsed_ms(gzip_started)
        if tail:
            timing.response_bytes += len(tail)
            yield tail

    def register(self, app: Flask) -> None:
        config = self.config

        @app.get("/api/datasets")
        def datasets():
            safe = {}
            query_transport_capacities: dict[str, int] = {}
            policy = query_policy(config)
            registry = self.layer_registry.snapshot(force=True)
            for dataset_id, runtime_dataset in registry["datasets"].items():
                runtime = self.runtime_packet(dataset_id, runtime_dataset)
                transport_key = str(runtime["query_transport_key"])
                source_capacity = dataset_query_concurrency(runtime_dataset)
                query_transport_capacities[transport_key] = min(
                    query_transport_capacities.get(transport_key, source_capacity),
                    source_capacity,
                )
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
                    "query_transport_capacities": query_transport_capacities,
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
                source_capacities = self.batch_source_capacities(operations)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

            stream_timing = BatchStreamTiming(
                compression_level=policy["batch_gzip_level"],
            )

            def event_stream():
                def emit(event: dict[str, Any]):
                    chunk = stream_timing.encode(event)
                    yielded_at = time.perf_counter()
                    yield chunk
                    stream_timing.batch_yield_ms += elapsed_ms(yielded_at)

                yield from emit(
                    {
                        "type": "batch.started",
                        "batch_id": batch_id,
                        "operation_count": len(operations),
                        "source_capacities": source_capacities,
                    }
                )
                completed = 0
                results = self.batch_executor.execute(
                    operations,
                    execute_operation=self.execute_batch_operation,
                    source_key_for=self.batch_operation_source_key,
                    source_limit_for=self.batch_operation_source_limit,
                )
                for result in results:
                    operation = result.operation
                    event: dict[str, Any] = {
                        "type": "batch.result",
                        "batch_id": batch_id,
                        "operation_id": operation["operation_id"],
                        "source_capacity_wait_ms": result.source_capacity_wait_ms,
                    }
                    event["status"] = result.status
                    if result.error is None:
                        event["packet"] = project_sampled_grid_render_packet(result.packet)
                    else:
                        event["error"] = result.error
                    completed += 1
                    yield from emit(event)
                yield from emit(
                    {
                        "type": "batch.completed",
                        "batch_id": batch_id,
                        "operation_count": len(operations),
                        "completed_count": completed,
                    }
                )
                yield from emit(
                    {
                        "type": "batch.metrics",
                        "batch_id": batch_id,
                        "metrics": stream_timing.snapshot(),
                    }
                )

            accepts_gzip = "gzip" in request.headers.get("Accept-Encoding", "").lower()
            chunks = stream_with_context(event_stream())
            response = Response(
                self.gzip_stream(chunks, stream_timing)
                if accepts_gzip
                else self.plain_stream(chunks, stream_timing),
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
    batch_executor: QueryBatchExecutor,
) -> None:
    DatasetRoutes(
        config,
        layer_registry,
        batch_executor=batch_executor,
    ).register(app)
