# Sampled Grid Spatial and Query-Storm Acceptance

Date: 2026-07-18

## Scope

This checkpoint verifies the CC-scoped sampled-grid paging path, source grid-window pushdown, Mapping-driven field projection, column-oriented source responses, zoom-driven visual aggregation, and request-storm behavior. It does not change Pipeline Iceberg data semantics or introduce source-owned viewport or shard identity.

## Ownership

```text
CC viewport + Mapping coverage
  -> effective query bbox
Scout grid + source page capacity
  -> formula-derived internal row-band pages
Adapter-owned grid-index window
  -> source predicates + Mapping-selected columns
Source column response
  -> immutable column arrays
FrameAssembler
  -> one immutable CanonicalGridFrame
RenderGridProfile(CC zoom)
  -> GPU visual aggregation + matching virtual selection grid
```

The source has no `shard_id` and does not receive the CC viewport BBOX. Internal page identity and half-open grid-index windows are derived by the adapter from coverage, Scout grid geometry, resolution, and source capacity. The source applies those row/column predicates and returns only Mapping-selected columns. This is source-side spatial filtering without leaking consumer-owned BBOX or shard semantics across the boundary.

## Mapping Benchmark

The compiled one-pass column builder was compared with the legacy row mapping path over 86,400 rows.

| Metric | Result |
| --- | ---: |
| Optimized P50 | 205.780 ms |
| Optimized P95 | 214.304 ms |
| Legacy P50 | 1,153.616 ms |
| Speedup | 5.606x |
| Transport equivalence | exact SHA match |

Transport SHA:

```text
e98d22496ae9e14cbb9f06a334f2c1ef6cab01f5d5ceb4f2577553541714bc0c
```

## Runtime Transport Benchmark

The same 92,432-cell source window was measured through both source response shapes.

| Metric | Row response | Column response |
| --- | ---: | ---: |
| Response bytes | 20,058,399 | 6,422,188 |
| Source HTTP | 1,198 ms | 484 ms |
| JSON decode | 102.8 ms | 42.1 ms |

The adapter requests fields from Compiled Mapping, derives latitude, longitude, and bounds from the shared grid profile, and does not inflate source row dictionaries on the column path.

Thirty cold frames with batch size 2 completed without failure:

| Metric | Result |
| --- | ---: |
| Throughput | **1.292 fps** |
| Batch P50 | 1,266.8 ms / 2 frames |
| Batch P95 | 1,446.2 ms / 2 frames |
| Source HTTP P50 | 700.8 ms |
| Canonicalize P50 | 77.5 ms |
| API timing reconciliation P95 | 6.01% |

All five sampled-grid datasets exceeded the 1x consumption rate in a ten-frame cold matrix. The slowest result was 1.261 fps; the fastest was 1.454 fps.

A final fresh-process A/B used the complete Taiwan AOI (24,192 cells), identical dates, and 4 km resolution:

| Path | Throughput | P95 |
| --- | ---: | ---: |
| Source concurrency 1 | 2.347 fps | 453.1 ms / frame |
| Source concurrency 2 | 4.144 fps | 551.6 ms / frame |
| Adapter batch 1 cold | 1.944 fps | 512.3 ms / frame |
| Adapter batch 2 cold | **2.774 fps** | **707.0 ms / 2 frames** |
| Adapter batch 2 warm | 9.103 fps | 170.3 ms / 2 frames |

The adapter batch-2 path therefore supplies 3.88 times the 1x consumption rate. Batch size 3 remains rejected because the provider capacity is 2.

## Query Storm

Command:

```powershell
python scripts\sampled_grid_query_storm.py --base-url http://127.0.0.1:5083
```

Cold-cache result:

| Scenario | Result |
| --- | ---: |
| Simultaneous duplicate clients | 12 |
| Successful duplicate responses | 12 |
| Duplicate source HTTP count | 1 |
| Duplicate cache/in-flight reuses | 11 |
| Duplicate throughput | 11.954 fps |
| Mixed datasets/dates | 15 frames |
| Mixed clients | 10 |
| Successful mixed responses | 15 |
| Mixed source HTTP count | 15 |
| Mixed throughput | 3.764 fps |
| Required throughput floor | 0.860 fps |

