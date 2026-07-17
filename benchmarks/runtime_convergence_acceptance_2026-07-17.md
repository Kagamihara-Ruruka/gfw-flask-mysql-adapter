# Runtime Convergence Acceptance - 2026-07-17

## Scope

This checkpoint validates the convergence of the Mapping truth chain, provider-level query batching, streamed result splitting, shared canonical RAM cache, playback replenishment policy, and Runtime ownership boundaries.

The acceptance baseline for interactive checks is the Codex side browser. External Chrome takeover was excluded after the host policy changed; it is not reported as a product failure and is not represented as an executed test.

## Runtime Truth Chain

The inspected control-plane chain was:

```text
enabled source Config
-> route state machine
-> schema/catalog inspection
-> Mapping artifact
-> RuntimeLayerRegistry
-> dashboard layer contract
-> query intent
-> canonical frame
```

Observed state:

- `local_database` and `pipeline_iceberg` were both enabled under `DATABASE`.
- Pipeline Iceberg reported enabled, connected, and schema-ready (`1 / 1 / 1`).
- The inspector exposed six tables: one local GFW table and five Pipeline Iceberg catalog layers.
- The dashboard import registry exposed AIS, EEZ, GFW, and all five Pipeline Iceberg layers as `READY`.
- Mapping roles for Pipeline Iceberg selected date, cell identity, latitude, longitude, value, resolution, coverage, and data status. Only unrelated columns remained `do not query`.
- A configured `default_coverage_id` selects the initial coverage. Nested coverage routing chooses one source coverage instead of unioning intersecting AOIs.
- Sea temperature opened at 4 km without a false 16 km fallback.

## Query and Cache Boundaries

```text
QueryScheduler
-> QueryBroker
-> POST /api/query/batch
-> NDJSON batch events
-> operation demultiplex
-> DataFrameStore
```

Validated invariants:

- compatible operations can share one physical adapter request;
- each physical provider has at most one active batch lane;
- results are consumed incrementally instead of waiting for the whole response;
- one failed operation does not discard successful siblings;
- a foreground operation can preempt at an operation boundary;
- exact and containing-BBOX requests share an in-flight or completed canonical frame;
- cache hits do not issue another source request;
- Widgets and the table remain cache-first, and the table is strictly read-only;
- cancellation does not clear completed canonical frames;
- dataset identity remains separate even when datasets share a provider lane;
- configured, routed, and actual resolutions remain distinct identities.

The Flask batch route also passed incremental gzip and operation-isolation tests.

## Full-Year Data Audit

The benchmark used one cold worker, a 30-date warm pass, the finest Mapping resolution, and interaction probes.

| Dataset | Dates | Failures | Cold median / P95 | Warm hits / P95 | Actual resolution |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pipeline_iceberg.fishing_hours` | 366 | 0 | 781 ms / 1,113 ms | 30 / 30 / 67 ms | 4 km |
| `pipeline_iceberg.chlor_a` | 355 | 0 | 793 ms / 1,088 ms | 30 / 30 / 61 ms | 4 km |
| `pipeline_iceberg.ocean_productivity_score` | 355 | 0 | 803 ms / 1,183 ms | 30 / 30 / 65 ms | 4 km |
| `pipeline_iceberg.sea_temperature` | 356 | 0 | 781 ms / 1,006 ms | 30 / 30 / 63 ms | 4 km |
| `pipeline_iceberg.sustainability_pressure` | 355 | 0 | 762 ms / 1,190 ms | 30 / 30 / 75 ms | 4 km |
| `gfw_full` | 31 | 0 | 31 ms / 56 ms | 30 / 30 / 31 ms | 9.28 km |

All 1,818 advertised dates completed. Pipeline Iceberg had no LOD degradation. Its snapshot cache stayed inside the global 800,000-row budget.

## Side-Browser Interaction Audit

Sea temperature was exercised from a fresh page with no default layer enabled:

- layer activation rendered the first 4 km frame;
- one `HTTP_BATCH_STARTED` event accepted three simultaneous playback-window operations, which then completed as three streamed operation results without parallel provider requests;
- playback continued through `1x -> 2x -> 4x -> 1x` changes;
- zoom and keyboard map movement did not leave playback stuck;
- a selected 4 km virtual cell populated line and pie Widgets from canonical cache;
- opening the table during the same runtime displayed the selected current snapshot without starting its own query;
- table latitude, longitude, values, resolution, coverage, and bounds were formatted at the View boundary without mutating canonical data;
- the developer page showed the route, schema, Mapping, and imported-layer states described above.

## Automated Regression

```text
Python unittest: 51 passed
Node test runner: 186 passed
JavaScript syntax: passed for every static/js module
Demo smoke: passed
```

The architecture suite prohibits direct Widget/Renderer transport, playback-owned cache eviction, source-specific fields in the generic frame pipeline, playback-rate use outside the playback clock, self-created class dependencies, mutable static singletons, and legacy GFW compatibility entrypoints.

## Residual Boundaries

- The Pipeline Iceberg provider still needs roughly 0.8 seconds for one cold 4 km date and exposes no useful repeated-query result cache. The adapter does not hide this with uncontrolled concurrency.
- `config/artifacts/layer_mappings.local.json` is Runtime state and remains intentionally ignored by Git. Production deployment must provide or generate its Mapping artifact.
- External Chrome Incognito must be rerun when browser takeover is available again; the current interactive baseline is the side browser.
- The aerial backdrop provider returned HTTP 502 during one selected-tile interaction. It is independent of sampled-grid Mapping, playback, and cache correctness and was not patched in this checkpoint.
