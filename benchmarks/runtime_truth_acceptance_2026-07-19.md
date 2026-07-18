# Runtime Truth and User-Storm Acceptance

Date: 2026-07-19

## Scope

This checkpoint closes the Runtime truth findings recorded on 2026-07-18. It verifies physical Frame identity, playback buffer ownership, demand/run lineage, non-overlapping timing spans, UI lifecycle disposal, request coalescing, and full-year user interaction behavior. It does not introduce Arrow, Topology Split, a new Renderer contract, or a source API change.

## Ownership Changes

| Truth or resource | Owner after remediation |
| --- | --- |
| requested/query/actual resolution identity | `FrameIdentity` plus `DataFrameStore` compatibility rules |
| playback state and one active buffer episode | `PlaybackEngineCore` |
| playback timer and session generation | `PlaybackRuntimeController` |
| 30-second target timeout | `PlaybackEngineCore`, using the injected monotonic clock |
| demand creation run identity | `FrameDemandServiceCore` |
| sampled-grid provider batch and deduplication | `QueryBroker` |
| canonical frame state | `DataFrameStoreCore` |
| API timing critical path | sampled-grid endpoint plus HTTP route timing ledger |
| aerial background browser resources | `AerialBackdropController` UI owner |
| performance chart scheduling resources | `SnapshotPerformanceChart` UI owner |
| metrics Widget subscriptions | metrics capability instance |

The UI remains a projection and command surface. It no longer decides buffer timeout or terminal playback state. Stateful DOM-only helpers retain UI ownership instead of being promoted into the data Runtime, but they now have explicit, symmetric disposal.

## Automated Regression

| Suite | Result |
| --- | ---: |
| Node contracts and architecture tests | 233 checks passed |
| Python service and route tests | 96 passed |
| Historical design audit | 8 checks passed |
| Server traceback/error scan | 0 |

The deterministic playback tests inject the same 30-second target delay at 1x, 2x, and 4x. All three use 30 seconds of monotonic wall time. A superseded buffer episode cannot resume or fail a newer episode, and a late demand completion retains the run identity captured when that demand was created.

## Controlled Throughput Smoke

Three dates of `pipeline_iceberg.sea_temperature` were measured against a fresh 5085 adapter process and the existing 8791 source.

| Path | Result |
| --- | ---: |
| 8791 direct, concurrency 1 | 1.488 fps |
| 8791 direct, concurrency 2 | 1.993 fps |
| 5085 batch 1 cold | 1.390 fps |
| 5085 batch 2 cold | 1.912 fps |
| 5085 batch 2 warm | 15.309 fps |
| API timing reconciliation error | 0% |
| canonical packet copy | approximately 0.002 ms |

A three-operation batch remains rejected when provider capacity is two. The timing ledger declares non-overlapping API phases, and the batch metrics snapshot explicitly excludes its own metrics event instead of silently pretending that self-observation is part of the preceding batch.

## Query Storm

Command:

```powershell
python scripts\sampled_grid_query_storm.py `
  --base-url http://127.0.0.1:5085 `
  --output logs\runtime-truth-query-storm.json
```

| Scenario | Result |
| --- | ---: |
| Duplicate clients for one Frame | 12 |
| Duplicate requests completed | 12 |
| Source requests for duplicate Frame | 1 |
| Cache/in-flight reuse | 11 |
| Duplicate throughput | 11.491 fps |
| Mixed unique Frames | 15 |
| Mixed datasets | 5 |
| Mixed failures | 0 |
| Mixed throughput | 2.618 fps |
| Required floor | 0.860 fps |

Every unique mixed Frame produced exactly one source request. Concurrent consumers of the same Frame joined one physical operation and did not clear completed cache state.

## Full-Year Side-Browser Acceptance

One visible side-browser tab was retained for the complete run. Old tabs were not left open. EEZ remained enabled while each sampled-grid dataset traversed its 2020 date range.

| Dataset | Full-year result | Interaction coverage |
| --- | --- | --- |
| `pipeline_iceberg.chlor_a` | completed | 1x/2x/4x/1x, z6 to z7, drag, selected cell, Widgets |
| `pipeline_iceberg.fishing_hours` | completed | 4x buffering, 2x resume, selected cell, Event Viewer |
| `pipeline_iceberg.ocean_productivity_score` | completed | seek to September during buffering, then 2x completion |
| `pipeline_iceberg.sustainability_pressure` | completed | switched from an active sea-temperature run, then z6 to z7 during 2x playback |
| `pipeline_iceberg.sea_temperature` | completed | 4x supply exhaustion, stable 1x recovery, then 2x completion |

The active sea-temperature run was replaced while its old scope still had pending work. Sustainability reset to 2020-01-01 and was not overwritten by late sea-temperature completion. Sea temperature later remained stable at 1x from late March through July before completing at 2x. Browser warning/error logs stayed empty for all five datasets.

At 4x, the physical source cannot always sustain the 2.86 frame/s consumption rate, so honest buffering remains expected. The acceptance requirement is that the episode is singular, recoverable, and cannot create a second timer chain or overwrite a newer run. At 1x, playback remained supply-safe after recovery.

## Verdict

- physical resolution identity no longer aliases a requested 4 km intent with a different effective query resolution;
- one `PlaybackBufferEpisode` owns target waiting, timeout, resume, and supersession;
- run identity is captured before asynchronous dispatch and survives late completion;
- focus/visibility no longer re-probes every source; explicit developer invalidation still refreshes control-plane truth;
- sampled-grid duplicate HTTP remains one per Frame;
- five datasets complete full-year user storms without crash, permanent fetching, stale scope overwrite, or console error;
- the Runtime truth checkpoint is eligible for the stable main-branch checkpoint.
