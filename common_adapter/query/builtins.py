from __future__ import annotations

_REGISTERED = False


def register_builtin_query_adapters() -> None:
    global _REGISTERED
    if _REGISTERED:
        return

    from common_adapter.db.backends import register_builtin_backends
    from common_adapter.endpoint import sampled_grid as _sampled_grid_endpoint

    register_builtin_backends()
    _REGISTERED = True
