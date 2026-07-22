from __future__ import annotations

import sys
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from common_adapter.db.spark_thrift import (
    SparkThriftConnectionManager,
    availability_packet,
    close_spark_thrift_connection,
    execute_query,
    heatmap_packet,
    heatmap_range_packet,
    spark_thrift_query_lane,
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
        self._fetch_batches = [[(1,)], []]

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

    def fetchmany(self, size: int | None = None) -> list[tuple[int]]:
        del size
        return self._fetch_batches.pop(0) if self._fetch_batches else []

    def close(self) -> None:
        self.closed = True


class NeverFinishingCursor(FakeCursor):
    def __init__(self) -> None:
        super().__init__()
        self.cancel_count = 0

    def execute(self, sql: str, **kwargs: object) -> None:
        self.async_requested = kwargs.get("async_") is True

    def poll(self, get_progress_update: bool = True) -> object:
        return types.SimpleNamespace(operationState=1)

    def cancel(self) -> None:
        self.cancel_count += 1


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


class NeverFinishingConnection(FakeConnection):
    def cursor(self) -> NeverFinishingCursor:
        cursor = NeverFinishingCursor()
        self.cursors.append(cursor)
        return cursor


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


class NeverFinishingConnectionFactory(FakeConnectionFactory):
    def __call__(self, **kwargs: object) -> NeverFinishingConnection:
        connection = NeverFinishingConnection()
        self.calls += 1
        self.connections.append(connection)
        return connection


class SlowFetchingCursor(NeverFinishingCursor):
    def poll(self, get_progress_update: bool = True) -> object:
        del get_progress_update
        return types.SimpleNamespace(operationState=2)

    def fetchmany(self, size: int | None = None) -> list[tuple[int]]:
        del size
        time.sleep(0.015)
        return [(1,)]


class SlowFetchingConnection(FakeConnection):
    def cursor(self) -> SlowFetchingCursor:
        cursor = SlowFetchingCursor()
        self.cursors.append(cursor)
        return cursor


class SlowFetchingConnectionFactory(FakeConnectionFactory):
    def __call__(self, **kwargs: object) -> SlowFetchingConnection:
        del kwargs
        connection = SlowFetchingConnection()
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

    def test_foreground_and_background_use_two_bounded_connection_owners(self) -> None:
        tracker = ActiveQueryTracker()
        factory = FakeConnectionFactory([{"tracker": tracker}])
        start = threading.Barrier(3)

        def query(lane: str) -> dict:
            start.wait(timeout=1)
            with spark_thrift_query_lane(lane):
                return execute_query(CONFIG, f"SELECT {lane}")

        with patch.dict(sys.modules, {"pyhive": fake_pyhive(factory)}):
            with ThreadPoolExecutor(max_workers=2) as executor:
                foreground = executor.submit(query, "foreground")
                background = executor.submit(query, "background")
                start.wait(timeout=1)
                packets = [foreground.result(timeout=2), background.result(timeout=2)]

        self.assertEqual(factory.calls, 2)
        self.assertEqual(tracker.max_active, 2)
        self.assertCountEqual(
            [packet["connection"]["query_lane"] for packet in packets],
            ["foreground", "background"],
        )

    def test_shared_connection_slot_serves_waiters_in_fifo_order(self) -> None:
        manager = SparkThriftConnectionManager()
        factory = FakeConnectionFactory()
        completed: list[int] = []
        manager._lock.acquire()

        def query(index: int) -> None:
            manager.execute(
                factory,
                ("dtadm", 10000, "bigred", "NONE", ""),
                {},
                f"SELECT {index}",
                timeout_seconds=1,
                slot_timeout_seconds=1,
            )
            completed.append(index)

        threads = []
        for index in (1, 2, 3):
            thread = threading.Thread(target=query, args=(index,))
            thread.start()
            threads.append(thread)
            deadline = time.monotonic() + 1
            while len(manager._lock._waiters) < index and time.monotonic() < deadline:
                time.sleep(0.001)

        manager._lock.release()
        for thread in threads:
            thread.join(timeout=2)

        self.assertEqual([1, 2, 3], completed)

    def test_query_execution_timeout_starts_after_slot_is_acquired(self) -> None:
        manager = SparkThriftConnectionManager()
        factory = FakeConnectionFactory()
        manager._lock.acquire()

        timer = threading.Timer(0.03, manager._lock.release)
        timer.start()
        try:
            packet = manager.execute(
                factory,
                ("dtadm", 10000, "bigred", "NONE", ""),
                {},
                "SELECT queued",
                timeout_seconds=0.02,
                slot_timeout_seconds=0.08,
                poll_interval_seconds=0.005,
            )
        finally:
            timer.join(timeout=1)

        self.assertEqual(1, packet["row_count"])

    def test_timeout_cancels_query_and_discards_owned_connection(self) -> None:
        factory = NeverFinishingConnectionFactory()
        config = {
            "connections": {
                "spark_thrift": {
                    **CONFIG["connections"]["spark_thrift"],
                    "query_timeout_seconds": 0.02,
                    "query_poll_interval_seconds": 0.005,
                }
            }
        }

        with patch.dict(sys.modules, {"pyhive": fake_pyhive(factory)}):
            with self.assertRaisesRegex(TimeoutError, "exceeded"):
                execute_query(config, "SELECT slow")

        cursor = factory.connections[0].cursors[0]
        self.assertTrue(cursor.async_requested)
        self.assertEqual(1, cursor.cancel_count)
        self.assertTrue(cursor.closed)
        self.assertEqual(1, factory.connections[0].close_count)

    def test_timeout_covers_result_transfer_and_releases_owned_connection(self) -> None:
        factory = SlowFetchingConnectionFactory()
        config = {
            "connections": {
                "spark_thrift": {
                    **CONFIG["connections"]["spark_thrift"],
                    "query_timeout_seconds": 0.02,
                    "query_poll_interval_seconds": 0.005,
                }
            }
        }

        with patch.dict(sys.modules, {"pyhive": fake_pyhive(factory)}):
            with self.assertRaisesRegex(TimeoutError, "result transfer"):
                execute_query(config, "SELECT slow_transfer")

        cursor = factory.connections[0].cursors[0]
        self.assertEqual(1, cursor.cancel_count)
        self.assertTrue(cursor.closed)
        self.assertEqual(1, factory.connections[0].close_count)

    def test_timeout_includes_waiting_for_shared_query_slot(self) -> None:
        manager = SparkThriftConnectionManager()
        factory = FakeConnectionFactory()
        manager._lock.acquire()
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(TimeoutError, "query slot"):
                manager.execute(
                    factory,
                    ("dtadm", 10000, "bigred", "NONE", ""),
                    {},
                    "SELECT queued",
                    timeout_seconds=0.02,
                    poll_interval_seconds=0.005,
                )
        finally:
            manager._lock.release()

        # Windows timers can return a few microseconds before the requested
        # lock timeout even though the entire query budget was consumed.
        self.assertGreaterEqual(time.monotonic() - started, 0.014)
        self.assertEqual(0, factory.calls)
        self.assertIsNone(manager._connection)

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

    @patch("common_adapter.db.spark_thrift.execute_query")
    def test_heatmap_range_uses_one_query_with_per_snapshot_limit(self, query) -> None:
        query.return_value = {
            "rows": [],
            "row_count": 0,
            "connection": {"reused": True, "reconnect_count": 0},
            "timing": {"query_ms": 10.0},
        }
        packet = heatmap_range_packet(
            CONFIG,
            start_date="2024-01-01",
            end_date="2024-01-31",
            aoi="northwest_pacific",
            product="SST",
            metric="sea_temperature",
            resolution=32,
            limit=500,
            bbox=(105, 15, 135, 35),
            geometry={
                "origin_lat": 90,
                "origin_lon": -180,
                "index_units_per_degree": 24,
                "base_resolution_km": 4,
            },
        )

        sql = query.call_args.args[1]
        self.assertIn(
            "event_date BETWEEN DATE '2024-01-01' AND DATE '2024-01-31'",
            sql,
        )
        self.assertIn("PARTITION BY event_date", sql)
        self.assertIn("WHERE __snapshot_row <= 500", sql)
        self.assertEqual("per_snapshot", packet["params"]["limit_mode"])
        query.assert_called_once()


if __name__ == "__main__":
    unittest.main()
