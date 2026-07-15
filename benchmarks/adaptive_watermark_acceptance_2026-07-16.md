# Adaptive Watermark Acceptance - 2026-07-16

## Scope

This checkpoint adds one DI-owned `AdaptiveWatermarkController` and three distinct playback gates:

```text
startupWatermark   cold-cache preparation before playback starts
resumeWatermark    minimum contiguous frames before leaving BUFFERING
low/highWatermark  asynchronous replenishment during playback
```

The controller consumes monotonic runtime metrics and the `DataFrameStore` capacity snapshot. It does not own transport, query concurrency, cache eviction, playback cadence, or renderer state.

## Automated Verification

```text
Node contract tests: 117 / 117 passed
Python unittest:       40 / 40 passed
Playback smoke:        15 / 15 passed
Demo smoke:            passed
JavaScript syntax:     92 files passed
git diff --check:      passed
```

Deterministic tests cover warming fallback, supply deficits, tail latency, RAM and configured caps, monotonic decrease hysteresis, read-only policy preview, cold `PREPARING`, multi-frame resume, manual target promotion, and playback-speed isolation.

## Pre-Fix Full-Year Baseline

The first external Chrome incognito sweep exposed the former one-frame recovery policy. Each dataset completed, and every warm-cache replay used zero HTTP requests, but cold playback repeatedly alternated between `BUFFERING` and `PLAYING`.

| Dataset | Cold elapsed | Visible frames | Cold stalls | Cold stall total | Warm elapsed | Warm HTTP | Warm stalls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fishing activity | 267.6 s | 365 | 94 | 136.7 s | 128.4 s | 0 | 0 |
| chlorophyll-a | 251.0 s | 354 | 100 | 124.4 s | 124.9 s | 0 | 0 |
| sea temperature | 267.6 s | 355 | 106 | 136.4 s | 124.5 s | 0 | 0 |
| ocean productivity | 259.8 s | 354 | 103 | 127.9 s | 124.1 s | 0 | 0 |
| sustainability pressure | 243.2 s | 354 | 117 | 115.45 s | 124.9 s | 0 | 0 |

This dataset sweep verified all adapters, mappings, canonical frame identities, and warm-cache reuse. Its stall counts are retained as the before-fix baseline, not as the final acceptance result.

## Final Cold and Warm Runs

Target:

```text
external Chrome incognito
http://127.0.0.1:5081/?v=startup-resume-watermark-v1
dataset: pipeline_iceberg.sustainability_pressure
range:   2020-01-01..2020-12-31
```

Final `1x` cold-cache result:

```text
elapsed:                 509.480 s
FRAME_VISIBLE:           354
HTTP_STARTED:            349
PREPARE_STARTED/READY:   1 / 1
startup ready/required:  10 / 10
preparation P95:         1.390 s
BUFFER_ENTERED:          1
stall total/max:         11.958 s / 11.958 s
stall ratio:             2.35%
consumption/supply:      0.7143 / 0.7098 slices/s
final store entries:     355
unhandled browser errors: 0
```

The cold run no longer resumed once per arriving frame. Preparation is recorded separately from stalls, and only one transient supply miss occurred across the full year.

The same full-year store was then replayed at `4x`:

```text
elapsed:                 127.276 s
FRAME_VISIBLE:           354
HTTP_STARTED:            0
TASK_DISPATCHED:         0
BUFFER_ENTERED:          0
unhandled browser errors: 0
```

This confirms that startup and resume gates do not regress the warm-cache path.

## Unsustainable Supply Degradation

A `4x` cold-cache 91-slice run was used to force supply below consumption:

```text
range:                   2020-01-01..2020-03-31
elapsed:                 64.509 s
FRAME_VISIBLE:           90
startup ready/required:  10 / 10
preparation duration:    1.929 s
consumption/supply:      2.8571 / 1.5559 slices/s
BUFFER_ENTERED:          2
resume gate 1:           30 / 30 slices
resume gate 2:           19 / 19 slices
degradation reasons:     supply_below_consumption, startup_capacity_capped
unhandled browser errors: 0
```

The player did not return to a one-frame gate. When the computed demand exceeded the configured maximum, the event log and UI exposed the capped policy instead of implying that throughput was sufficient.

## Interaction Regression

`pipeline_iceberg.chlor_a` was played at `4x` from 2020-01-01 through 2020-02-29 while the external browser performed:

- one real zoom-button interaction;
- one viewport pan;
- one single-cell virtual-grid selection;
- the resulting Widget cache inspection/query work.

Result:

```text
FRAME_VISIBLE:            59
PLAYBACK_SCOPE_CHANGED:   3
selected virtual cell:    16 km, no-data cell remained selectable
HTTP lanes:               playback-window 85, widget 48, map-current 1
scope-cancelled requests: 9
unhandled browser errors: 0
final date:               2020-02-29
```

All nine `HTTP_FAILED` packets were aborted obsolete `playback-window` requests after BBOX scope changes. They were not provider failures. Completed canonical frames remained in the store, playback reached the end date, and the event-viewer Widget displayed preparation, stalls, supply/consumption, effective watermarks, and degradation state from the shared lifecycle log.

## Boundary Result

- Cold start is `PREPARING`, not a playback stall.
- Buffer recovery requires the current resume watermark and never lowers its gate during one wait.
- Manual seek does not enter startup preparation; it promotes the map target while Preheater replenishment remains background work.
- `playbackSpeed` affects only cadence and consumption rate.
- Adaptive policy never changes query concurrency or clears completed frames.
- Warm-cache replay remains transport-free.
- Event Viewer and Metrics Widget read the same runtime truth as the status line.

