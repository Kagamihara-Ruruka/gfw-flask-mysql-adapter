from __future__ import annotations

from typing import Any, Callable

_BACKENDS: dict[str, type] = {}


def database_backend(kind: str) -> Callable[[type], type]:
    normalized = str(kind).strip().lower()
    if not normalized:
        raise ValueError("database backend kind is required")

    def register(cls: type) -> type:
        if normalized in _BACKENDS:
            raise ValueError(f"database backend already registered: {normalized}")
        _BACKENDS[normalized] = cls
        return cls

    return register


def backend_kinds() -> tuple[str, ...]:
    return tuple(sorted(_BACKENDS))


def resolve_backend_class(kind: str) -> type:
    normalized = str(kind).strip().lower()
    try:
        return _BACKENDS[normalized]
    except KeyError as exc:
        available = ", ".join(backend_kinds()) or "<none>"
        raise ValueError(f"unsupported database backend: {kind!r}; available: {available}") from exc


class UnsupportedBackendOperation(RuntimeError):
    def __init__(self, backend: str, operation: str, detail: str | None = None) -> None:
        message = f"{backend} backend does not support {operation} in this adapter yet"
        if detail:
            message = f"{message}: {detail}"
        super().__init__(message)


def instantiate_backend(kind: str, config: dict[str, Any], dataset: dict[str, Any]):
    backend_cls = resolve_backend_class(kind)
    return backend_cls(config, dataset)
