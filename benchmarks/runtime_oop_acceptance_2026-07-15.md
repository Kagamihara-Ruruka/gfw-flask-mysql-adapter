# Runtime OOP acceptance - 2026-07-15

This report records the external-browser regression run after Runtime state
owners were converted to dependency-injected objects and assembled by the
`RuntimeCompositionRoot`. It verifies that the OOP convergence preserved the
playback, cache, query, selection, Widget, and Renderer contracts established
by the first lifecycle refactor.

## Test conditions

- External Chrome Incognito window at `http://127.0.0.1:5081/`.
- Five sampled-grid datasets, full available 2020 range, sequential 4x playback.
- Query concurrency `6`; low/high watermarks `5/10`.
- Fixed playback BBOX:
  `106.303711,18.291950,133.637695,32.138409`.
- Browser `DataFrameStore` capacity `4 GB` for full-year warm replay.
- Every cold run began with a page reload and an empty browser RAM store; the
  warm run immediately replayed the same scope.
- The source fixture accepted the requested 4 km intent and returned an actual
  16 km frame. Frame identity consistently used the returned resolution.
- Runtime exceptions and network load failures were collected through Chrome
  DevTools Protocol for every run.

`Frames` is the number of visible transitions after the initial frame.
Activation-time preheating can prepare the first few frames before a run begins,
so cold miss and HTTP counts need not be identical.

## Full-year results

| Dataset | Mode | Frames | Miss | HTTP | Stalls | Stall total | Cadence P95 | Render P95 | Elapsed | Browser errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `chlor_a` | cold | 354 | 432 | 344 | 88 | 80.1 s | 1825.3 ms | 64.5 ms | 210.8 s | 0 |
| `chlor_a` | warm | 354 | 0 | 0 | 0 | 0 | 368.0 ms | 57.0 ms | 123.9 s | 0 |
| `sea_temperature` | cold | 355 | 445 | 355 | 100 | 105.9 s | 2228.5 ms | 64.3 ms | 237.5 s | 0 |
| `sea_temperature` | warm | 355 | 0 | 0 | 0 | 0 | 364.4 ms | 54.6 ms | 124.3 s | 0 |
| `ocean_productivity_score` | cold | 354 | 440 | 354 | 96 | 109.4 s | 2307.4 ms | 69.7 ms | 240.7 s | 0 |
| `ocean_productivity_score` | warm | 354 | 0 | 0 | 0 | 0 | 366.5 ms | 56.9 ms | 123.9 s | 0 |
| `sustainability_pressure` | cold | 354 | 438 | 354 | 94 | 103.5 s | 1994.5 ms | 46.4 ms | 234.3 s | 0 |
| `sustainability_pressure` | warm | 354 | 0 | 0 | 0 | 0 | 362.6 ms | 36.6 ms | 123.9 s | 0 |
| `fishing_hours` | cold | 365 | 450 | 365 | 95 | 106.7 s | 2162.2 ms | 50.9 ms | 242.1 s | 0 |
| `fishing_hours` | warm | 365 | 0 | 0 | 0 | 0 | 364.1 ms | 36.5 ms | 127.8 s | 0 |

## Baseline comparison

Compared with the first accepted lifecycle suite, cold elapsed time and total
stall time did not regress:

| Dataset | Previous elapsed | OOP elapsed | Previous stall total | OOP stall total |
| --- | ---: | ---: | ---: | ---: |
| `chlor_a` | 226.5 s | 210.8 s | 94.3 s | 80.1 s |
| `sea_temperature` | 244.5 s | 237.5 s | 111.3 s | 105.9 s |
| `ocean_productivity_score` | 255.0 s | 240.7 s | 124.1 s | 109.4 s |
| `sustainability_pressure` | 252.2 s | 234.3 s | 121.0 s | 103.5 s |
| `fishing_hours` | 247.3 s | 242.1 s | 111.8 s | 106.7 s |

All five warm runs remained zero-HTTP and zero-stall. Their elapsed times stayed
within the expected 4x playback cadence at approximately 124-128 seconds.

## Interaction regression

After the full-year suite, the fishing-hours dataset was exercised through the
real UI with a bounded date range:

1. Playback continued while the map zoom changed the BBOX and preheater scope.
2. Map pan changed the viewport without clearing the 366 completed RAM frames.
3. Single-cell selection accepted a zero/no-data cell at the active 16 km grid.
4. The line, pie, and EEZ Widgets consumed the same `SelectionSession` state.
5. The line-chart expanded view opened and closed through the Widget runtime.
6. Closing selection mode cleared the selected cell and visual resources.

The interaction run produced no Runtime exception or network load failure. The
RAM store retained completed frames and added only the new selection-derived
entry; it was not reset by scope changes or Widget activity.

## Acceptance conclusion

The Runtime OOP convergence is accepted. Each mutable Runtime role has one
owner, instances are composed through the DI root or an explicitly retained
Registry/aggregate factory, teardown is symmetric, and the existing external
contracts remain unchanged. Cold 4x playback is still bounded by source queue
and network throughput, but no new batch gate, duplicate query path, cache
flush, Renderer dependency, or browser error was introduced.
