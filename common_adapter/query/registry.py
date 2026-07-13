from __future__ import annotations

from typing import Callable

_QUERY_ADAPTERS: dict[str, type] = {}


def query_adapter(kind: str) -> Callable[[type], type]:
    normalized = str(kind).strip().lower()
    if not normalized:
        raise ValueError("query adapter kind is required")

    def register(cls: type) -> type:
        if normalized in _QUERY_ADAPTERS:
            raise ValueError(f"query adapter already registered: {normalized}")
        _QUERY_ADAPTERS[normalized] = cls
        return cls

    return register


def query_adapter_kinds() -> tuple[str, ...]:
    return tuple(sorted(_QUERY_ADAPTERS))


def resolve_query_adapter_class(kind: str) -> type:
    normalized = str(kind).strip().lower()
    try:
        return _QUERY_ADAPTERS[normalized]
    except KeyError as exc:
        available = ", ".join(query_adapter_kinds()) or "<none>"
        raise ValueError(
            f"unsupported query adapter: {kind!r}; available: {available}"
        ) from exc


class UnsupportedQueryOperation(RuntimeError):
    def __init__(self, adapter: str, operation: str, detail: str | None = None) -> None:
        message = f"{adapter} query adapter does not support {operation} yet"
        if detail:
            message = f"{message}: {detail}"
        super().__init__(message)


def instantiate_query_adapter(kind: str, config: dict, dataset: dict):
    adapter_cls = resolve_query_adapter_class(kind)
    return adapter_cls(config, dataset)
