# Playback lifecycle acceptance - 2026-07-15

> Historical checkpoint only. This report records the former 2 GB browser-cache
> default and predates the 512 MiB bounded-store, startup/resume-watermark, and
> final pipeline acceptance changes. Use
> [`adaptive_watermark_acceptance_2026-07-16.md`](adaptive_watermark_acceptance_2026-07-16.md)
> for current runtime behavior and acceptance results.

This report records the first external-browser acceptance run after separating
playback, preheating, query scheduling, the canonical DataFrame store, and
rendering. It is evidence for the current lifecycle contract, not a claim that
cold-source throughput has been optimized.

## Test conditions

- External Chrome Incognito window, not the embedded browser.
- Local service at `http://127.0.0.1:5081/`.
- Five time-series datasets, full available 2020 range, sequential 4x playback.
- Query concurrency `6`; low/high watermarks `5/10`.
- Fixed playback scope BBOX:
  `106.303711,18.291950,133.637695,32.138409`.
- The full-year warm-cache runs used the existing cache setting at `4 GB`.
  The default remains `2 GB`.
- Each cold-browser run began with a fresh page and empty `DataFrameStore`.
  The server process was restarted before the suite and each dataset namespace
  was untouched before its cold run.
- Chlorophyll cold playback also exercised zoom, pan, single-tile selection,
  line/pie/EEZ widgets, the cache-backed table widget, and the event viewer.

`frameCount` below is the number of visible transitions after the initial
frame. Run-scoped HTTP counts begin when Play is pressed; activation-time
preheating may have prepared up to the configured high watermark beforehand.

## Results

| Dataset | Mode | Frames | Miss | HTTP | Stalls | Stall total | Cadence P95 | Render P95 | Elapsed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `chlor_a` | cold + interactions | 354 | 1297 | 544 | 99 | 94.3 s | 1983.6 ms | 101.7 ms | 226.5 s |
| `chlor_a` | warm fixed scope | 354 | 0 | 0 | 0 | 0 | 359.9 ms | 42.9 ms | 123.9 s |
| `sea_temperature` | cold, default 2 GB | 355 | 446 | 345 | 101 | 111.3 s | 2339.9 ms | 77.4 ms | 244.5 s |
| `sea_temperature` | 4 GB capacity refill | 355 | 40 | 36 | 14 | 14.2 s | 410.0 ms | 65.7 ms | 139.4 s |
| `sea_temperature` | warm fixed scope, 4 GB | 355 | 0 | 0 | 0 | 0 | 356.3 ms | 37.3 ms | 124.3 s |
| `ocean_productivity_score` | cold browser, 4 GB | 354 | 441 | 344 | 97 | 124.1 s | 2543.7 ms | 78.1 ms | 255.0 s |
| `ocean_productivity_score` | warm fixed scope, 4 GB | 354 | 0 | 0 | 0 | 0 | 371.3 ms | 65.7 ms | 123.9 s |
| `sustainability_pressure` | cold browser, 4 GB | 354 | 432 | 344 | 88 | 121.0 s | 2511.9 ms | 55.6 ms | 252.2 s |
| `sustainability_pressure` | warm fixed scope, 4 GB | 354 | 0 | 0 | 0 | 0 | 364.7 ms | 34.9 ms | 123.9 s |
| `fishing_hours` | cold browser, 4 GB | 365 | 454 | 355 | 99 | 111.8 s | 2340.2 ms | 54.4 ms | 247.3 s |
| `fishing_hours` | warm fixed scope, 4 GB | 365 | 0 | 0 | 0 | 0 | 364.3 ms | 40.6 ms | 127.8 s |

The chlorophyll cold hit count is intentionally omitted from this table: the
interaction run included widget and event-viewer inspections, so its hit count
is not directly comparable with a playback-only run.

## Findings

1. All five time-series datasets completed their full available year without a
   failed frame, deadlock, lost date, or unrecoverable queue.
2. Every fixed-scope warm run had zero cache misses, zero HTTP requests, zero
   task promotions, and zero playback stalls. Playback therefore short-circuits
   through the canonical RAM store without invoking the server.
3. Cold 4x playback is faster than sustained source preparation for these
   datasets. Cold stalls are dominated by queue/network time; cache commit and
   render P95 remain small by comparison.
4. Query promotion works under pressure: playback-target requests recover while
   background work remains bounded. Promotion does not clear completed frames.
5. `sea_temperature` occupied about `2.39 GB`; the other 4 km products occupied
   about `2.42-2.44 GB`. A default `2 GB` LRU store cannot retain a complete
   fixed-scope year, so a zero-HTTP second pass requires a larger configured
   capacity or a smaller scope/resolution.
6. Exact selected-tile inspection returned one clipped row for the selected
   BBOX. Edge-touching neighboring rows no longer leak into the cache-backed
   table/widget result.
7. The browser-console audit exposed and then verified a fix for a synchronous
   `inspect -> put -> notify -> line chart render -> inspect` recursion.
   Covered-BBOX inspection is now read-only: it returns a clipped view and
   touches the source frame's LRU position without committing a derived frame.
   Repeating layer activation, single-tile selection, and the 60-day line-chart
   fill produced no new console errors.

## Acceptance conclusion

The lifecycle separation is accepted for correctness: playback is a RAM-frame
consumer, preheating is an independent producer, widgets inspect the canonical
store, and only cache misses enter the scheduler. The remaining cold 4x stalls
are a measurable capacity/throughput policy issue, not a hidden batch gate or
renderer dependency.
