"""Query adapter registry shared by database and endpoint sources."""

from common_adapter.query.builtins import register_builtin_query_adapters

__all__ = ["register_builtin_query_adapters"]
