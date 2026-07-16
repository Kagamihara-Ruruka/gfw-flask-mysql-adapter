# Playback Pipeline and Adaptive Watermark Acceptance - 2026-07-16

## Scope

This is the final acceptance record for the playback, query, canonical-frame cache,
Widget boundary, lifecycle telemetry, and adaptive-watermark changes in this
checkpoint.

The accepted runtime boundaries are:

```text
Map / Playback demand -> QueryScheduler -> Adapter -> DataFrameStore
                                                    -> Renderer
DataFrameStore ------------------------------------> Widgets
```

Widgets are cache-first consumers. During `PREPARING`, `PLAYING`, and
`BUFFERING`, they do not start ordinary source transport. A missing explicit
Tile interaction may request only the current slice through the interactive
lane. The table and Event Viewer are read-only.

## Acceptance Environment

```text
browser:              external Chrome Incognito
tabs:                 one
URL:                  http://127.0.0.1:5081/?v=goal-playback-v36-clean
browser frame budget: 512 MiB
background network:   at most 3
scheduled look-ahead: at most 12 outstanding frames
pipeline playback:    4x
provider service:     existing 8791 process, unchanged
```

"Cold" below means the dataset namespace was absent from the current browser
frame store when the layer was activated. Provider- or adapter-side caches were
not forcibly cleared. "Warm" means an immediate replay in the same browser.
Because a 512 MiB LRU cannot retain a full year of 4 km canonical frames, a
full-year warm replay is not expected to be transport-free.

All reported values were captured when each run finished. The Event Viewer uses
a bounded rolling log, so raw events from early runs can roll out after many
additional full-year runs. JSON export remains an explicit user action; run
completion never opens a download or native file dialog.

## Automated Verification

```text
Node contract tests: 157 / 157 passed
Python unittest:       40 / 40 passed
JavaScript syntax:     93 files passed
git diff --check:      passed
UTF-8 validation:      passed
```

## External Browser Results

Every run below ended normally. `Buffer` is `BUFFER_ENTERED / BUFFER_RESUMED`.
All runs had zero `HTTP_FAILED`, zero active stalls after completion, and one
matched `PREPARE_STARTED / PREPARE_READY` pair.

| Dataset | Mode | Visible | HTTP | Buffer | First frame | Stall ratio | Network P95 | Queue P95 | Render P95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sea temperature | cold + interaction | 341 | 364 | 6 / 6 | 2.684 s | 8.16% | 4.173 s | 12.380 s | 0.113 s |
| sea temperature | warm | 355 | 341 | 22 / 22 | 0.193 s | 65.75% | 4.072 s | 10.227 s | 0.157 s |
| chlorophyll-a | cold | 354 | 336 | 21 / 21 | 0.183 s | 63.47% | 5.752 s | 15.516 s | 0.395 s |
| chlorophyll-a | warm | 354 | 339 | 18 / 18 | 0.609 s | 53.03% | 6.151 s | 17.469 s | 0.463 s |
| ocean productivity | cold | 354 | 333 | 19 / 19 | 0.723 s | 59.88% | 5.402 s | 14.392 s | 0.285 s |
| ocean productivity | warm | 354 | 354 | 22 / 22 | 18.201 s | 62.35% | 5.516 s | 14.131 s | 0.253 s |
| sustainability pressure | cold | 354 | 336 | 22 / 22 | 0.548 s | 66.86% | 5.329 s | 13.621 s | 0.234 s |
| sustainability pressure | warm | 354 | 354 | 21 / 21 | 17.084 s | 62.99% | 4.981 s | 13.348 s | 0.279 s |
| fishing hours | cold | 365 | 347 | 19 / 19 | 0.617 s | 55.37% | 5.540 s | 16.221 s | 0.431 s |
| fishing hours | warm | 365 | 365 | 18 / 18 | 17.437 s | 48.51% | 5.707 s | 16.477 s | 0.443 s |
| GFW January 2024 | after layer load | 30 | 0 | 0 / 0 | 0.697 s | 0% | 0 | 0 | 0.282 s |
| GFW January 2024 | warm | 30 | 0 | 0 / 0 | 0.684 s | 0% | 0 | 0 | 0.286 s |

