from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
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

    @property
    def status(self) -> str:
        return "error" if self.error is not None else "ok"


class SourceCapacityPool:
    """Owns in-flight counts for every physical query provider."""

    def __init__(self) -> None:
        self._condition = Condition()
        self._active: dict[str, int] = {}

    def acquire(self, source_key: str, limit: int) -> str:
        key = str(source_key or "unknown-source")
        capacity = normalized_query_concurrency(limit)
        with self._condition:
            while self._active.get(key, 0) >= capacity:
                self._condition.wait()
            self._active[key] = self._active.get(key, 0) + 1
        return key

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
    ) -> QueryBatchResult:
        try:
            return QueryBatchResult(
                operation=operation,
                packet=execute_operation(operation),
            )
        except Exception as exc:  # noqa: BLE001 - each operation owns its failure.
            return QueryBatchResult(operation=operation, error=str(exc))

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
        jobs: list[Future[QueryBatchResult]] = []
        try:
            for operation in operations:
                source_key = self._capacity.acquire(
                    source_key_for(operation),
                    source_limit_for(operation),
                )
                try:
                    job = self._executor.submit(
                        self._execute_one,
                        operation,
                        execute_operation=execute_operation,
                    )
                except BaseException:
                    self._capacity.release(source_key)
                    raise
                job.add_done_callback(
                    lambda _job, key=source_key: self._capacity.release(key)
                )
                jobs.append(job)

            # Preserve query_batch.v1 result order while operations execute concurrently.
            for job in jobs:
                yield job.result()
        finally:
            for job in jobs:
                job.cancel()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=True)
