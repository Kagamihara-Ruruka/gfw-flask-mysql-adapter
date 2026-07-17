from __future__ import annotations

import threading
import time
import unittest

from common_adapter.query.batch import QueryBatchExecutor, dataset_query_concurrency


class QueryBatchExecutorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.executor = QueryBatchExecutor(max_workers=4)
        self.addCleanup(self.executor.close)

    @staticmethod
    def operations(count: int, source: str = "provider-a") -> list[dict]:
        return [
            {"operation_id": f"operation-{index}", "source": source, "index": index}
            for index in range(count)
        ]

    def test_provider_capacity_is_the_execution_limit(self) -> None:
        lock = threading.Lock()
        active = 0
        maximum_active = 0

        def execute(operation: dict) -> dict:
            nonlocal active, maximum_active
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return {"index": operation["index"]}

        results = list(
            self.executor.execute(
                self.operations(4),
                execute_operation=execute,
                source_key_for=lambda operation: operation["source"],
                source_limit_for=lambda _operation: 2,
            )
        )

        self.assertEqual(maximum_active, 2)
        self.assertCountEqual([result.packet["index"] for result in results], [0, 1, 2, 3])
        self.assertTrue(all(result.source_capacity_wait_ms >= 0 for result in results))

    def test_results_are_yielded_in_completion_order(self) -> None:
        def execute(operation: dict) -> dict:
            if operation["index"] == 0:
                time.sleep(0.04)
            return {"index": operation["index"]}

        results = list(
            self.executor.execute(
                self.operations(2),
                execute_operation=execute,
                source_key_for=lambda operation: operation["source"],
                source_limit_for=lambda _operation: 2,
            )
        )

        self.assertEqual([result.packet["index"] for result in results], [1, 0])

    def test_capacity_is_shared_by_concurrent_batches_for_the_same_provider(self) -> None:
        lock = threading.Lock()
        active = 0
        maximum_active = 0
        barrier = threading.Barrier(3)

        def execute(operation: dict) -> dict:
            nonlocal active, maximum_active
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
            time.sleep(0.03)
            with lock:
                active -= 1
            return operation

        def run_batch(offset: int) -> None:
            barrier.wait()
            list(
                self.executor.execute(
                    [
                        {"operation_id": f"operation-{offset + index}", "source": "shared"}
                        for index in range(2)
                    ],
                    execute_operation=execute,
                    source_key_for=lambda operation: operation["source"],
                    source_limit_for=lambda _operation: 2,
                )
            )

        threads = [threading.Thread(target=run_batch, args=(offset,)) for offset in (0, 2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=2)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(maximum_active, 2)

    def test_waiting_for_one_provider_does_not_consume_workers_needed_by_another(self) -> None:
        executor = QueryBatchExecutor(max_workers=3)
        self.addCleanup(executor.close)
        provider_a_started = threading.Event()
        release_provider_a = threading.Event()
        provider_b_finished = threading.Event()

        def execute(operation: dict) -> dict:
            if operation["source"] == "provider-a":
                provider_a_started.set()
                release_provider_a.wait(timeout=1)
            else:
                provider_b_finished.set()
            return operation

        def run(operations: list[dict], limit: int) -> None:
            list(
                executor.execute(
                    operations,
                    execute_operation=execute,
                    source_key_for=lambda operation: operation["source"],
                    source_limit_for=lambda _operation: limit,
                )
            )

        provider_a = threading.Thread(
            target=run,
            args=(self.operations(3, "provider-a"), 1),
        )
        provider_b = threading.Thread(
            target=run,
            args=(self.operations(1, "provider-b"), 1),
        )
        try:
            provider_a.start()
            self.assertTrue(provider_a_started.wait(timeout=1))
            provider_b.start()
            self.assertTrue(provider_b_finished.wait(timeout=0.25))
        finally:
            release_provider_a.set()
            provider_a.join(timeout=2)
            provider_b.join(timeout=2)

        self.assertFalse(provider_a.is_alive())
        self.assertFalse(provider_b.is_alive())

    def test_failures_are_isolated_to_their_operation(self) -> None:
        def execute(operation: dict) -> dict:
            if operation["index"] == 1:
                raise RuntimeError("source unavailable")
            return {"index": operation["index"]}

        results = list(
            self.executor.execute(
                self.operations(3),
                execute_operation=execute,
                source_key_for=lambda operation: operation["source"],
                source_limit_for=lambda _operation: 2,
            )
        )

        by_index = {result.operation["index"]: result for result in results}
        self.assertEqual(by_index[0].status, "ok")
        self.assertEqual(by_index[1].status, "error")
        self.assertEqual(by_index[1].error, "source unavailable")
        self.assertEqual(by_index[2].status, "ok")

    def test_closing_stream_releases_permit_for_cancelled_queued_future(self) -> None:
        executor = QueryBatchExecutor(max_workers=2)
        self.addCleanup(executor.close)
        blockers_started = [threading.Event(), threading.Event()]
        release_blockers = threading.Event()

        def execute(operation: dict) -> dict:
            blocker_index = operation.get("blocker_index")
            if blocker_index is not None:
                blockers_started[blocker_index].set()
                release_blockers.wait(timeout=1)
            return operation

        stream = executor.execute(
            [
                {"operation_id": "quick", "source": "provider-a"},
                {"operation_id": "block-1", "source": "provider-b", "blocker_index": 0},
                {"operation_id": "block-2", "source": "provider-d", "blocker_index": 1},
                {"operation_id": "cancelled", "source": "provider-c"},
            ],
            execute_operation=execute,
            source_key_for=lambda operation: operation["source"],
            source_limit_for=lambda _operation: 1,
        )

        try:
            first = next(stream)
            self.assertEqual(first.operation["operation_id"], "quick")
            self.assertTrue(all(event.wait(timeout=1) for event in blockers_started))
            stream.close()
        finally:
            release_blockers.set()

        completed = threading.Event()

        def run_provider_c() -> None:
            list(
                executor.execute(
                    [{"operation_id": "replacement", "source": "provider-c"}],
                    execute_operation=execute,
                    source_key_for=lambda operation: operation["source"],
                    source_limit_for=lambda _operation: 1,
                )
            )
            completed.set()

        worker = threading.Thread(target=run_provider_c)
        worker.start()
        worker.join(timeout=1)
        self.assertTrue(completed.is_set())
        self.assertFalse(worker.is_alive())

    def test_source_config_declares_provider_capacity(self) -> None:
        dataset = {
            "endpoint_source": {
                "query_policy": {"max_in_flight": 2},
            }
        }
        self.assertEqual(dataset_query_concurrency(dataset), 2)
        self.assertEqual(dataset_query_concurrency({}), 1)


if __name__ == "__main__":
    unittest.main()
