from __future__ import annotations

from collections.abc import Callable, Hashable, Iterable
from threading import RLock
from typing import Generic, TypeVar


Item = TypeVar("Item")
Key = TypeVar("Key", bound=Hashable)
Value = TypeVar("Value")


def unique_by(items: Iterable[Item], *, key: Callable[[Item], Key]) -> list[Item]:
    """Return the first item for each semantic key while preserving order."""
    seen: set[Key] = set()
    unique: list[Item] = []
    for item in items:
        identity = key(item)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(item)
    return unique


def group_by_key(
    items: Iterable[Item],
    *,
    key: Callable[[Item], Key],
) -> dict[Key, list[Item]]:
    """Group items by a caller-defined semantic key while preserving order."""
    groups: dict[Key, list[Item]] = {}
    for item in items:
        groups.setdefault(key(item), []).append(item)
    return groups


class KeyedRegistry(Generic[Key, Value]):
    """Intern shared values by semantic identity."""

    def __init__(self) -> None:
        self._values: dict[Key, Value] = {}
        self._lock = RLock()

    def __len__(self) -> int:
        with self._lock:
            return len(self._values)

    def get(self, key: Key) -> Value | None:
        with self._lock:
            return self._values.get(key)

    def intern(self, key: Key, factory: Callable[[], Value]) -> Value:
        with self._lock:
            existing = self._values.get(key)
            if existing is not None:
                return existing
            value = factory()
            self._values[key] = value
            return value

    def values(self) -> tuple[Value, ...]:
        with self._lock:
            return tuple(self._values.values())
