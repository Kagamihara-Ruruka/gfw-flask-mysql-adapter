"""Compatibility names for database adapters in the generic query registry."""

from common_adapter.query.registry import (
    UnsupportedQueryOperation,
    instantiate_query_adapter,
    query_adapter,
    query_adapter_kinds,
    resolve_query_adapter_class,
)

database_backend = query_adapter
backend_kinds = query_adapter_kinds
resolve_backend_class = resolve_query_adapter_class
instantiate_backend = instantiate_query_adapter
UnsupportedBackendOperation = UnsupportedQueryOperation
