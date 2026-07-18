from __future__ import annotations

import gzip
import json
import time
import unittest
from unittest.mock import Mock

from flask import Flask

from common_adapter.http.routes.datasets import DatasetRoutes
from common_adapter.query.batch import QueryBatchExecutor
from common_adapter.query.grid_frame import canonical_grid_frame_from_rows


def canonical_packet(date: str) -> dict:
    frame = canonical_grid_frame_from_rows([{"date": date}])
    return {
        "row_contract_version": "rrkal.sampled_grid.v1",
        "column_profile": "render",
        "canonical_frame": frame.view().transport(),
        "row_count": 1,
    }


def batch_payload(*operation_ids: str) -> dict:
    return {
        "schema": "query_batch.v1",
        "batch_id": "batch-test",
        "operations": [
            {
                "operation_id": operation_id,
                "kind": "sampled_grid.records",
                "dataset_id": "ocean",
                "params": {
                    "date": f"2020-01-{index + 1:02d}",
                    "bbox": "120,10,130,20",
                    "limit": "max",
                    "columns": "render",
                    "resolution": 4,
                },
            }
            for index, operation_id in enumerate(operation_ids)
        ],
    }


class QueryBatchRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = Flask(__name__)
        self.batch_executor = QueryBatchExecutor(max_workers=2)
        self.addCleanup(self.batch_executor.close)
        layer_registry = Mock()
        layer_registry.get_dataset.return_value = {
            "data_layer": "ocean",
            "__runtime_source": "mapping_controller_contract",
            "__runtime_query_transport_key": "source-test",
            "endpoint_source": {"query_policy": {"max_in_flight": 2}},
        }
        self.routes = DatasetRoutes(
            {"query_policy": {"batch_max_operations": 3, "batch_gzip_level": 3}},
            layer_registry=layer_registry,
            batch_executor=self.batch_executor,
        )
        self.routes.register(self.app)
        self.client = self.app.test_client()

    def test_batch_streams_results_in_completion_order_and_isolates_failures(self) -> None:
        calls: list[str] = []

        def records_result(_dataset_id: str, params: dict, **_kwargs) -> dict:
            calls.append(params["date"])
            if params["date"] == "2020-01-01":
                time.sleep(0.03)
            if params["date"] == "2020-01-02":
                raise RuntimeError("source unavailable")
            return canonical_packet(params["date"])

        self.routes.records_result = records_result  # type: ignore[method-assign]
        response = self.client.post(
            "/api/query/batch",
            json=batch_payload("slow", "fast-error"),
            buffered=False,
        )
        chunks = iter(response.response)

        started = json.loads(next(chunks))
        self.assertEqual(started["type"], "batch.started")
        self.assertEqual(calls, [])

        first = json.loads(next(chunks))
        self.assertEqual(first["operation_id"], "fast-error")
        self.assertEqual(first["status"], "error")
        self.assertEqual(first["error"], "source unavailable")
        second = json.loads(next(chunks))
        self.assertEqual(second["operation_id"], "slow")
        self.assertEqual(second["status"], "ok")
        completed = json.loads(next(chunks))
        self.assertEqual(completed["type"], "batch.completed")
        self.assertEqual(completed["completed_count"], 2)
        metrics = json.loads(next(chunks))
        self.assertEqual(metrics["type"], "batch.metrics")
        self.assertIn("batch_encode_ms", metrics["metrics"])
        self.assertEqual(metrics["metrics"]["batch_codec"], "orjson")
        self.assertIn("response_bytes", metrics["metrics"])
        self.assertCountEqual(calls, ["2020-01-01", "2020-01-02"])

    def test_batch_rejects_more_operations_than_source_capacity(self) -> None:
        response = self.client.post(
            "/api/query/batch",
            json=batch_payload("first", "second", "third"),
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("exceeds source capacity", response.get_json()["error"])

    def test_batch_rejects_duplicate_operation_identity(self) -> None:
        payload = batch_payload("duplicate", "duplicate")
        response = self.client.post("/api/query/batch", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("operation_id must be unique", response.get_json()["error"])

    def test_unsupported_operation_is_isolated_from_supported_results(self) -> None:
        self.routes.records_result = lambda _dataset_id, params, **_kwargs: canonical_packet(  # type: ignore[method-assign]
            params["date"]
        )
        payload = batch_payload("unsupported", "supported")
        payload["operations"][0]["kind"] = "future.unsupported"
        response = self.client.post("/api/query/batch", json=payload)
        events = [json.loads(line) for line in response.data.decode("utf-8").splitlines()]
        results = [event for event in events if event["type"] == "batch.result"]

        by_id = {event["operation_id"]: event for event in results}
        self.assertEqual(by_id["unsupported"]["status"], "error")
        self.assertIn("unsupported query batch operation", by_id["unsupported"]["error"])
        self.assertEqual(by_id["supported"]["status"], "ok")

    def test_batch_stream_supports_incremental_gzip(self) -> None:
        self.routes.records_result = lambda _dataset_id, params, **_kwargs: canonical_packet(  # type: ignore[method-assign]
            params["date"]
        )
        response = self.client.post(
            "/api/query/batch",
            json=batch_payload("first"),
            headers={"Accept-Encoding": "gzip"},
        )
        self.assertEqual(response.headers.get("Content-Encoding"), "gzip")
        events = [
            json.loads(line)
            for line in gzip.decompress(response.data).decode("utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual([event["type"] for event in events], [
            "batch.started",
            "batch.result",
            "batch.completed",
            "batch.metrics",
        ])
        self.assertGreater(events[-1]["metrics"]["response_bytes"], 0)
        self.assertEqual(events[-1]["metrics"]["batch_gzip_level"], 3)


if __name__ == "__main__":
    unittest.main()
