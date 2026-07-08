from __future__ import annotations

_REGISTERED = False


def register_builtin_backends() -> None:
    global _REGISTERED
    if _REGISTERED:
        return

    from common_adapter.db.backends import hive as _hive_backend  # noqa: F401
    from common_adapter.db.backends import mysql as _mysql_backend  # noqa: F401
    from common_adapter.db.backends import spark as _spark_backend  # noqa: F401

    _REGISTERED = True