Every unique mixed frame produced exactly one source request. The duplicate storm did not multiply HTTP work.

## Side-Browser Interaction Storm

The side browser used one fresh tab and performed:

- cold first frame;
- cold 1x playback and a 1x/2x/1x speed change;
- zoom and map drag during playback;
- virtual-grid selection;
- Table and Lifecycle Event Viewer inspection;
- cache-backed chart and EEZ updates after selecting a virtual-grid cell.

The chlorophyll cold first frame became visible in 1,063.6 ms. Playback advanced from 2020-01-01 to 2020-08-19 while zoom, drag, selection, Widget updates, and speed changes were applied. It remained controllable, did not enter a permanent or repeated buffer cycle, and paused immediately. Browser `error` and `warn` logs were empty.

At 1x, ready-ahead inventory continued to refill after each interaction. Supply observations remained above consumption, and the query storm did not clear completed frames or duplicate source work.

### Scope-Replacement Drain Regression

A later lifecycle audit found that cancelling the last browser consumer also aborted the dispatched HTTP request. Flask and the physical provider could continue work after that browser abort, while `QueryBroker` incorrectly treated the source slot as free. Rapid zoom or viewport replacement could therefore oversubscribe a two-operation provider and inflate otherwise sub-second requests to several seconds.

`FrameDemandService` now distinguishes queued work from dispatched work. Queued stale work is cancelled; dispatched work records `QUERY_OPERATION_DRAINING`, completes into `DataFrameStore`, and retains its provider capacity until the streamed operation result arrives. A consumer that requests the same frame during that interval reattaches to the draining operation instead of starting another HTTP request.

The controlled regression run measured:

| Check | Result |
| --- | ---: |
| Adapter batch=2 cold throughput | 2.797 fps |
| Duplicate storm source requests | 1 / 12 clients |
| Mixed storm throughput | 3.229 fps |
| Side-browser steady supply | 1.08 fps |
| Side-browser 1x consumption | 0.71 fps |
| Side-browser HTTP P95 | 1.39 s |

The side-browser run started from a cold z6 scope, then zoomed to z7 and reset to the Taiwan view while EEZ and chlorophyll remained enabled. It stayed controllable and recovered ready-ahead inventory without phantom source capacity. Four short buffer entries totaling 1.42 seconds remained around immediate cold/scope startup; those belong to the current one-frame playback readiness policy, not the sampled-grid throughput path.

### Observer Feedback Regression

A later browser run reproduced a different slowdown after long playback plus virtual-grid selection. The source and Flask batch path stayed responsive, but two browser observers performed work proportional to the complete run history:

- adaptive metrics repeatedly queried and sorted the full lifecycle log;
- the moving line chart rescanned up to 61 complete 24,192-cell Canonical Frames on every active-date tick.

`RuntimePerformanceMetrics` now performs one bounded replay followed by incremental event projection, and the metrics Widget coalesces updates without redrawing unchanged Plotly history. `LineChartDataSource` owns a scalar cache keyed by dataset, selected bbox, metric, resolution, and date; a moving 61-day window therefore reuses 60 prior points and derives only the entering date.

The regression run enabled chlorophyll plus EEZ, idled until 11 frames were ready, and then played from 2020-01-01 through 2020-06-27. During the run it selected a 4 km cell, populated the line/pie/EEZ Widgets, zoomed from z6 to z7, switched 1x→2x→1x, and dragged the map. The page remained controllable, ready-ahead recovered to 49 frames after the interaction burst, and browser warning/error logs were empty.

## Acceptance

- CC demand is clipped to coverage and snapped to the 4 km base grid.
- Internal pages do not depend on upstream shard identity.
- Base Canonical cache identity excludes camera zoom.
- Renderer and virtual selection share `RenderGridProfile`.
- Mapping transport equivalence is exact.
- Duplicate HTTP count is one per frame key.
- Thirty-frame cold throughput is 1.292 fps, above both 1x consumption and the 0.86 fps safety floor.
- Every sampled-grid dataset exceeds the 1x consumption rate in the cold matrix.
- Interaction storm does not crash or leave permanent fetching state.
