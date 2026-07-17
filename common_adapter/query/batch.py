from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from threading import Condition
from typing import Any


def normalized_query_concurrency(value: Any, *, fallback: int = 1) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        numeric = fallback
    return max(1, min(16, numeric))


def dataset_query_concurrency(dataset: dict[str, Any], *, fallback: int = 1) -> int:
    source = dataset.get("endpoint_source")
    source_config = source if isinstance(source, dict) else {}
    policy = source_config.get("query_policy")
    query_policy = policy if isinstance(policy, dict) else {}
    return normalized_query_concurrency(
        query_policy.get("max_in_flight"),
        fallback=fallback,
    )


@dataclass(frozen=True)
class QueryBatchResult:
    operation: dict[str, Any]
    packet: dict[str, Any] | None = None
    error: str | None = None
    source_capacity_wait_ms: float = 0.0
    completed_monotonic_ms: float = 0.0

    @property
    def status(self) -> str:
        return "error" if self.error is not None else "ok"


class SourceCapacityPool:
    """Owns in-flight counts for every physical query provider."""

    def __init__(self) -> None:
        self._condition = Condition()
        self._active: dict[str, int] = {}

    def try_acquire(self, source_key: str, limit: int) -> bool:
        key = str(source_key or "unknown-source")
        capacity = normalized_query_concurrency(limit)
        with self._condition:
            if self._active.get(key, 0) >= capacity:
                return False
            self._active[key] = self._active.get(key, 0) + 1
            return True

    def wait_for_change(self, timeout: float = 0.05) -> None:
        with self._condition:
            self._condition.wait(timeout=timeout)

    def release(self, source_key: str) -> None:
        key = str(source_key or "unknown-source")
        with self._condition:
            remaining = self._active.get(key, 1) - 1
            if remaining > 0:
                self._active[key] = remaining
            else:
                self._active.pop(key, None)
            self._condition.notify_all()


class QueryBatchExecutor:
    """Executes decompressed operations under global and per-provider capacity."""

    def __init__(self, *, max_workers: int) -> None:
        self.max_workers = normalized_query_concurrency(max_workers)
        self._capacity = SourceCapacityPool()
        self._executor = ThreadPoolExecutor(
            max_workers=self.max_workers,
            thread_name_prefix="query-batch",
        )
        self._closed = False

    def _execute_one(
        self,
        operation: dict[str, Any],
        *,
        execute_operation: Callable[[dict[str, Any]], dict[str, Any]],
        source_key: str,
        source_capacity_wait_ms: float,
    ) -> QueryBatchResult:
        try:
            packet = execute_operation(operation)
            timing = dict(packet.get("timing") or {})
            timing["source_capacity_wait_ms"] = round(source_capacity_wait_ms, 3)
            timing["pipeline_total_ms"] = round(
                float(timing.get("api_total_ms") or 0) + source_capacity_wait_ms,
                3,
            )
            return QueryBatchResult(
                operation=operation,
                packet={**packet, "timing": timing},
                source_capacity_wait_ms=round(source_capacity_wait_ms, 3),
                completed_monotonic_ms=time.perf_counter() * 1000,
            )
        except Exception as exc:  # noqa: BLE001 - each operation owns its failure.
            return QueryBatchResult(
                operation=operation,
                error=str(exc),
                source_capacity_wait_ms=round(source_capacity_wait_ms, 3),
                completed_monotonic_ms=time.perf_counter() * 1000,
            )
        finally:
            self._capacity.release(source_key)

    def execute(
        self,
        operations: Iterable[dict[str, Any]],
        *,
        execute_operation: Callable[[dict[str, Any]], dict[str, Any]],
        source_key_for: Callable[[dict[str, Any]], str],
        source_limit_for: Callable[[dict[str, Any]], int],
    ) -> Iterator[QueryBatchResult]:
        if self._closed:
            raise RuntimeError("QueryBatchExecutor is closed")
        queued = deque((operation, time.perf_counter()) for operation in operations)
        jobs: dict[Future[QueryBatchResult], str] = {}
        try:
            while queued or jobs:
                deferred = deque()
                while queued:
                    operation, queued_at = queued.popleft()
                    source_key = str(source_key_for(operation) or "unknown-source")
                    if not self._capacity.try_acquire(
                        source_key,
                        source_limit_for(operation),
                    ):
                        deferred.append((operation, queued_at))
                        continue
                    capacity_wait_ms = (time.perf_counter() - queued_at) * 1000
                    try:
                        job = self._executor.submit(
                            self._execute_one,
                            operation,
                            execute_operation=execute_operation,
                            source_key=source_key,
                            source_capacity_wait_ms=capacity_wait_ms,
                        )
                    except BaseException:
                        self._capacity.release(source_key)
                        raise
                    jobs[job] = source_key
                queued = deferred

                if jobs:
                    completed, _pending = wait(tuple(jobs), return_when=FIRST_COMPLETED)
                    results = []
                    for job in completed:
                        jobs.pop(job, None)
                        results.append(job.result())
                    for result in sorted(results, key=lambda item: item.completed_monotonic_ms):
                        yield result
                elif queued:
                    self._capacity.wait_for_change()
        finally:
            for job, source_key in jobs.items():
                # A cancelled-before-start Future never enters _execute_one(), so
                # the generator owns releasing that permit. Running jobs release
                # their own permit in _execute_one()'s finally block.
                if job.cancel():
                    self._capacity.release(source_key)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=True)
