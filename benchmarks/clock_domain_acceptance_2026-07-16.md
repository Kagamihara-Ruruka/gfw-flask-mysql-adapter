# Clock Domain Acceptance - 2026-07-16

## Scope

Checkpoint C separates monotonic wall time, playback cadence time, and render time. It also removes the former playback telemetry timing path and exposes one trusted runtime metrics projection.

## Deterministic Clock Tests

`tests/clock_domain.test.mjs` verifies:

- A simulated 5000 ms buffer wait remains 5000 ms at `1x`, `2x`, and `4x`.
- The buffer timeout remains false at 29,999 ms and becomes true at 30,000 ms at every playback rate.
- Lifecycle events contain `monotonic_ms` and do not retain the former `timestamp` field.
- `consumption_rate`, `supply_rate`, `cache_ready_latency_p95`, `ready_ahead_slices`, and `ready_ahead_seconds` are derived from one event clock.
- Runtime timing owners do not read playback speed or call `Date.now()` / `performance.now()` directly.

Result:

```text
Node contract tests: 100 / 100 passed
Python unittest:      40 / 40 passed
Demo smoke:           passed
Playback smoke:       13 / 13 passed
JavaScript syntax:    passed
```

## External Chrome Incognito

Target:

```text
http://127.0.0.1:5081/?v=clock-domain-checkpoint-c
dataset: pipeline_iceberg.chlor_a
range:   2020-01-01..2020-12-31
```

Cold page load established the canonical frame store and independent preheater before playback. The main-world runtime reported:

```text
Runtime owners:                  21
initial HTTP requests:           11
initial ready-ahead:             10 slices
initial supply rate:             1.25 slices/s
initial cache-ready latency P95: 7943.8 ms
```

Playback then produced five consecutive visible snapshots through 2020-01-06:

```text
FRAME_VISIBLE:          5
stalls:                 0
cadence P95:            1400.9 ms
click-to-first-frame:   94.4 ms
render P95:             76.6 ms
consumption_rate:       0.7143 slices/s
ready_ahead_slices:     5
ready_ahead_seconds:    7.0
buffer_wait_ms:         0
```

Every inspected lifecycle packet used `monotonic_ms`. The status line, event log, and `RuntimePerformanceMetrics` referenced the same `PlaybackEngine` / `PlaybackPreheater` state. The page loaded the current Clock Domain scripts after a clean Flask restart; no new console errors were produced.

## Boundary Result

Clock Domain is now the only runtime timing source. Playback speed changes cadence and consumption rate only. It does not scale queue latency, HTTP latency, cache latency, buffer duration, or timeout. Adaptive watermark behavior is intentionally not part of this checkpoint.
