# Sampled Grid Spatial and Query-Storm Acceptance

Date: 2026-07-18

## Scope

This checkpoint verifies the CC-scoped sampled-grid paging path, zoom-driven visual aggregation, Mapping CPU convergence, and request-storm behavior. It does not change the Pipeline Iceberg data semantics or add an upstream spatial-window contract.

## Ownership

```text
CC viewport + Mapping coverage
  -> effective query bbox
Scout grid + source page capacity
  -> formula-derived internal row-band pages
Source limit/offset
  -> page payloads
FrameAssembler
  -> one immutable CanonicalGridFrame
RenderGridProfile(CC zoom)
  -> GPU visual aggregation + matching virtual selection grid
```

The source has no `shard_id`. Internal page identity is derived by the adapter from coverage, base-grid geometry, resolution, and row range. Because the source only supports `limit` and `offset`, an internal page may still physically include unused columns from its row band; the adapter does not claim source-side bbox pushdown.

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
| Duplicate wall time | 3,489.100 ms |
| Mixed datasets/dates | 15 frames |
| Mixed clients | 10 |
| Successful mixed responses | 15 |
| Mixed source HTTP count | 15 |
| Mixed wall time | 16,292.455 ms |
| Mixed throughput | 0.921 fps |
| Required throughput floor | 0.860 fps |

Every unique mixed frame produced exactly one source request. The duplicate storm did not multiply HTTP work.

## Side-Browser Interaction Storm

The side browser used one tab and performed:

- cold first frame;
- 1x, 2x, and 4x speed changes;
- zoom and map drag during playback;
- virtual-grid selection;
- Table and Lifecycle Event Viewer inspection;
- live switch from sea temperature to chlorophyll;
- restart at 1x after the dataset switch.

The chlorophyll 1x run advanced from 2020-01-01 to 2020-01-10 in 12 seconds and remained `PLAYING`; pause remained responsive. Browser `error` and `warn` logs were empty.

At cold 4x, the Event Viewer recorded supply-bound `BUFFER_ENTERED`, target promotion, and `BUFFER_RESUMED`. This is an explicit physical-throughput boundary, not a deadlock or hidden cache reset.

## Acceptance

- CC demand is clipped to coverage and snapped to the 4 km base grid.
- Internal pages do not depend on upstream shard identity.
- Base Canonical cache identity excludes camera zoom.
- Renderer and virtual selection share `RenderGridProfile`.
- Mapping transport equivalence is exact.
- Duplicate HTTP count is one per frame key.
- Mixed cold throughput exceeds 0.86 fps.
- Interaction storm does not crash or leave permanent fetching state.