The four `pipeline_iceberg` datasets contain 355 playback dates except fishing
hours, which contains all 366 dates in leap year 2020. `FRAME_VISIBLE` excludes
the already-visible first date, so the completed counts are 354 and 365.

The GFW layer contains 31 dates in January 2024. Layer activation prepared the
small month entirely inside the frame budget, so both playback runs were real
cache-only consumers with zero playback transport.

## Deep Interaction Run

The sea-temperature cold run covered 2020-01-15 through 2020-12-31 and mixed:

- 1x, 2x, and 4x rate changes;
- map zoom and pan;
- single virtual-grid selection;
- line, pie, EEZ attribution, and table Widget updates.

Results:

```text
PLAYBACK_SCOPE_CHANGED: 4
QUERY_SCOPE_CANCELLED:  5
HTTP_CANCELLED:         11 obsolete background requests
HTTP_FAILED:            0
Widget HTTP:            0
Widget tasks:           0
final DataFrameStore:   536,848,122 / 536,870,912 bytes
```

The selected no-data cell remained selectable. Scope changes cancelled obsolete
queued/background work without clearing completed canonical frames. Widget
updates consumed the selected snapshot from `DataFrameStore` and did not compete
with map playback transport.

## AIS and EEZ Smoke

AIS was enabled in the same Incognito tab after playback acceptance:

```text
collector state:   SQL collector writing
visible vessels:   437
SQL inventory:     127,968
received records:  36,924,920
written records:   36,862,571
```

AIS correctly switched the dashboard to live mode and disabled historical
playback controls. EEZ remained enabled throughout. The deep interaction run
also verified selected-cell EEZ attribution and Widget rendering.

## Runtime Invariants

- All 12 playback runs finished with `reason=ended`.
- Every entered buffer had one matching resume event.
- No run ended with an active stall or permanent `FETCHING` state.
- No run emitted `HTTP_FAILED`.
- The browser store remained below its 512 MiB byte budget.
- GFW replay performed no playback HTTP.
- Pipeline Widgets did not create an independent query stream.
- Incognito console errors and warnings were both zero.
- Exactly one Chrome tab remained open during acceptance.
- Playback completion did not request a JSON download or open a native save dialog.

## Throughput Boundary

The pipeline datasets cannot sustain the 4x target cadence of 2.857 slices/s on
the current source/adapter path. Their completed-run supply rates were roughly
0.59-0.75 slices/s. Network P95 was about 5-6 seconds and queue P95 about 13-17
seconds, while render P95 stayed below 0.47 seconds.

This is an explicit degraded mode, not a hidden frontend failure. The player
waits for a multi-frame resume watermark and reports
`supply_below_consumption`; it does not return to a one-frame gate, clear the
cache, or pretend that 4x is sustainable. The 8791 provider and its DuckDB/JSON
path were not modified in this checkpoint.

## Boundary Result

- Cold startup and mid-run recovery have separate gates.
- Playback, Preheater, Scheduler, Store, Renderer, and Widgets have independent
  owners and communicate through state rather than blocking batch promises.
- Requested, effective-query, and actual render resolutions remain distinct;
  the virtual selection grid follows the actual rendered grid.
- Active playback uses cache-only Widgets; cache misses are filled through the
  centralized demand service and scheduler.
- Completed cache entries survive task promotion, scope cancellation, and
  Widget interaction.
- Runtime timing is monotonic and is not scaled by playback speed.
- Event Viewer, status, and metrics consume one lifecycle truth.

The frontend boundary is stable for this checkpoint. Remaining 4x latency is a
measured source/adapter throughput limit, not a reason to add unbounded browser
cache or extra frontend concurrency.
