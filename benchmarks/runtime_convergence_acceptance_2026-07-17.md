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
- Sea temperature retains a 4 km configured selection grid while the current provider response explicitly reports a 16 km source fallback as `4 km -> 16 km`. Selection identity and source fallback are not silently conflated.

## Query and Cache Boundaries

```text
FrameDemandService
-> QueryBroker
-> POST /api/query/batch
-> QueryBatchExecutor
-> Mapping-backed query adapter
-> NDJSON batch events
-> operation demultiplex
-> DataFrameStore
```

Validated invariants:

- compatible operations can share one physical adapter request;
- each physical provider has at most one active browser HTTP batch lane;
- decompressed operations use one Flask-owned worker pool and a provider capacity shared across browser requests;
- results are consumed incrementally instead of waiting for the whole response;
- one failed operation does not discard successful siblings;
- promotion of the first unfinished operation does not restart its active batch, while a later foreground operation may request preemption at a real operation boundary;
- exact and containing-BBOX requests share an in-flight or completed canonical frame;
- cache hits do not issue another source request;
- Widgets and the table remain cache-first, and the table is strictly read-only;
- cancellation does not clear completed canonical frames;
- dataset identity remains separate even when datasets share a provider lane;
- configured, routed, and actual resolutions remain distinct identities.

The Flask batch route also passed incremental gzip, operation isolation, preserved result ordering, global worker-bound, and per-provider capacity tests.

## Historical Full-Year Source Audit

This earlier benchmark used one cold worker, a 30-date warm pass, the finest Mapping resolution available at that run, and interaction probes. It remains evidence for advertised-date availability, but its resolution column predates the provider's current explicit 16 km fallback and is not the current resolution assertion.

| Dataset | Dates | Failures | Cold median / P95 | Warm hits / P95 | Actual resolution |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pipeline_iceberg.fishing_hours` | 366 | 0 | 781 ms / 1,113 ms | 30 / 30 / 67 ms | 4 km |
| `pipeline_iceberg.chlor_a` | 355 | 0 | 793 ms / 1,088 ms | 30 / 30 / 61 ms | 4 km |
| `pipeline_iceberg.ocean_productivity_score` | 355 | 0 | 803 ms / 1,183 ms | 30 / 30 / 65 ms | 4 km |
| `pipeline_iceberg.sea_temperature` | 356 | 0 | 781 ms / 1,006 ms | 30 / 30 / 63 ms | 4 km |
| `pipeline_iceberg.sustainability_pressure` | 355 | 0 | 762 ms / 1,190 ms | 30 / 30 / 75 ms | 4 km |
| `gfw_full` | 31 | 0 | 31 ms / 56 ms | 30 / 30 / 31 ms | 9.28 km |

All 1,818 advertised dates completed in that run. Its snapshot cache stayed inside the global 800,000-row budget.

## Provider Capacity Audit

The same direct 8791 date workload was measured before exposing source capacity:

| Direct provider concurrency | Dates | Elapsed | Throughput | Mean | P95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 24 | 15.954 s | 1.504 slices/s | 664.5 ms | 690 ms |
| 2 | 24 | 9.031 s | 2.658 slices/s | 752.3 ms | 845 ms |

Repeating concurrency 1 reproduced 1.504 slices/s. The Pipeline Iceberg source example therefore declares `query_policy.max_in_flight: 2`; absent source policy still defaults to 1. A controlled three-operation cold `/api/query/batch` request improved from 2.994 s on the sequential route to 2.284 s through the capacity-aware executor while preserving operation order. A final post-restart transport-only run under later provider load completed three cold operations and about 19.7 MB of NDJSON in 4.231 s with HTTP 200; one direct 8791 snapshot was then about 2.7 s, confirming provider variance rather than an executor deadlock.

## Side-Browser Interaction Audit

Sea temperature was exercised from a fresh page with no default layer enabled. The final acceptance used a 4 GB browser cache budget and one complete 1x 2020 run:

- the run reached `2020-12-31` and `ENDED` after 354 playback-visible frames beyond the already-visible January 1 frame;
- it recorded zero stalls and no cumulative or maximum stall duration;
- click-to-first-frame was 50.9 ms and visible-frame cadence P95 was 1.48 s;
- one `HTTP_BATCH_STARTED` event accepted three simultaneous playback-window operations, which completed under the measured two-operation provider capacity;
- playback continued through a temporary `1x -> 2x -> 1x` change;
- zoom and keyboard map movement did not leave playback stuck;
- a selected 4 km virtual cell populated line and pie Widgets from canonical cache;
- opening the table during the same runtime displayed the selected current snapshot without starting its own query;
- table latitude, longitude, values, resolution, coverage, and bounds were formatted at the View boundary without mutating canonical data;
- the browser console contained no errors at completion;
- the developer page showed the route, schema, Mapping, and imported-layer states described above.

## Automated Regression

```text
Python unittest: 56 passed
Node test runner: 193 passed
Playback smoke: 18 passed
JavaScript syntax: passed for every static/js module
Demo smoke: passed
```

The architecture suite prohibits direct Widget/Renderer transport, playback-owned cache eviction, source-specific fields in the generic frame pipeline, playback-rate use outside the playback clock, self-created class dependencies, mutable static singletons, and legacy GFW compatibility entrypoints.

## Residual Boundaries

- The Pipeline Iceberg provider still has marginal cold supply and exposes no useful repeated-query result cache. The adapter uses the measured two-operation capacity instead of hiding this with uncontrolled concurrency.
- The provider currently returns an explicit 16 km source fallback for a configured 4 km request. Virtual-grid identity remains 4 km; correcting source resolution is a separate Mapping/provider contract task, not a playback refill patch.
- `config/artifacts/layer_mappings.local.json` is Runtime state and remains intentionally ignored by Git. Production deployment must provide or generate its Mapping artifact.
- The current interactive acceptance baseline is the Codex side browser because external Chrome takeover is unavailable under the current host policy.
- The aerial backdrop provider returned HTTP 502 during one selected-tile interaction. It is independent of sampled-grid Mapping, playback, and cache correctness and was not patched in this checkpoint.
