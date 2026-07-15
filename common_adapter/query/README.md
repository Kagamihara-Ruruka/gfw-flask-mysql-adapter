# Query module

This module owns the query-adapter registry. Database engines and HTTP serving
endpoints are peer data-source adapters here; an HTTP endpoint is not modeled as
a database connection.

Database and endpoint adapters register directly with `query.registry`; there is
no database-specific registry alias in the runtime path.

`snapshot_cache.py` accepts only canonical identities emitted by Mapping
contracts. Source column names and endpoint parameters remain inside their
adapter boundary; cache consumers use internal roles such as dataset, date,
coverage, and resolution.

The canonical snapshot cache applies each mapping's per-namespace entry limit
and the runtime `query_policy.snapshot_cache_max_rows` global row budget. Global
eviction is LRU across namespaces and removes individual completed snapshots;
cancelling queued work never clears the cache.
