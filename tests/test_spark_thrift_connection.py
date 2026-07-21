from __future__ import annotations

import sys
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from common_adapter.db.spark_thrift import (
    availability_packet,
    close_spark_thrift_connection,
    execute_query,
    heatmap_packet,
)


CONFIG = {
    "connections": {
        "spark_thrift": {
            "host": "dtadm",
            "port": 10000,
            "username": "bigred",
            "auth": "NONE",
        }
    }
}


class ActiveQueryTracker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def enter(self) -> None:
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)

    def leave(self) -> None:
        with self._lock:
            self.active -= 1


class FakeCursor:
    description = [("result.value",)]

    def __init__(
        self,
        *,
        execute_error: Exception | None = None,
        tracker: ActiveQueryTracker | None = None,
    ) -> None:
        self.execute_error = execute_error
        self.tracker = tracker
        self.closed = False

    def execute(self, sql: str) -> None:
        if self.execute_error is not None:
            raise self.execute_error
        if self.tracker is not None:
            self.tracker.enter()
            try:
                time.sleep(0.03)
            finally:
                self.tracker.leave()

    def fetchall(self) -> list[tuple[int]]:
        return [(1,)]

    def close(self) -> None:
        self.closed = True


class FakeConnection:
    def __init__(
        self,
        *,
        execute_error: Exception | None = None,
        tracker: ActiveQueryTracker | None = None,
    ) -> None:
        self.execute_error = execute_error
        self.tracker = tracker
        self.cursors: list[FakeCursor] = []
        self.close_count = 0

    def cursor(self) -> FakeCursor:
        cursor = FakeCursor(
            execute_error=self.execute_error,
            tracker=self.tracker,
        )
        self.cursors.append(cursor)
        return cursor

    def close(self) -> None:
        self.close_count += 1


class FakeConnectionFactory:
    def __init__(
        self,
        plans: list[dict[str, object]] | None = None,
    ) -> None:
        self.plans = list(plans or [{}])
        self.calls = 0
        self.connections: list[FakeConnection] = []

    def __call__(self, **kwargs: object) -> FakeConnection:
        index = min(self.calls, len(self.plans) - 1)
        connection = FakeConnection(**self.plans[index])
        self.calls += 1
        self.connections.append(connection)
        return connection


def fake_pyhive(factory: FakeConnectionFactory) -> types.ModuleType:
    module = types.ModuleType("pyhive")
    module.hive = types.SimpleNamespace(Connection=factory)
    return module


class SparkThriftConnectionTests(unittest.TestCase):
    def setUp(self) -> None:
        close_spark_thrift_connection()

    def tearDown(self) -> None:
        close_spark_thrift_connection()

    def test_reuses_connection_and_creates_cursor_per_query(self) -> None:
        factory = FakeConnectionFactory()

        with patch.dict(sys.modules, {"pyhive": fake_pyhive(factory)}):
            first = execute_query(CONFIG, "SELECT 1")
            second = execute_query(CONFIG, "SELECT 1")

        self.assertEqual(factory.calls, 1)
        self.assertEqual(len(factory.connections[0].cursors), 2)
        self.assertTrue(all(cursor.closed for cursor in factory.connections[0].cursors))
        self.assertEqual(factory.connections[0].close_count, 0)
        self.assertFalse(first["connection"]["reused"])
        self.assertTrue(second["connection"]["reused"])
        self.assertEqual(second["connection"]["reconnect_count"], 0)

    def test_reconnects_once_after_transport_failure(self) -> None:
        factory = FakeConnectionFactory(
            [
                {"execute_error": ConnectionResetError("connection reset")},
                {},
            ]
        )

        with patch.dict(sys.modules, {"pyhive": fake_pyhive(factory)}):
            packet = execute_query(CONFIG, "SELECT 1")

        self.assertEqual(factory.calls, 2)
        self.assertEqual(factory.connections[0].close_count, 1)
        self.assertFalse(packet["connection"]["reused"])
        self.assertEqual(packet["connection"]["reconnect_count"], 1)
        self.assertEqual(packet["rows"], [{"value": 1}])

    def test_does_not_retry_server_resource_error(self) -> None:
        factory = FakeConnectionFactory(
            [
                {
                    "execute_error": RuntimeError(
                        "java.lang.OutOfMemoryError: unable to create native thread"
                    )
                }
            ]
        )

        with patch.dict(sys.modules, {"pyhive": fake_pyhive(factory)}):
            with self.assertRaisesRegex(RuntimeError, "unable to create native thread"):
                execute_query(CONFIG, "SELECT 1")

        self.assertEqual(factory.calls, 1)

    def test_serializes_queries_on_shared_connection(self) -> None:
        tracker = ActiveQueryTracker()
        factory = FakeConnectionFactory([{"tracker": tracker}])

        with patch.dict(sys.modules, {"pyhive": fake_pyhive(factory)}):
            with ThreadPoolExecutor(max_workers=2) as executor:
                packets = list(
                    executor.map(
                        lambda _: execute_query(CONFIG, "SELECT 1"),
                        range(2),
                    )
                )

        self.assertEqual(factory.calls, 1)
        self.assertEqual(tracker.max_active, 1)
        self.assertEqual(sum(packet["row_count"] for packet in packets), 2)

    @patch("common_adapter.db.spark_thrift.execute_query")
    def test_availability_is_bounded_to_requested_gold_partition(self, query) -> None:
        query.return_value = {
            "rows": [{"event_date": "2022-01-01"}, {"event_date": "2024-12-31"}],
            "row_count": 2,
            "connection": {"reused": True, "reconnect_count": 0},
            "timing": {"query_ms": 10.0},
        }
        packet = availability_packet(
            CONFIG,
            start_date="2022-01-01",
            end_date="2024-12-31",
            aoi="taiwan",
            product="SST",
            metric="sea_temperature",
            resolution=4,
        )

        sql = query.call_args.args[1]
        self.assertIn("event_date BETWEEN DATE '2022-01-01' AND DATE '2024-12-31'", sql)
        self.assertIn("aoi_id = 'taiwan'", sql)
        self.assertIn("product_id = 'SST'", sql)
        self.assertIn("metric_id = 'sea_temperature'", sql)
        self.assertIn("resolution_km = 4", sql)
        self.assertEqual(["2022-01-01", "2024-12-31"], packet["dates"])

    @patch("common_adapter.db.spark_thrift.execute_query")
    def test_heatmap_pushes_geographic_bbox_into_global_grid_indexes(self, query) -> None:
        query.return_value = {
            "rows": [],
            "row_count": 0,
            "connection": {"reused": True, "reconnect_count": 0},
            "timing": {"query_ms": 10.0},
        }
        packet = heatmap_packet(
            CONFIG,
            date="2024-01-01",
            aoi="northwest_pacific",
            product="SST",
            metric="sea_temperature",
            resolution=4,
            bbox=(105, 15, 135, 35),
            geometry={
                "origin_lat": 90,
                "origin_lon": -180,
                "index_units_per_degree": 24,
                "base_resolution_km": 4,
            },
        )

        sql = query.call_args.args[1]
        self.assertIn("grid_row BETWEEN 1320 AND 1799", sql)
        self.assertIn("grid_col BETWEEN 6840 AND 7559", sql)
        self.assertNotIn("LIMIT", sql)
        self.assertEqual(
            {
                "min_grid_row": 1320,
                "max_grid_row": 1799,
                "min_grid_col": 6840,
                "max_grid_col": 7559,
            },
            packet["params"]["grid_window"],
        )


if __name__ == "__main__":
    unittest.main()
