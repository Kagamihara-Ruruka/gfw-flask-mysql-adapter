# Sampled Grid Canonical Frame Acceptance - 2026-07-18

## Scope

This checkpoint removes the remaining build-expand-rebuild path from the 5081 sampled-grid
pipeline without changing source, Mapping, Renderer, Widget, or UI semantics.

```text
8791 source rows
-> compiled Mapping context
-> one-pass CanonicalGridFrame builder
-> immutable server snapshot cache
-> columnar render transport
-> browser CanonicalGridFrame
-> DataFrameStore / Renderer / Widgets
```

The canonical representation stays columnar from Mapping through browser consumption.
Full row objects are materialized only at explicit presentation boundaries such as a visible
table preview.

## Implemented Boundaries

- `CompiledSampledGridRowPlan` resolves source fields and canonical destinations once per
  adapter instance. Dataset contracts are not reparsed for every cell.
- One source-row pass writes directly into `CanonicalGridFrame` columns. There is no
  intermediate canonical row graph.
- `CanonicalGridFrame` and its zero-copy views are immutable values. BBOX selection and
  compatible cached-frame reuse retain column storage and select by index.
- A sampled-grid batch result must already contain a canonical frame. The transport no
  longer carries a row-inflation compatibility shim or a runtime Mapping fallback.
- `DataFrameStore`, Renderer, line/numeric Widgets, selection, and layer repaint paths
  consume the frame API. The table Widget materializes only the currently visible rows.
- Server cache hits and browser cache hits do not deep-copy canonical cells.
- Source HTTP read time, source JSON decode, Mapping, cache, projection, batch encode,
  gzip, downstream yield, and response bytes are measured separately with monotonic time.

## Mapping Microbenchmark

The benchmark uses the tracked sea-temperature Mapping contract and 24,192 4 km cells.
Both paths produced byte-identical public transport after normalization.

| Mapping path | P50 | P95 |
| --- | ---: | ---: |
| Legacy intermediate row graph | 314.015 ms | 320.173 ms |
| One-pass `CanonicalGridFrame` | **134.014 ms** | **138.792 ms** |

The P50 Mapping speedup is **2.343x**. The normalized transport SHA-256 is identical and
the equivalence assertion passed.

## Controlled 30-Frame A/B

The service was restarted before the run. Each mode used a disjoint 30-date window, the
same Taiwan AOI, sea-temperature metric, and 4 km resolution.

| Path | Mode | Frames | Failures | Throughput | HTTP P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8791 direct | concurrency 1 | 30 | 0 | 1.470 fps | 721.120 ms/frame |
| 8791 direct | concurrency 2 | 30 | 0 | 2.594 fps | 810.324 ms/frame |
| 5081 | batch 1 cold | 30 | 0 | 1.006 fps | 993.143 ms/batch |
| 5081 | batch 2 cold | 30 | 0 | **1.377 fps** | **1,467.984 ms/2 frames** |
| 5081 | batch 2 warm | 30 | 0 | **6.787 fps** | 249.318 ms/2 frames |

Compared with the 2026-07-17 checkpoint (`1.095 fps`), cold batch=2 throughput improved
by **25.8%**. It exceeds the task floor of `0.86 fps` and the P95 ceiling of 2.33 seconds
per two frames. A three-operation request against provider capacity 2 still returns HTTP
400.

## Timing Truth

Cold batch=2 P95 measurements:

| Phase | P95 |
| --- | ---: |
| Provider capacity wait | 2.065 ms |
| 8791 HTTP | 1,031.547 ms |
| Source JSON decode | 61.303 ms |
| One-pass Mapping | 284.462 ms |
| Canonical packet envelope | 0.003 ms |
| Cache commit | 18.288 ms |
| BBOX frame selection | 65.550 ms |
| Transport projection | 0.005 ms |
| Batch encode | 131.137 ms |
| Batch gzip | 115.648 ms |
| Downstream yield | 161.595 ms |

Timing reconciliation P95 error was 0.012%; maximum error was 0.106%. Warm batch=2 had
30/30 server cache hits.

## Browser Acceptance

One external Chrome tab was reused and all other test tabs were absent. The final service
build was reloaded from a no-layer default state.

- All five Pipeline Iceberg sampled-grid datasets loaded their first 2020 frame and rendered
  through WebGL.
- The MySQL-backed GFW dataset also crossed the adapter boundary as a canonical frame and
  rendered through WebGL.
- Sea temperature was exercised at `1x -> 2x` with zoom, map drag, and grid selection while
  playback remained active. Dates and visible values remained aligned and no permanent
  `FETCHING` state appeared.
- The line and pie Widgets updated from cached selected-cell data. The table Widget exposed
  one selected-cell row for the current snapshot, materializing rows only in its visible
  presentation boundary.
- Chrome recorded zero console warnings and zero console errors. The dashboard was restored
  to its default no-layer state after acceptance.

## Regression Evidence

```text
Python unittest: 65 passed
Node test runner: 195 passed
Mapping equivalence: passed
30-frame cold/warm benchmark: all modes completed, zero frame failures
Batch=3 at provider capacity 2: HTTP 400
```

Architecture tests reject sampled-grid `packet.rows`, row-inflation shims, fallback Mapping
at the transport boundary, Widget/Renderer source queries, and duplicate cache/query owners.

## Residual Boundary

Cold 2x playback consumes about `1.428 frames/s`; the measured complete 5081 path supplies
`1.377 frames/s`, a remaining gap of about 3.6%. The current change does not hide that gap
with higher concurrency, RAM, or playback watermarks. Provider HTTP remains the largest
stage, followed by concurrent Python Mapping and browser transport encoding. Those are
separate, measured follow-up boundaries; 1x cold playback has substantial supply margin.

An evaluated gzip level-1 transport reduced compression CPU but increased wire size by
about 40% and changed cold throughput only from 1.377 to 1.381 fps. It was rejected and is
not part of this checkpoint.

## Reproduction

```powershell
python scripts\sampled_grid_mapping_microbenchmark.py --rows 24192 --repeats 5
python -m unittest discover -s tests
node --test tests/*.test.mjs
python scripts\sampled_grid_batch_benchmark.py `
  --dataset pipeline_iceberg.sea_temperature `
  --frames 30 `
  --output "$env:TEMP\sampled-grid-batch-canonical-frame.json"
```
