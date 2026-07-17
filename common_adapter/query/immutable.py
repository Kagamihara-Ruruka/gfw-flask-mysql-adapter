from __future__ import annotations

from typing import Any


def _immutable(*_args: Any, **_kwargs: Any) -> None:
    raise TypeError("canonical values are immutable")


class FrozenDict(dict):
    """JSON-compatible dictionary that rejects mutation after construction."""

    __setitem__ = _immutable
    __delitem__ = _immutable
    clear = _immutable
    pop = _immutable
    popitem = _immutable
    setdefault = _immutable
    update = _immutable
    __ior__ = _immutable


class FrozenList(list):
    """JSON-compatible list that rejects mutation after construction."""

    __setitem__ = _immutable
    __delitem__ = _immutable
    append = _immutable
    clear = _immutable
    extend = _immutable
    insert = _immutable
    pop = _immutable
    remove = _immutable
    reverse = _immutable
    sort = _immutable
    __iadd__ = _immutable
    __imul__ = _immutable


def freeze_json(value: Any) -> Any:
    """Freeze a JSON-shaped value once while preserving JSON serialization."""

    if isinstance(value, (FrozenDict, FrozenList)):
        return value
    if isinstance(value, dict):
        return FrozenDict({key: freeze_json(nested) for key, nested in value.items()})
    if isinstance(value, (list, tuple)):
        return FrozenList(freeze_json(item) for item in value)
    return value


def thaw_json(value: Any) -> Any:
    """Materialize a mutable JSON envelope from an immutable contract value."""

    if isinstance(value, dict):
        return {key: thaw_json(nested) for key, nested in value.items()}
    if isinstance(value, (list, tuple)):
        return [thaw_json(item) for item in value]
    return value
