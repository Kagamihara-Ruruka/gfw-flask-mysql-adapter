from __future__ import annotations

import gzip
import json
import unittest
from unittest.mock import Mock

from flask import Flask

from common_adapter.http.routes.datasets import DatasetRoutes
from common_adapter.query.batch import QueryBatchExecutor


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
            {"query_policy": {"batch_max_operations": 3}},
            layer_registry=layer_registry,
            batch_executor=self.batch_executor,
        )
        self.routes.register(self.app)
        self.client = self.app.test_client()

    def test_batch_streams_results_in_operation_order_and_isolates_failures(self) -> None:
        calls: list[str] = []

        def records_result(_dataset_id: str, params: dict) -> dict:
            calls.append(params["date"])
            if params["date"] == "2020-01-02":
                raise RuntimeError("source unavailable")
            return {"rows": [{"date": params["date"]}], "row_count": 1}

        self.routes.records_result = records_result  # type: ignore[method-assign]
        response = self.client.post(
            "/api/query/batch",
            json=batch_payload("first", "second", "third"),
            buffered=False,
        )
        chunks = iter(response.response)

        started = json.loads(next(chunks))
        self.assertEqual(started["type"], "batch.started")
        self.assertEqual(calls, [])

        first = json.loads(next(chunks))
        self.assertEqual(first["operation_id"], "first")
        self.assertEqual(first["status"], "ok")
        second = json.loads(next(chunks))
        self.assertEqual(second["operation_id"], "second")
        self.assertEqual(second["status"], "error")
        self.assertEqual(second["error"], "source unavailable")

        third = json.loads(next(chunks))
        self.assertEqual(third["operation_id"], "third")
        self.assertEqual(third["status"], "ok")
        completed = json.loads(next(chunks))
        self.assertEqual(completed["type"], "batch.completed")
        self.assertEqual(completed["completed_count"], 3)
        self.assertCountEqual(calls, ["2020-01-01", "2020-01-02", "2020-01-03"])

    def test_batch_rejects_duplicate_operation_identity(self) -> None:
        payload = batch_payload("duplicate", "duplicate")
        response = self.client.post("/api/query/batch", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("operation_id must be unique", response.get_json()["error"])

    def test_unsupported_operation_is_isolated_from_supported_results(self) -> None:
        self.routes.records_result = lambda _dataset_id, params: {  # type: ignore[method-assign]
            "rows": [{"date": params["date"]}],
            "row_count": 1,
        }
        payload = batch_payload("unsupported", "supported")
        payload["operations"][0]["kind"] = "future.unsupported"
        response = self.client.post("/api/query/batch", json=payload)
        events = [json.loads(line) for line in response.data.decode("utf-8").splitlines()]
        results = [event for event in events if event["type"] == "batch.result"]

        self.assertEqual(results[0]["status"], "error")
        self.assertIn("unsupported query batch operation", results[0]["error"])
        self.assertEqual(results[1]["status"], "ok")

    def test_batch_stream_supports_incremental_gzip(self) -> None:
        self.routes.records_result = lambda _dataset_id, params: {  # type: ignore[method-assign]
            "rows": [{"date": params["date"]}],
            "row_count": 1,
        }
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
        ])


if __name__ == "__main__":
    unittest.main()
