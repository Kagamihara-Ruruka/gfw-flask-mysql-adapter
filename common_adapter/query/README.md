# Query module

This module owns the query-adapter registry. Database engines and HTTP serving
endpoints are peer data-source adapters here; an HTTP endpoint is not modeled as
a database connection.

The existing `common_adapter.db.registry` API remains as a compatibility shim
for database adapters that were registered before this boundary existed.

`snapshot_cache.py` accepts only canonical identities emitted by Mapping
contracts. Source column names and endpoint parameters remain inside their
adapter boundary; cache consumers use internal roles such as dataset, date,
coverage, and resolution.
