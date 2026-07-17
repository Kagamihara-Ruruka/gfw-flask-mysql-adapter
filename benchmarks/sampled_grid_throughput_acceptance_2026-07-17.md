# Sampled Grid Throughput Acceptance - 2026-07-17

## Scope

This checkpoint validates the 5081 sampled-grid path after removing repeated Mapping work,
canonical row-graph copies, provider-capacity drift, batch head-of-line blocking, and
unmeasured transport stages. It does not modify the external 8791 API, Canonical Frame
semantics, the Renderer contract, or UI behavior.

The validated path is:

```text
QueryBroker
-> POST /api/query/batch
-> QueryBatchExecutor
-> Pipeline Iceberg adapter
-> compiled Mapping
-> immutable canonical snapshot cache
-> render transport projection
-> completion-order NDJSON result(operation_id)
-> DataFrameStore
```

## Implemented Boundaries

- The adapter compiles source fields, request fields, geometry, alignment, available
  resolutions, canonical columns, coverage, cache semantics, and visualization semantics
  once per dataset instance.
- Row Mapping remains a pure single-pass function and receives the immutable compiled
  context instead of reparsing the dataset contract per row.
- Canonical rows are frozen exactly once at server cache commit. Cache hits, API envelopes,
  Widgets, and Renderer consumers share the same immutable row graph.
- An already canonical `rrkal.sampled_grid.v1` packet receives only a shallow envelope;
  it is not canonicalized or deeply copied again.
- `column_profile=render` is a real transport projection. Frame-level date and resolution
  are lifted out of rows, canonical row fields are described dynamically, and the browser
  inflates the packet before existing consumers see it.
- `/api/datasets` publishes provider capacity. The browser dispatches
  `min(batch_max_operations, source_capacity, available_slots)`, and Flask enforces the
  same capacity across requests.
- Results are streamed in completion order and identified by `operation_id`. Releasing one
  operation immediately backfills the highest-priority queued operation without waiting
  for the rest of its former batch.
- Cancelling queued work releases any acquired provider permit. Cancelling, promotion, or
  foreground insertion does not restart active work or evict completed frames.

## Controlled 30-Frame A/B

The final run used disjoint date windows, the same Taiwan AOI, sea-temperature metric,
4 km resolution, and 30 frames per mode. The 5081 service was restarted before the run so
the first pass for each adapter window was cold.

| Path | Mode | Frames | Failures | Throughput | HTTP P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8791 direct | concurrency 1 | 30 | 0 | 1.419 fps | 730.519 ms/frame |
| 8791 direct | concurrency 2 | 30 | 0 | 2.569 fps | 909.815 ms/frame |
| 5081 | batch 1 cold | 30 | 0 | 0.866 fps | 1,251.706 ms/batch |
| 5081 | batch 2 cold | 30 | 0 | **1.095 fps** | **2,278.398 ms/2 frames** |
| 5081 | batch 2 warm | 30 | 0 | **4.512 fps** | 643.890 ms/2 frames |

The cold batch=2 path exceeds the 0.86 fps acceptance floor and the 2.33-second P95 ceiling.
The batch=3 capacity guard returned HTTP 400 when the provider capacity was 2.

## Timing Truth

Cold batch=2 P95 measurements:

| Phase | P95 |
| --- | ---: |
| Provider capacity wait | 2.272 ms |
| 8791 HTTP | 1,105.698 ms |
| Canonicalize rows | 525.304 ms |
| Canonical packet envelope | 0.004 ms |
| Cache commit | 21.510 ms |
| Cache eviction | 8.779 ms |
| Packet projection | 344.949 ms |
| API total | 1,794.091 ms |
| Unattributed API time | 14.386 ms |
| Batch encode | 153.608 ms |
| Batch gzip | 139.205 ms |
| Downstream yield | 167.370 ms |

Warm batch=2 had 30/30 cache hits and a 0.026 ms service-cache lookup P95. The maximum
timing-reconciliation error was 0.151%, below the 10% acceptance ceiling. `serialize_ms`
now describes serialization only; capacity wait, provider HTTP, Mapping, cache, projection,
encoding, gzip, downstream yield, and response bytes are independently observable.

## User-Level Playback Acceptance

One controlled Chrome tab was used throughout the final interaction run. Old test tabs were
closed so they could not add provider load. Every Pipeline Iceberg sampled-grid dataset was
enabled through the data-layer UI and played from 2020-01-01 to its final advertised 2020
date at 1x:

| Dataset | Advertised dates | Final state | Permanent FETCHING | User stall |
| --- | ---: | --- | ---: | ---: |
| `pipeline_iceberg.fishing_hours` | 366 | `ENDED` | 0 | 0 |
| `pipeline_iceberg.chlor_a` | 355 | `ENDED` | 0 | 0 |
| `pipeline_iceberg.ocean_productivity_score` | 355 | `ENDED` | 0 | 0 |
| `pipeline_iceberg.sea_temperature` | 356 | `ENDED` | 0 | 0 |
| `pipeline_iceberg.sustainability_pressure` | 355 | `ENDED` | 0 | 0 |

Sea temperature was additionally exercised with `1x -> 2x -> 1x`, zoom, map drag, virtual
grid selection, cache-backed line-chart rendering, and Event Viewer inspection. It did not
deadlock, clear completed frames, or leave a permanent fetch state. A short buffer event at
2x is an explained supply boundary: 2x consumes about 1.43 frames/s while the measured full
5081 cold supply is 1.095 frames/s. The 1x requirement is about 0.714 frames/s.

## Regression Evidence

```text
Python unittest: 62 passed
Node test runner: 194 passed
30-frame cold/warm benchmark: all modes completed, zero frame failures
Batch=3 at provider capacity 2: HTTP 400
Five sampled-grid datasets: full advertised 2020 range reached ENDED at 1x
```

The automated architecture suite protects these invariants:

- one source operation permit per actual in-flight operation;
- no duplicate HTTP for one frame key;
- no canonical row deep copy on cache hit or API envelope construction;
- completion-order results restore identity through `operation_id`;
- cache hits do not query the provider;
- Widget and Renderer code do not own sampled-grid transport;
- promotion and cancellation do not clear completed cache entries;
- source schema remains outside generic frontend pipeline code.

## Residual Boundary

The remaining cold cost is dominated by provider HTTP, Mapping, render projection, and wire
encoding/compression. The acceptance target for 1x is met without raising RAM, watermarks,
or provider concurrency. Sustained 2x playback cannot be guaranteed while cold full-path
supply remains below 1.43 fps; that is a measured throughput boundary, not a playback-state
deadlock. Further work on 8791 DuckDB execution or its external response schema requires a
separate upstream task.

## Reproduction

```powershell
python -m unittest discover -s tests
node --test tests/*.test.mjs
python scripts\sampled_grid_batch_benchmark.py `
  --dataset pipeline_iceberg.sea_temperature `
  --frames 30 `
  --output "$env:TEMP\sampled-grid-batch-final.json"
```
