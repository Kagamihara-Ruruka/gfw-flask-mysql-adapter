# Common Adapter

This is a local data adapter for exploring pluggable datasets with Flask, MySQL, PostGIS, and Leaflet.

The current app renders:

- Mapping-driven sampled-grid datasets, including the current GFW MySQL read model and Pipeline Iceberg serving datasets, rendered through a WebGL-first map path with canvas fallback.
- AIS latest vessel positions from a live MySQL table maintained by a separate upstream collector.
- EEZ boundaries from PostGIS vector tiles and cached local vector data.
- A Leaflet map with table preview, timing metrics, render-state lights, time playback, fullscreen map mode, layer ordering, basemap controls, graticule controls, screenshot export, and per-layer style controls.

It is an experimental local tool. It is not a production GIS system.

Traditional Chinese documentation is available in [`README.zh-TW.md`](README.zh-TW.md).

The historical pre-512 MiB Chrome Incognito playback checkpoint is
available at [`benchmarks/playback_lifecycle_acceptance_2026-07-15.md`](benchmarks/playback_lifecycle_acceptance_2026-07-15.md).
The follow-up Runtime OOP regression report is available at
[`benchmarks/runtime_oop_acceptance_2026-07-15.md`](benchmarks/runtime_oop_acceptance_2026-07-15.md).
The Widget UI/Application boundary regression report is available at
[`benchmarks/widget_application_boundary_acceptance_2026-07-16.md`](benchmarks/widget_application_boundary_acceptance_2026-07-16.md).
The Clock Domain and trusted runtime-metrics acceptance report is available at
[`benchmarks/clock_domain_acceptance_2026-07-16.md`](benchmarks/clock_domain_acceptance_2026-07-16.md).
The current 512 MiB playback-pipeline, adaptive-watermark, and external Chrome
Incognito acceptance report is available at
[`benchmarks/adaptive_watermark_acceptance_2026-07-16.md`](benchmarks/adaptive_watermark_acceptance_2026-07-16.md).
The Mapping/query-broker/cache convergence and current side-browser acceptance report is available at
[`benchmarks/runtime_convergence_acceptance_2026-07-17.md`](benchmarks/runtime_convergence_acceptance_2026-07-17.md).
The current 5081 sampled-grid throughput, completion-order batching, and five-dataset playback acceptance report is available at
[`benchmarks/sampled_grid_throughput_acceptance_2026-07-17.md`](benchmarks/sampled_grid_throughput_acceptance_2026-07-17.md).
The one-pass Mapping and end-to-end columnar Canonical Frame acceptance report is available at
[`benchmarks/sampled_grid_canonical_frame_acceptance_2026-07-18.md`](benchmarks/sampled_grid_canonical_frame_acceptance_2026-07-18.md).
The CC-scoped paging, shared render-grid, and query-storm acceptance report is available at
[`benchmarks/sampled_grid_spatial_storm_acceptance_2026-07-18.md`](benchmarks/sampled_grid_spatial_storm_acceptance_2026-07-18.md).
The Runtime identity, buffer-episode, timing-truth, and five-dataset full-year user-storm acceptance report is available at
[`benchmarks/runtime_truth_acceptance_2026-07-19.md`](benchmarks/runtime_truth_acceptance_2026-07-19.md).
The sampled-grid Canonical-validity, immutable render-transaction, mask-seam, and five-dataset visual-storm acceptance report is available at
[`benchmarks/sampled_grid_render_correctness_acceptance_2026-07-20.md`](benchmarks/sampled_grid_render_correctness_acceptance_2026-07-20.md).

## Upstream Handoff

Use `handoff/` when sharing this repo with upstream owners:

- `handoff/airflow_ais_crawler/` is for the Airflow/crawler owner. It explains the AISStream to SQL collector, the handoff JSON, SQL sink, timing, and health checks.
- `handoff/backend_config_contract/` is for the backend/system owner. It explains source config, Router Manifest activation, Probe/Mapping ownership, MySQL/Hive/Spark boundaries, and the proposal-only capability matrix for disabled future skin/display settings.

Do not send real API keys through tracked files. `config/runtime/adapter.local.json` and `config/runtime/ais_collector.local.json` are local ignored files.

## Architecture

```text
core.py
  -> common_adapter/http/interface.py       Flask app factory and route assembly
  -> common_adapter/http/server.py          server lifecycle, PID, and port helpers
  -> common_adapter/http/routes/*           system, dataset, overlay, live, and developer routes
  -> common_adapter/db/connect.py           Dataset read backend dispatch
  -> common_adapter/db/backends/*           MySQL and future backend adapters
  -> common_adapter/query/registry.py       shared database/endpoint query-adapter registry
  -> common_adapter/query/identity.py       mapping-aware cache namespace
  -> common_adapter/ais/live.py             AIS live query packet
  -> common_adapter/ais/ingest.py           AISStream collector to SQL latest-state table
  -> common_adapter/spatial/overlay.py      EEZ overlay fallback helpers
  -> common_adapter/spatial/lod.py          PostGIS / MVT EEZ tile helpers
  -> common_adapter/spatial/land_mask.py    EEZ-derived land/high-seas topology and LOD masks
  -> templates/index.html      Leaflet UI shell
  -> static/js/*               Frontend state, API, layer, and UI modules
```

The runtime imports the canonical `common_adapter/` modules directly. The former root-module and `database/registry.py` compatibility paths have been removed; new code must not recreate dependencies on them.

Frontend Runtime ownership, the DI composition root, class-selection rules, and the Application Service template are documented in [`docs/architecture/runtime-oop.md`](docs/architecture/runtime-oop.md).

The frontend is deliberately split by responsibility:

- `static/app.js`: bootstraps the app and wires UI events.
- `static/js/core`: shared state, DOM, map, and geographic helpers.
- `static/js/services`: render intent, sampled-grid `QueryBroker`, general query scheduling, canonical frame cache, API calls, and shared service helpers.
- `static/js/layers`: sampled-grid, AIS, and EEZ rendering behavior, plus layer visual effects such as zoom blur and crossfade handoff.
- `static/js/rendering`: renderer capability checks, renderer selection, WebGL/canvas paint helpers, virtual-grid contracts, and data-driven paint configuration.
- `static/js/playback`: playback controls, delivery policy, pure timeline scheduler, frame readiness buffer, playback renderer handoff, playback interpolation policy, the independent preheater, the adaptive-watermark controller, and snapshot splitting helpers.
- `static/js/ui`: table, playback, layer selector, map settings, and shared layer style controls.

Runtime timing is injected by `ClockDomain`: monotonic wall time owns queue, network, cache, buffering, timeout, and percentile measurements; playback time alone applies the speed multiplier; render time owns animation-frame and draw measurements. Lifecycle events use `monotonic_ms`, and the status line, metrics Widget, and event viewer consume the same `RuntimePerformanceMetrics` snapshot instead of maintaining separate playback telemetry.

`BrowserProfileStoreCore` is created by the frontend DI composition root and persists only device/visual preferences in `localStorage`: map interaction and basemap preferences, paint/alpha profiles, renderer preference, and AIS display strategy. Source registration, imported/active layers, date selection, Mapping, Query Policy, cache/watermark policy, and playback state are deliberately excluded. If browser storage is unavailable, these preferences degrade to the current session without changing runtime correctness.

Runtime pipeline:

```mermaid
flowchart TD
  UI["Browser UI / Leaflet / WebGL"]
  API["common_adapter/http/routes/* / Flask API"]
  READ["common_adapter/db/connect.py / read_backend"]
  REG["common_adapter/query/registry.py"]
  MYSQL["MySQL read backend"]
  HIVE["Hive read backend stub"]
  SPARK["Spark/Iceberg read backend stub"]
  EEZ["EEZ overlay services / MVT + cache"]
  AISREAD["AIS SQL consumer"]
  AISCOLLECT["AIS ingest collector"]
  AISUP["AISStream upstream"]
  SQLAIS["BDDE38No1 AIS tables"]
  GFW["GFW gold_grid table"]

  UI --> API
  API --> READ
  READ --> REG
  REG --> MYSQL
  REG --> HIVE
  REG --> SPARK
  MYSQL --> GFW
  API --> EEZ
  API --> AISREAD
  AISREAD --> SQLAIS
  AISUP --> AISCOLLECT
  AISCOLLECT --> SQLAIS
```

The source read path is split by responsibility:

- Decorators register available query-adapter implementations, such as `@query_adapter("mysql")`.
- JSON config selects the backend and connection per dataset.
- Route handlers call canonical schema/records operations without knowing whether a dataset is backed by MySQL, a serving endpoint, or a future Hive/Trino/Spark/Iceberg read model.

Example dataset routing:

```json
{
  "connections": {
    "local_mysql": {
      "kind": "mysql",
      "driver": "pymysql",
      "host": "127.0.0.1",
      "port": 3307,
      "user": "root",
      "password": "env:MYSQL_PASSWORD",
      "database": "common_fishery"
    },
    "class_hive": {
      "kind": "hive",
      "driver": "placeholder",
      "host": "hive-server.local",
      "port": 10000,
      "user": "hive",
      "password": "env:HIVE_PASSWORD",
      "database": "common_warehouse"
    }
  },
  "datasets": {
    "gfw_full": {
      "backend": "mysql",
      "connection_ref": "local_mysql",
      "table": "gold_grid"
    }
  }
}
```

Hive and Spark are intentionally registered only as explicit unsupported stubs in this version. They are reserved read-model extension points, not claimed working Hive, Spark, or Iceberg integrations.

Backend contract:

- `common_adapter/http/interface.py` owns Flask app assembly only; route modules own HTTP shape. Neither layer should know vendor-specific SQL, Hive, Spark, or Iceberg query details.
- `common_adapter/db/connect.py` owns shared database query helpers and dataset read dispatch. Backend classes live under `common_adapter/db/backends/`.
- `common_adapter/query/registry.py` owns registration and instantiation for database and endpoint query adapters.
- Active source configs own external names. Mapping artifacts translate them into canonical time, latitude, longitude, resolution, metric, and identity roles.
- Collector jobs own source-specific ingestion and sink-specific writes.
- Frontend layer code must consume API packets, not raw database credentials, raw source files, or collector paths.

## Features

### Data layers

The layer selector is built from imported layer contracts. It is not a hard-coded three-item dataset list:

- imported sampled-grid datasets produced by the Mapping Controller
- AIS vessel positions when an active websocket/read-model route is available
- EEZ boundary overlays when an active spatial route is available

Primary data layers are activation-controlled and may all be off; disabled imported layers do not query or render. EEZ is an independent overlay. Scout exposes source-field and value-semantics evidence; Mapping explicitly adopts field roles and provider-status aliases, normalizes them to the Canonical `observed / filled / no_data / unknown` vocabulary, and the Layer capability compiler decides whether a sampled-grid layer may expose render-only linear interpolation. The UI never infers this from a layer name or source type; EEZ, categorical values, and unresolved semantics remain nearest-only. Interpolation changes Renderer paint only and does not alter Canonical Frames, selection, Widgets, queries, or cache identity. Marine sampled-grid renderers consume the land-mask child capability registered with EEZ. Canonical cells remain Scout-derived squares; mask segment sampling prevents interpolation corners from being shared across detected land, and WebGL clips visible fragments against the current EEZ z/x/y LOD ocean geometry. The final coastline fidelity is therefore bounded by the selected mask LOD, without changing analytical grid identity. Exact `eez_v12` geometry owns attribution coverage, while the versioned coarse topology artifact only classifies the exact EEZ union's complement as land or high seas; it is not visual coastline geometry. For bounded sampled-grid datasets, Mapping owns the coverage union and `default_coverage_id`: the default coverage supplies the initial center, while the union supplies legal camera bounds. CC owns the effective spatial demand as `viewport bbox intersect coverage`. The adapter snaps that demand to the Scout-derived base grid and computes stable internal pages from grid geometry and source capacity. These identities remain adapter-owned formula results. A capable source may accept the resulting half-open grid-index window, Mapping-selected field list, and column response shape, but it never receives consumer-owned BBOX or `shard_id` semantics.

Layer rows can be drag-reordered in the selector. The order controls map stacking by Leaflet pane z-index. Each layer has a gear panel:

- Sampled-grid layers expose mapping-driven metric, resolution, color scale, intensity, and alpha controls.
- AIS exposes collector key handoff plus density-grid or point-dot rendering.
- EEZ exposes fill color, boundary color, fill opacity, boundary opacity, and alpha.

The alpha and color controls are centralized in shared UI helpers so future layers should not copy one-off slider logic.

### Map

- Dark UI theme.
- Leaflet base map with selectable basemaps: light, dark, OSM, terrain, and satellite.
- Fullscreen map button.
- Fullscreen preserves the current geographic bounds instead of showing extra horizontal world copies.
- Map settings gear for scale bar, zoom buttons, mouse-wheel zoom, double-click zoom, dragging, screenshot export, and latitude/longitude graticule options.
- Latitude is clamped to avoid dragging into invalid north/south map bounds.
- EEZ uses vector tiles when available.

### Time controls

Time controls are enabled only when at least one selected layer exposes time capability. EEZ-only mode disables the single-day and time-sequence controls.

Time-capable sampled-grid layers currently support:

- single-day mode
- latest available date jump
- start/end date range
- replay
- previous/next day
- play/pause
- playback speed

Playback scheduling is timeline-driven. Playback speed is a timeline rate, not the old "wait after the previous frame completes" loop. The default delivery policy is analysis mode: every selected real snapshot is consumed in order, and `playbackRate` changes the target cadence for the next snapshot. Smooth and strict delivery policy ports are visible in Settings but explicitly marked as not implemented, so they do not control the playback clock yet. Query and render work do not add another full interval after each frame. A cold run enters `PREPARING` and waits only for the next real target frame. Adaptive low/high watermarks govern background inventory and never become playback eligibility gates. During playback, only a genuinely missing target enters `BUFFERING`; the selected date stays fixed until that target is ready. Failed target requests are explicit frame-buffer failures, not endless `fetching` states; pause, replay, layer, and dataset changes invalidate stale queued preheat work without evicting completed frames.

The settings page exposes playback as separate responsibility boxes instead of one mixed control group:

- Playback timeline: delivery policy and `playbackRate` decide which real snapshot date the player is trying to show. Analysis mode is implemented; smooth and strict modes are reserved ports.
- Frame buffer: analysis mode reports `fetching/missing/ready/waiting/failed` state boundaries. The timing box records `buffering`, `resumed`, and `shown` events separately from SQL/API/render work.
- Data cache / preheat: an independent producer maintains low/high ready-ahead inventory. Trusted supply/consumption metrics are scoped to the active playback request and exclude Widget traffic. Adaptive mode uses half of the configured RAM budget as playback inventory capacity, with low/high refill thresholds at one-third and two-thirds of that capacity; fixed 10/15 thresholds remain available. The browser canonical-frame budget defaults to 512 MB and remains adjustable in Settings. The producer may desire a large cache inventory, but it exposes at most 12 outstanding frame demands to `QueryBroker`. The Registry publishes each physical provider's operation capacity; the broker limits effective batch size and provider in-flight work to that capacity, while the Flask `QueryBatchExecutor` enforces the same shared bound after decompression.
- Frame interpolation: playback can use the existing layer crossfade as a visual-only interpolation policy or switch directly between real snapshots; data blending remains reserved for a future `requestAnimationFrame` loop backed by render artifacts.
- Visual effects: crossfade decorates layer replacement; Gaussian blur is limited to zoom / LOD reload masking.
- Render pressure and timing: renderer policy and the dashboard timing box observe performance without owning the playback clock.

Playback invariants are covered by `tests/playback_contracts.test.mjs` and can be run with:

```powershell
python scripts/playback_contract_smoke.py
```

The guarded contracts are:

- `analysis` delivery uses `sequential` stepping: even if the clock is late or the speed is 4x, the next render target is always `currentIndex + 1`.
- Buffering can shift the scheduler clock, but it must not advance the selected date until the target frame is ready.
- Progressive cold cache reports `fetching 0 / 1`; when the target packet is ready it records `BUFFER_RESUMED` and then `FRAME_VISIBLE`.
- Progressive request failures report `failed`, emit a lifecycle error event, and stop playback after a real monotonic 30-second timeout instead of retrying forever.
- Cancelled or replaced progressive preheats cannot apply late progress, status, or failure state to the current playback generation.
- Cold playback enters `PREPARING` and waits only for the next target frame without counting that wait as a playback stall. During playback, the independent preheater fills missing frames to the high watermark while playback consumes ready frames.
- Insufficient supply samples keep the adaptive policy in `WARMING`; they do not trigger a probe or increase the playback readiness requirement.
- Only a missing target can enter `BUFFERING`; recovery resumes as soon as that target frame is ready. Manual seek still promotes only its target and does not wait for a refill watermark.
- `AdaptiveWatermarkController` reads only `RuntimePerformanceMetrics` and the `DataFrameStore` capacity snapshot. It performs no transport, changes no query concurrency, and never clears cache. UI paths may preview or display policy; only Preheater reconciliation applies it.
- `fluid` is the only step mode allowed to map elapsed time to future dates. It remains reserved behind the disabled smooth delivery port.
- Prefetch, render, interpolation, blur, and timing observations supply or decorate frames; none of them owns the playback date clock.

Current frontend module boundaries:

| Module | Boundary |
| --- | --- |
| `static/js/core/clock-domain.js` | DI-injected monotonic, playback, and render clocks. Playback speed is accepted only by playback cadence and consumption-rate calculations. |
| `static/js/playback/playback-delivery-policy.js` | Playback delivery policy: the single high-level owner for analysis/smooth/strict timeline semantics. Only analysis mode is enabled today; smooth and strict are exposed as reserved ports. |
| `static/js/playback/playback-scheduler.js` | Pure timeline math: cadence, due frame, speed/rate mapping, and target date index. |
| `static/js/playback/playback-runtime-controller.js` | Public playback facade and the sole owner of timer, generation, timeline, and session callbacks. UI code does not address `PlaybackEngine` or `PlaybackPreheater` directly. |
| `static/js/playback/playback-frame-buffer.js` | Pure frame-readiness decisions. It consumes injected frame inspection results and never rebuilds request context, mutates buffer state, or reads `DataFrameStore` independently. |
| `static/js/playback/playback-time-policy.js` | Pure monotonic buffer-timeout policy; it never reads playback speed. |
| `static/js/playback/playback-renderer.js` | Playback-to-render handoff: set selected date, sync controls, call the existing active-layer reload. |
| `static/js/playback/playback-interpolation-controller.js` | Playback interpolation policy: choose layer crossfade or direct switching during playback; data blending is not enabled yet. |
| `static/js/core/canonical-grid-frame.js` | Immutable browser-side columnar sampled-grid frame and zero-copy indexed/BBOX views. Row objects are created only at explicit presentation boundaries. |
| `static/js/services/frame-identity.js` | The only builder for canonical BBOX signatures, request intent keys, scope keys, and returned frame keys. |
| `static/js/services/data-frame-store.js` | Canonical RAM frame store, intent-to-frame aliases, compatible containing-BBOX materialization, pin/release ownership, byte-budgeted LRU eviction, and failure state. It defaults to a 512 MB browser budget and never performs transport. |
| `static/js/services/layer-query-coordinator.js` | Priority scheduler for query families outside the sampled-grid transport chain, with one execution per intent key, queued-task promotion, consumer-scoped cancellation, and a reserved foreground slot. |
| `static/js/services/query-policy-controller.js` | DI-owned policy command boundary for that general scheduler. It does not own sampled-grid provider capacity or playback watermarks. |
| `static/js/services/query-broker.js` | Provider-level transport owner. It bakes compatible operations across datasets into NDJSON batches, caps effective batch size and in-flight operations by Registry capacity, releases capacity per streamed result, and immediately backfills the highest-priority queued work. The provider key never replaces the dataset/cache identity. |
| `static/js/services/frame-demand-service.js` | The sampled-grid demand boundary. It checks `DataFrameStore`, joins an exact or containing-BBOX in-flight request when compatible, delegates a real miss directly to `QueryBroker`, normalizes the returned packet, and commits it once. |
| `common_adapter/query/batch.py` | Flask-side batch execution owner. `QueryBatchExecutor` keeps one global worker pool and a shared per-provider capacity pool, acquires provider permits before worker submission so capacity waits cannot starve other sources, yields results in completion order by `operation_id`, and isolates sibling failures. |
| `common_adapter/query/grid_frame.py` | Immutable server-side columnar sampled-grid frame, builder, transport projection, and zero-copy selection views. |
| `common_adapter/query/sampled_grid_paging.py` | Pure CC/coverage clipping, base-grid snapping, formula-derived internal page planning, and canonical frame assembly. It never expects source-owned shard identity. |
| `static/js/services/frame-demand-decorators.js` | DI-composed observability decorator. It records demand boundary duration and outcome without changing cache, scheduling, transport, result, or error semantics. |
| `static/js/playback/playback-preheater.js` | Long-lived producer that independently maintains low/high ready-ahead inventory. Desired inventory and the 12-request scheduling window are separate concerns; it does not own the playback clock or playback readiness. |
| `static/js/playback/adaptive-watermark-controller.js` | DI-owned stateful policy owner. It derives effective watermarks from trusted supply, cache-ready P95, playback consumption, and RAM budget, with monotonic decrease hysteresis. |
| `static/js/playback/playback-engine.js` | Frame consumer and playback lifecycle owner. It owns next-target preparation, target-miss buffering, visible-frame pins, and their lifecycle events; readiness is always the requested next frame, not a refill watermark. |
| `static/js/playback/playback-cache-service.js` | Playback cache settings/status facade. It exposes watermarks and RAM capacity but owns neither transport nor a batch pipeline. |
| `static/js/services/lifecycle-event-log.js` | Bounded event log, linear Queue-to-Ready pairing, explicit run export, and user-perceived Queue/HTTP/cache/render/stall metrics. |
| `static/js/services/runtime-performance-metrics.js` | The single trusted projection for supply, consumption, cache-ready tail latency, ready-ahead, and buffer-wait values. It replays the bounded lifecycle log once, then maintains bounded per-scope metrics incrementally; adaptive reconciliation and the metrics Widget never rescan or resort the full event history. |
| `static/js/ui/widgets/capabilities/event-viewer.js` | Read-only lifecycle Event Viewer Widget with run/dataset/event filters and manual JSON export. Playback completion never opens a download or file dialog. |
| `static/js/services/browser-profile-store.js` | DI-owned browser-profile persistence for the explicit device/visual whitelist; storage failure falls back to session state. |
| `static/js/layers/sampled-grid-layer-effects.js` | DI-owned visual transition lifecycle. It generation-guards the RAF/timer work for zoom/LOD blur, reveal, cleanup, and crossfade so stale callbacks cannot mutate reused layers. |
| `static/js/rendering/render-grid-profile.js` | Pure zoom-bucket policy for visual aggregation. Renderer color cells and virtual selection cells consume the same profile and origin. |
| `static/TimingMetrics.js` | DI-created query/render timing service. It accepts ClockDomain and does not keep a second playback-event timeline. |

```mermaid
flowchart LR
  UI["Playback commands"] --> Runtime["PlaybackRuntime facade"]
  Runtime --> Engine["PlaybackEngine"]
  MapApp["Map application flow"] --> Demand["FrameDemandService + tracing decorator"]
  Engine -->|"frame demand"| Demand
  Preheater["PlaybackPreheater"] -->|"watermark demand"| Demand
  Metrics["RuntimePerformanceMetrics"] --> Watermark["AdaptiveWatermarkController"]
  Store --> Watermark
  Watermark -->|"effective watermarks"| Preheater
  Demand --> Broker["QueryBroker: provider batch + stream split"]
  Broker --> API["Flask /api/query/batch"]
  API --> Batch["QueryBatchExecutor: global + provider capacity"]
  Batch --> Adapter["Mapping-backed query adapter"]
  Adapter --> API
  API --> Broker
  Broker --> Demand
  Demand --> Store["DataFrameStore: canonical RAM frames"]
  Other["Other query families"] --> Scheduler["QueryScheduler"]
  Store --> Renderer["Sampled-grid renderer: WebGL/Canvas draw"]
  Store --> Widgets["Widgets: playback-time cache-only consumers"]
  Engine --> Renderer
  Interp["Frame interpolation policy: layer crossfade now, future data blend"] -.-> Renderer
  Effects["Visual effects: decorate only, no scheduling"] -.-> Renderer
  Renderer --> Map["Visible Leaflet layer"]
  Events["LifecycleEventLog + Event Viewer Widget"] -.-> Engine
  Events -.-> Broker
  Events -.-> Store
  Events -.-> Renderer
```

AIS is live viewport mode and does not use the date player.

### Timing panel

The timing drawer reports:

- SQL query time
- serialization time
- API total time
- client fetch-to-render time
- EEZ tile timing
- render-state gate for GFW, AIS, and EEZ readiness
- selected sampled-grid render backend and draw timing
- row count

`rendering` timing is client draw time for the selected backend. It is not a claimed time saving. `fetch-to-render` remains the broader user-facing latency from API request through visible map update.

### Rendering and cache behavior

The app asks `/api/render/capability` for backend policy and inspects browser WebGL support. Sampled-grid rendering prefers WebGL when available and falls back to the canvas layer when not.

Sampled-grid records use a mapping-, source-scope-, resolution-, and date-aware cache:

- A bounded dataset clips CC viewport demand to Mapping coverage, snaps it to the base grid, and requests only missing internal row-band pages. A pan reuses retained pages and requests only newly required pages.
- A viewport-native source without bounded coverage, such as a bbox-backed database route, still refreshes when the viewport leaves its cached packet.
- Map move, zoom, and Leaflet layout resize all replace the sampled-grid viewport scope. They invalidate the active immutable `RenderContext` and schedule one settled reload; a resize must never clear a stale frame without requesting its replacement.
- Query/cache resolution stays at the Scout-derived base grid unless the user explicitly selects another valid source multiple. Camera zoom changes only `RenderGridProfile`; a zoom-bucket change with cached base data sends no source request.
- Render aggregation is a GPU presentation concern. Mapping declares the reducer, the base Canonical Frame remains unchanged, and virtual-grid selection uses the same aggregation factor, scale, and origin as the rendered cells.
- Date-to-date playback frame changes do not use Gaussian blur; they rely on cache readiness, renderer work, and layer crossfade.
- Once a sampled-grid scope is known, the independent Preheater maintains its configured ready-ahead window; it does not wait for a render callback to begin its lifecycle.
- Prewarm is opportunistic. It must not change the visible map, clear completed snapshots, or outrank a map request.
- HTTP sampled-grid adapters also cache canonical source snapshots by mapping namespace, date, coverage, and resolution. `query_policy.snapshot_cache_max_rows` is a global cross-namespace row budget, so enabling several datasets cannot multiply an independent unbounded cache for each dataset.

EEZ is treated closer to a basemap overlay: local vector data and PostGIS vector tiles are reused as much as possible, and pan-only movement should not force a full EEZ reload.

### Sampled-grid query and cache lifecycle

A playback frame is a canonical records packet identified by:

```text
mapping-aware cache namespace + date + source-scope bbox + limit + columns + resolution context
```

The cache namespace is derived from the active mapping contract, including source route, canonical field roles, grid profile, resolution policy, and query contract. Changing those semantics creates a new namespace; credentials and visualization-only settings do not. The Registry also derives a non-secret provider transport key and capacity from the physical source route. Datasets sharing that key share one provider capacity pool, but they retain independent cache namespaces and canonical frames. On a cold miss, `FrameDemandService` joins the logical intent and delegates it directly to `QueryBroker`; the broker bakes compatible operations into NDJSON requests whose effective size is bounded by available provider slots. Flask then decompresses the request through `QueryBatchExecutor`, which applies the global worker bound and each source's `query_policy.max_in_flight`, streams completion-order results, and identifies them by `operation_id`. Mapping writes each source row once into an immutable columnar `CanonicalGridFrame`; the same frame representation crosses the server cache, transport, browser store, Renderer, and Widget boundaries without inflating a second row graph. Each returned operation is committed once to `DataFrameStore`. On a warm path, the map, playback, selection tools, and Widgets reuse the same immutable frame.

Only the map/query application layer may create sampled-grid demand. `QueryBroker` orders those operations as `map-current`, `playback-target`, `playback-window`, `widget-interactive`, then `widget-auto/background`; `QueryScheduler` remains a separate owner for other query families and is not nested inside this chain. During `PREPARING`, `PLAYING`, or `BUFFERING`, Widgets are cache-only consumers. An explicit Tile interaction may request only the current missing slice through `widget-interactive`; an idle or paused chart may fill its configured history window through `widget-auto`. Active-date refreshes, table inspection, and Event Viewer rendering never start transport. The line-chart Application DataSource memoizes the scalar summary for each dataset, selected cell, resolution, and date, so advancing a 61-day window reads the prior 60 points and derives only the newly entered date instead of rescanning every full Canonical Frame on each playback tick. Cancelling queued prewarm or Widget work never evicts completed packets. When a scope replacement releases the last consumer, queued work is cancelled, but an operation already dispatched to the physical provider drains into `DataFrameStore`; browser cancellation must not advertise a false free provider slot while non-cancellable source work is still running.

There are three independent capacity controls. Runtime `query_policy.network_concurrency` bounds the Flask `QueryBatchExecutor` worker pool. A source config's `query_policy.max_in_flight` bounds complete Frame operations against that provider and is published to the browser for batch dispatch. When one Frame expands into multiple spatial HTTP requests, `query_policy.max_request_in_flight` separately bounds those physical requests; it defaults to the Frame-operation capacity when omitted. The tracked Pipeline Iceberg policy uses two concurrent Frames and three source requests so a three-shard Z6 frame completes in one wave without dispatching three giant Frame responses together. The Runtime NDJSON boundary uses the mandatory `orjson` codec, while `batch_gzip_level` owns the transport compression tradeoff; level 3 is the measured default. Browser watermarks do not change any of these capacities. Validate changes against Queue P95, adapter latency, provider latency, transport encode/gzip time, and visible-frame cadence together.

Source error semantics belong to Mapping. A mapping may declare `snapshot.no_data` to translate a source-specific missing partition into an empty, negatively cached canonical snapshot; `snapshot.retry` handles finite retries for transient source failures; `resolution_policy` is reserved for a real coarser-LOD fallback. These outcomes are not interchangeable.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant UI as Dashboard UI
  participant Runtime as PlaybackRuntime
  participant Playback as PlaybackEngine
  participant Preload as PlaybackPreheater
  participant Demand as FrameDemandService
  participant BrowserCache as DataFrameStore
  participant Broker as QueryBroker
  participant API as Flask query batch API
  participant Batch as QueryBatchExecutor
  participant ServerCache as Flask records cache
  participant Adapter as Query adapter
  participant Renderer as Sampled-grid renderer
  participant Map as Leaflet map

  User->>UI: Press Play
  UI->>Runtime: start(playback command)
  Runtime->>Playback: configure + start
  Playback->>Playback: start timeline(delivery policy + display cadence + playback rate)
  Preload->>Preload: maintain low/high ready-ahead watermarks
  Preload->>Demand: demand missing window frames

  loop Each playback tick
    Playback->>Playback: dueFrame = elapsed / displayCadence
    alt sequential step mode
      Playback->>Playback: targetDateIndex = currentDateIndex + 1
    else fluid step mode
      Playback->>Playback: targetDateIndex = baseDateIndex + dueFrame * playbackRate
    end

    Playback->>BrowserCache: inspect target frame
    alt Target frame is ready
      BrowserCache-->>Playback: canonical columnar frame
      Playback->>UI: date = target frame date
      Playback->>Renderer: render canonical frame view
      Renderer->>Renderer: apply mapped metric and grid profile
      Renderer->>Map: draw via WebGL or Canvas
    else Target frame is missing
      Playback->>Demand: promote only the missing target
      Demand->>BrowserCache: inspect canonical frame
      BrowserCache-->>Demand: missing
      Demand->>Broker: enqueue or promote playback-target operation
      Broker->>API: POST /api/query/batch
      API->>Batch: execute decompressed operations
      Batch->>ServerCache: lookup canonical source snapshot
      alt Server cache hit
        ServerCache-->>Batch: cached packet
      else Server cache miss
        Batch->>Adapter: canonical date + bbox + resolution
        Adapter-->>Batch: CanonicalGridFrame
        Batch->>ServerCache: remember immutable frame
      end
      Batch-->>API: completion-order result(operation_id)
      API-->>Broker: NDJSON batch.result
      Broker-->>Demand: demultiplexed frame packet + timing
      Demand->>BrowserCache: commit canonical frame
      BrowserCache-->>Playback: shared frame result
      Playback->>UI: buffer only while no ready target exists
    end
  end
```

Frame source resolution:

```mermaid
flowchart TD
  A["Frame request: datasetId + date + bbox + columns"] --> B{"Browser cache hit?"}
  B -->|yes| C["Return canonical frame"]
  B -->|no| D["Join demand and enqueue QueryBroker operation"]

  D --> E["POST one provider /api/query/batch request"]
  E --> F0["QueryBatchExecutor applies global and provider capacity"]
  F0 --> F1{"Flask records cache hit?"}
  F1 -->|yes| F["Return cached packet"]
  F1 -->|no| G["Resolve registered query adapter"]

  G --> H["Translate canonical date/bbox/resolution into source contract"]
  H --> I["Build one-pass CanonicalGridFrame"]
  I --> J["Remember immutable server frame"]
  J --> K["Return columnar frame to browser"]

  F --> L["Store or reuse browser packet"]
  K --> L
  C --> M["Render canonical sampled-grid frame view"]
  L --> M

  M --> N["Apply mapped grid and metric semantics"]
  N --> O{"WebGL allowed and available?"}
  O -->|yes| P["WebGL canvas draw"]
  O -->|no| Q["2D Canvas draw"]
  P --> R["Visible Leaflet layer"]
  Q --> R
```

Config and layer mapping role:

```mermaid
flowchart LR
  A["Active source config"] --> B["Schema / capability probe"]
  B --> C["Mapping Controller artifact"]
  C --> D["Imported layer contract"]
  D --> E["Canonical time / lat / lon / resolution / metric roles"]
  E --> F["Mapping-aware cache namespace"]
  F --> G["Query adapter translates canonical request to source contract"]
```

### EEZ bootstrap and spatial route injection

EEZ is a SPATIAL route, not a DATABASE route. Its portable contract lives in `config/examples/sources/spatial/eez.example.json`.

The route has four boundaries:

1. Source asset: a cached Marine Regions EEZ GPKG or zip lives under `data/eez/` when a PostGIS import is needed.
2. Spatial provider: `provider: "postgis"` imports the cached GPKG into the configured PostGIS tables.
3. Layer contract: EEZ is exposed as an overlay layer, not as a normal SQL dataset.
4. Frontend renderer: Leaflet consumes MVT/vector packets and applies the existing EEZ LOD/cache behavior.

The source file is an app-managed cache, not a browser cache. Closing the browser does not remove it. In Docker or another deployed environment, mount `data/eez/` or another configured cache path as a persistent volume.

Default source:

```json
{
  "source": {
    "kind": "remote_gpkg_zip",
    "url": "https://www.marineregions.org/download_file.php?name=World_EEZ_v12_20231025_gpkg.zip",
    "source_page": "https://www.marineregions.org/downloads.php",
    "archive_path": "data/eez/World_EEZ_v12_20231025_gpkg.zip",
    "cache_path": "data/eez/eez_v12.gpkg",
    "form": {
      "name": "RRKAL Common Adapter",
      "organisation": "RRKAL",
      "email": "rrkal.common.adapter@example.com",
      "country": "Taiwan (Province of China)",
      "user_category": "academia",
      "purpose_category": "Data exploration & testing"
    }
  },
  "auto_download": true,
  "auto_import": true
}
```

Marine Regions returns an interactive download form before serving the zip. The downloader automates that form using `source.form`, preserves cookies from the first request, submits the disclaimer agreement, and validates that the final response is a real zip before saving it. You can replace the form metadata in local config if the project should report a different contact.

Manual bootstrap:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json bootstrap-eez
```

Normal startup:

```powershell
docker compose up -d postgis
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json serve
```

`serve` runs the same EEZ bootstrap before dependency checks. If `data/eez/eez_v12.gpkg` is absent and `auto_download` is true, startup downloads the Marine Regions zip through the automated form flow and extracts the matching GPKG. If PostGIS is enabled and the EEZ tables are missing or empty, startup imports the GPKG into `eez_v12`, `eez_v12_tile`, and `eez_v12_boundary`.

### AIS upstream ingest

AIS live data is intentionally split into two processes:

- `core.py serve` runs the local map UI and reads AIS from SQL.
- `core.py ingest-ais` runs a long-lived upstream AISStream collector and writes SQL latest-state rows.

The collector is not a frontend feature. It is an upstream data service whose job is to keep a durable AIS base table warm even when the map is closed. It can later be handed to the upstream/Airflow owner as a scheduled or long-lived data collection job. AISStream position and static messages are independent deltas: the collector merges them by `mmsi`, rejects stale updates within each domain, and never replaces an absent field with null. The latest-state table therefore keeps one current row per vessel instead of growing without bound. The map then queries that SQL table by viewport.

Source event time and local receive time remain distinct. Position and static updates keep independent event-time columns, while `received_at` records collector receipt. This prevents late static data from rewinding a vessel position and avoids treating collector latency as source time.

AIS latest-state reads must not impose an artificial total-row cap. The map may constrain reads by viewport, freshness, and future LOD representation, but `live.ais.limit: "max"` means the SQL query is unbounded and does not inherit `query_policy.max_limit`. If a numeric `live.ais.limit` is configured, it is treated as an explicit diagnostic cap, not the default product behavior.

Crawler timing lives in the crawler handoff JSON, not in the map rendering path. During local + Airflow dual-machine testing, `ingest_reconnect_seconds` and `ingest_status_report_seconds` default to 30 seconds to avoid two machines creating tight reconnect/status loops with the same upstream AIS key. After the collector is owned by one machine, those values can be lowered in the crawler JSON/secret, such as 3 seconds, without changing the map consumer.

This is a strict boundary:

- The map is a consumer.
- The collector is an upstream data feeder.
- The map must not directly consume AISStream for rendering.
- The map must not clean, crawl, or own upstream AIS collection.
- The collector writes SQL rows and a collector heartbeat row into `live.ais.ingest_meta_table`.
- The map reads SQL only after its locally configured collector key matches the collector key fingerprint in SQL metadata.

That internal key check is not a public auth system. It is a local boundary marker for this prototype: a normal user configures the AIS key once in the UI, the UI writes only a key fingerprint into the active WEBSOCKET route config, writes the raw key into the crawler runtime handoff file at `config/runtime/ais_collector.local.json`, and the map verifies that the SQL table is being maintained by the matching collector before it reads from it. Do not return the raw key from HTTP APIs, and do not use this key check as permission to blur the consumer/upstream boundary.

Future public setup can replace the local handoff file with a K8 Secret, Airflow variable, or upstream service registration. That handoff belongs to the crawler/upstream side, not to the map rendering path.

For the upstream owner, the handoff JSON should stay simple: upstream key, crawler timing, and destination sink. Changing polling/reconnect timing or changing the destination from local MySQL to another SQL/Hive-facing sink is crawler configuration work, not map UI work.

AIS SQL reads and writes require `live.ais.connection_ref`; there is no implicit default MySQL fallback. Inline `live.ais.connection` credentials are not a declarative source-config path. When the UI creates the ignored collector handoff, it resolves the named connection into a concrete sink payload so the independent collector can run without a frontend service locator.

Minimal crawler handoff shape:

```json
{
  "schema": "rrkal.ais.collector_handoff.v1",
  "role": "upstream_ais_collector",
  "provider": "aisstream",
  "api_key": "<AISSTREAM_API_KEY>",
  "ingest": {
    "reconnect_seconds": 30,
    "status_report_seconds": 30,
    "flush_seconds": 1.0,
    "batch_size": 250,
    "meta_table": "ais_ingest_meta"
  },
  "sql": {
    "connection": {
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "env:RRKAL_AIS_MYSQL_PASSWORD"
    },
    "database": "BDDE38No1",
    "table": "ais_positions"
  }
}
```

To change the sink, edit only the collector-side `sql` section: `connection.host`, `connection.port`, `database`, and `table`. If the upstream owner later writes into Hive instead of MySQL, that change belongs to the collector/sink adapter and its config; the map should continue consuming the agreed read model rather than calling AISStream directly.

If historical tracks are needed later, add a separate history/events table with an explicit retention policy. Do not overload the latest-state table with unbounded event history.

### Upstream collectors

GFW ingestion is a reusable upstream collector job, not a frontend feature:

- `collectors/gfw_collector.py` imports a configured GFW DuckDB source into the SQL read model.

The map UI must not learn raw source paths or temporary manifests. Those belong to collector configuration. The app should consume SQL tables or later service responses only.

## Requirements

- Python 3.11+
- MySQL-compatible server
- PostgreSQL + PostGIS for EEZ vector tiles
- 7-Zip for extracting the temporary test-data archive
- Node.js only for local JavaScript syntax checks

Python dependencies are listed in `requirements.txt`.

## Quick Start

From the repo root:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (!(Test-Path config\runtime\adapter.local.json)) {
  Copy-Item config\examples\runtime\adapter.example.json config\runtime\adapter.local.json
}
```

Use `config\state\router_manifest.local.json` to select active route fragments. Keep local database settings under `config\sources\database\`, spatial overlay settings under `config\sources\spatial\`, and websocket/source settings under `config\sources\websocket\`. The parent folder and JSON `role` must agree.

Local config files are ignored by git. Keep real passwords in local fragments or in environment variables.

Start the consumer and developer listeners with one `core.py` command:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json serve
```

With the example ports, the runtime surface is:

| Address | Owner |
|---|---|
| `http://127.0.0.1:5057/` | Public group website from `official_site/` |
| `http://127.0.0.1:5057/dashboard/` | Consumer dashboard |
| `http://127.0.0.1:5057/api/...` | Consumer API and runtime transport |
| `http://127.0.0.1:5058/` | Developer control plane |

The public website and dashboard deliberately share the consumer origin. Its `DASHBOARD` navigation uses the root-relative `/dashboard/` route; do not replace it with a machine-specific host or port. `core.py` starts the developer listener on the next port by default, or on `--developer-port` when supplied. Use `--no-developer-server` only when the control plane must not be started.

## Deployment Guide

This repository serves the public website, consumer dashboard, and consumer API from one consumer listener. The same `core.py` process also starts the developer control plane on a separate listener. Stateful dependencies and upstream collectors remain separate. `docker-compose.yml` starts local MySQL and PostGIS support services only; it does not build or deploy the Flask application.

### Human runbook

1. Choose a reviewed Git commit and create an isolated Python environment.

   ```powershell
   py -3 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

2. Create local configuration without committing secrets. Copy `config/examples/runtime/adapter.example.json` to `config/runtime/adapter.local.json`, create only the source fragments required by the deployment, and list those fragments in `config/state/router_manifest.local.json`. The config roles and ownership rules are documented in [config/README.zh-TW.md](config/README.zh-TW.md).

3. Start external dependencies. For the bundled local PostGIS profile:

   ```powershell
   docker compose up -d postgis
   ```

   Review `docker-compose.yml` before using its MySQL profile: its bind-mount path and development credentials are local examples and must be replaced for another machine. Production deployments should use managed or separately administered MySQL/PostGIS services.

4. Prepare EEZ assets when the active spatial route enables PostGIS EEZ, then fail closed on dependency errors:

   ```powershell
   .\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json bootstrap-eez
   .\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json check-dependencies
   ```

5. Start one application instance:

   ```powershell
   .\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json serve
   ```

   The configured consumer port serves `/` (public website), `/dashboard/` (dashboard), and `/api/...` (consumer API). The same command starts the developer control plane on the next port unless `--developer-port` is supplied. Use `--no-developer-server` when the deployment must not start the control plane. Do not expose the developer port to an untrusted network.

6. Verify the deployed process before routing users to it:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:5057/api/health
   Invoke-RestMethod http://127.0.0.1:5057/api/datasets
   ```

   Also open `/` in a fresh browser profile, follow the relative `DASHBOARD` link to `/dashboard/`, and verify layer activation, one sampled-grid frame, EEZ rendering, playback, zoom, drag, selection, and Widget interaction. Open the Developer tab and confirm that it embeds the configured developer listener rather than a consumer route. HTTP health alone does not validate routing or the rendering lifecycle.

7. Run AIS and other upstream collectors as independent supervised jobs. The dashboard reads their SQL/service outputs; it does not own collector continuity. Store upstream keys in environment variables, K8 Secrets, Airflow Variables, or an equivalent secret manager.

### Pod and service requirements

- Run one `core.py serve` process per pod. The current runtime owns in-process scheduling, endpoint supervision, playback-facing caches, and a local PID file; do not add multiple workers inside one pod.
- Set `server.host` to `0.0.0.0`, set `kill_port_if_busy` to `false`, and let the orchestrator own restarts and port conflicts.
- Mount the configured EEZ cache path, normally `data/eez/`, on persistent storage. Keep MySQL and PostGIS outside the application container or in separately managed services.
- Use `GET /api/health` for liveness/readiness only after `check-dependencies` succeeds. Keep the developer port private or disable it.
- Pin the image to a Git commit and retain the previous image digest. Roll back by redeploying the previous digest; do not mutate a running container or clear data caches as a rollback mechanism.
- The repository does not currently ship an application Dockerfile, Helm chart, TLS termination, or public-network authentication. Those are deployment-platform responsibilities and must not be implied by the local Compose file.

### Agent runbook

An automation agent must use the same configuration and health truth as a human operator:

1. Record `git rev-parse HEAD` and `git status --short` before acting. Do not overwrite existing `*.local.json`, Mapping artifacts, databases, or EEZ caches unless the task explicitly authorizes it.
2. Read this section, [config/README.zh-TW.md](config/README.zh-TW.md), and [handoff/CURRENT_STATE.zh-TW.md](handoff/CURRENT_STATE.zh-TW.md). Discover active routes from `config/state/router_manifest.local.json`; do not infer them from filenames.
3. Keep secrets out of commands, logs, commits, and generated reports. Prefer injected environment variables or the platform secret store.
4. Run `check-dependencies` before `serve`. If a declared dependency is unavailable, stop and report the failing route instead of silently removing it or creating a fallback config.
5. Start at most one application process for the selected config. Reuse the configured ports, close obsolete browser tabs, and avoid parallel benchmark traffic during acceptance.
6. Validate `/`, `/dashboard/`, `/api/health`, `/api/datasets`, the separate developer listener, and the required user workflow. Confirm that website navigation remains same-origin and root-relative. For a release candidate, run the test commands in [Validation](#validation) and preserve the commit, config identity, cache state, browser profile, and results.
7. Treat a missing dataset, Mapping mismatch, stale frame, permanent `FETCHING`, duplicate HTTP, alpha error, mask seam, or render corruption as a failed deployment. Do not compensate by raising RAM, concurrency, watermarks, or timeouts.
8. On failure, stop the new process, preserve logs and event evidence, and redeploy the previous known-good commit/image. Never repair a deployed instance with uncommitted production edits.

Deployment is complete only when dependency checks, API checks, and the browser workflow all pass against the same commit and configuration.

## Developer Control Plane Guide

The developer page is a configuration control plane, not a second dashboard and not a data-query client. One `core.py serve` command starts both listeners: the public website, dashboard, and API stay on `server.port`, while the developer control plane uses `server.port + 1` by default. The dashboard's Developer tab embeds that separate service. It can also be opened directly at `http://127.0.0.1:5058` when the consumer port is `5057`.

Use the panels from top to bottom. Each panel consumes the persisted result of the preceding panel:

```text
Config Router
-> Route State Machine
-> Schema Scout / Mapping Controller
-> Layer Contract Import
-> Dashboard data-layer drawer
```

### 1. Config Router

- **Wizard** creates a DATABASE route fragment and imports it into the managed config list. Creation does not automatically activate the route.
- **Import** first copies a JSON file into `config/staging/`. Inspect or edit the staged JSON, select its source group, then promote it into `config/sources/<role>/`. A file outside that tree is not a runtime source.
- The selected source group and the JSON `role` must agree. Moving a config between groups updates the file location, role, and known downstream references as one control-plane operation.
- **Active** writes the route reference to `config/state/router_manifest.local.json.active_configs`. This manifest is the only source-activation truth.
- **Locked** prevents control-plane edits; it does not test connectivity or enable a source.
- Notes are operator metadata only. They do not affect routing.
- The JSON editor writes the selected local source file. Review the diff before saving and never place a raw secret in a file that may be committed.

An imported or syntactically valid config is not necessarily routable. Activation should be followed immediately by the Route State Machine check.

### 2. Route State Machine

The DATABASE, WEBSOCKET, SPATIAL, and ENDPOINT tables show declared route identity separately from runtime availability:

- **Enabled** means the route appears in the active manifest.
- **Connected/available** means the corresponding probe adapter reached the configured dependency.
- **Schema/probe support** means the route can provide the downstream inspection capability shown in the table.
- Details contain probe evidence or the failing boundary. An unavailable route must be fixed at its config or infrastructure owner; do not create a second route or silent fallback to make the badge green.

The state machine reads live infrastructure but does not redefine source capabilities. A route may be correctly declared and temporarily unavailable. Conversely, a reachable endpoint is not active until the manifest enables it.

### 3. Schema Scout and Mapping Controller

Only active, connected, probeable DATABASE routes enter this panel. Source Scout reports the source's actual tables, columns, types, keys, nullability, candidate roles, and observed value semantics. Candidate hints are evidence, not automatic Mapping decisions.

For an editable table:

1. Open the table and assign a stable layer ID and display name.
2. Assign only roles supported by the source truth and intended consumer:
   - `time` for snapshot identity;
   - `lat`/`lon`, `west`/`south`/`east`/`north`, or `row`/`column` for spatial identity;
   - `id` for stable record identity;
   - `value` for the canonical sampled-grid value;
   - `resolution`, `coverage`, and `status` for their explicit source semantics;
   - `metric`, `category`, and `display` for additional canonical projection fields.
3. Leave an editable field as **Do not query** only when it must be excluded from the query projection. This label is not a statement that the source lacks the field.
4. Save the Mapping. The artifact is persisted to `config/artifacts/layer_mappings.local.json` and becomes the source for query fields, canonical roles, status normalization, resolution evidence, and layer-contract generation.

For a generated or source-contract Mapping, the panel is read-only. **Unmapped** means the visual editor does not own that field; it does not disable the provider's query. The displayed provenance identifies whether runtime truth comes from a Mapping artifact or a source declaration.

Provider-specific status text must be normalized by `sampled_grid.status_semantics` into canonical `observed`, `filled`, `no_data`, or `unknown`. Renderer and Widgets must never interpret provider strings. If status vocabulary or resolution evidence changes, update and save the Mapping instead of patching a consumer.

After saving, confirm that the panel reports success and that the generated contract appears below. A Mapping may be enabled without being imported into the dashboard.

### 4. Data Layer Import

- The **Contract-provided layers** table is the bridge from registered capability to dashboard availability.
- Turn **Import** on only for a reviewed layer contract. Importing makes the layer available in the dashboard data-layer drawer; it does not activate or query the layer.
- Turning Import off removes the layer from dashboard availability and reconciles the current runtime. It does not delete the source config or Mapping artifact.
- A DATABASE-backed layer reaches the dashboard only when all three conditions hold: its source route is active, its Mapping is enabled, and its layer contract is imported.

The dashboard data-layer drawer remains the owner of runtime activation. A newly imported layer should stay dormant until a user checks it there.

### 5. Change verification and recovery

When the developer page is embedded in the dashboard, successful config, Mapping, and import changes notify the consumer registry. When it is opened as a standalone page, refresh the consumer page after the save.

After each change, verify in order:

1. Route State Machine shows the expected declaration and availability.
2. Schema Scout still shows the full source truth.
3. Mapping provenance, roles, status semantics, coverage, and resolutions are correct.
4. The expected layer contract is imported exactly once.
5. The dashboard drawer shows the layer but does not query it before activation.
6. Activating the layer produces the expected dataset, date, spatial extent, base/query/actual resolution, colors, alpha, and Widget values.

If a save produces an invalid route, Mapping, or layer contract, stop using the affected layer and restore the reviewed local JSON/artifact or previous deployment. Do not delete unrelated manifest entries, clear caches, or create compatibility mappings. Persisted local files are control-plane state and should be backed up with deployment configuration.

## EEZ PostGIS Dependency

EEZ is a hard runtime dependency when `overlays.eez.provider` is `postgis`. The app renders EEZ through PostGIS MVT tables, not directly from the `.gpkg` file during normal map use.

Start the local PostGIS service:

```powershell
docker compose up -d postgis
```

Download/cache the Marine Regions EEZ GPKG and import it into PostGIS:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json bootstrap-eez
```

Check runtime dependencies before serving:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json check-dependencies
```

`core.py serve` checks EEZ runtime assets and then runs the dependency check before opening the Flask server. If the local GPKG cache is missing and `auto_download` is true, startup downloads and extracts it first. If `eez_v12`, `eez_v12_tile`, or `eez_v12_boundary` is missing or empty and `auto_import` is true, startup imports from the GPKG before serving.

For AIS, use an environment variable instead of committing a password:

```powershell
$env:RRKAL_AIS_MYSQL_PASSWORD = "your-password"
```

Start only the AIS upstream collector:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json ingest-ais
```

Or pass an explicit crawler handoff JSON for an Airflow/K8 worker:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json ingest-ais --collector-config config\runtime\ais_collector.local.json
```

`ingest-ais` reads `config/runtime/ais_collector.local.json` when it exists, then writes the latest-state table and the `ais_ingest_meta` heartbeat table. The handoff file is gitignored because it contains the upstream AIS key. The active WEBSOCKET route config should keep only the key fingerprint for the consumer-side SQL read gate.

For Airflow, Windows Task Scheduler, NSSM, Docker, or K8, run the same command as the collector task and provide the same SQL connection plus the crawler handoff/secret. The Flask UI does not need to be running for the collector to keep warming SQL.

Start the map UI:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json serve
```

The server is intentionally single-instance. On startup it reads `flask_pid.txt`, force-exits the previous local Flask server when it is still running, clears the configured port when needed, and writes the new PID. This prevents duplicate AIS or database query loops from running at the same time.

Open:

```text
http://127.0.0.1:5057
```

## Import GFW Data

Import a DuckDB table into MySQL:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace
```

Import a smaller sample:

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace --row-limit 5000
```

## Docker Compose

The repo includes `docker-compose.yml` for local service support. Adjust ports and passwords in your local config before use.

```powershell
docker compose up -d
```

## API Surface

Health:

```text
GET /api/health
```

Datasets:

```text
GET /api/datasets
GET /api/datasets/<dataset_id>/schema
GET /api/datasets/<dataset_id>/records?date=YYYY-MM-DD&bbox=west,south,east,north&limit=max
GET /api/datasets/<dataset_id>/records/range?start=YYYY-MM-DD&end=YYYY-MM-DD&bbox=west,south,east,north&limit=max
POST /api/query/batch
```

EEZ:

```text
GET /api/overlays/eez
GET /api/overlays/eez/tiles/<z>/<x>/<y>.pbf
GET /api/overlays/eez/boundary/tiles/<z>/<x>/<y>.pbf
```

AIS:

```text
GET /api/live/ais?bbox=west,south,east,north
GET /api/live/ais/ingest/status
GET /api/live/ais/settings
GET /api/live/ais/diagnostics
POST /api/live/ais/settings
DELETE /api/live/ais/settings
```

Rendering capability:

```text
GET /api/render/capability
```

## Validation

Demo-critical smoke:

```powershell
python scripts\demo_smoke.py --base-url http://127.0.0.1:5081
```

Architecture and lifecycle contracts:

```powershell
python -m unittest discover -s tests
node --test tests/*.test.mjs
```

Audit a complete advertised date range with one bounded cold-query worker, a 30-date warm window, viewport drag, selected-tile, and LOD probes. The single-worker default measures the physical source without reproducing the provider contention already isolated by the runtime broker:

```powershell
python scripts\full_year_cache_benchmark.py `
  --dataset pipeline_iceberg.fishing_hours `
  --concurrency 1 `
  --warm-window 30 `
  --output "$env:TEMP\rrkal-full-year.json"
```

Local checkpoint on 2026-07-17, using the finest Mapping resolution, one cold worker, and a 30-date warm pass:

| Dataset | Dates | Cold completed | Cold median / p95 | Warm hits / p95 | Selected tile | Actual resolution |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `pipeline_iceberg.fishing_hours` | 366 | 366 | 781 ms / 1,113 ms | 30 / 30 / 67 ms | 30 ms, cache hit | 4 km |
| `pipeline_iceberg.chlor_a` | 355 | 355 | 793 ms / 1,088 ms | 30 / 30 / 61 ms | 13 ms, cache hit | 4 km |
| `pipeline_iceberg.ocean_productivity_score` | 355 | 355 | 803 ms / 1,183 ms | 30 / 30 / 65 ms | 14 ms, cache hit | 4 km |
| `pipeline_iceberg.sea_temperature` | 356 | 356 | 781 ms / 1,006 ms | 30 / 30 / 63 ms | 26 ms, cache hit | 4 km |
| `pipeline_iceberg.sustainability_pressure` | 355 | 355 | 762 ms / 1,190 ms | 30 / 30 / 75 ms | 16 ms, cache hit | 4 km |
| `gfw_full` | 31 | 31 | 31 ms / 56 ms | 30 / 30 / 31 ms | 7 ms source probe | 9.28 km |

All 1,818 advertised dates completed with zero failures. Pipeline Iceberg stayed at the requested 4 km route without LOD degradation, and its source snapshot high-water stayed below the global `800,000` canonical-row budget. The GFW probe remains bbox-backed MySQL; browser containment reuse is separately protected by the cache contract tests and prevents a selected tile inside a cached viewport from issuing another transport request.

For the 5081 throughput boundary, use the controlled 30-frame source/batch benchmark:

```powershell
python scripts\sampled_grid_batch_benchmark.py `
  --dataset pipeline_iceberg.sea_temperature `
  --frames 30 `
  --output "$env:TEMP\sampled-grid-batch.json"
```

The 2026-07-18 canonical-frame checkpoint measured `8791` at 1.470 fps with one request and 2.594 fps with two. The complete `5081` batch=2 cold path reached **1.377 fps**, a 25.8% increase over the previous 1.095 fps checkpoint, with a 1.468 s batch P95 for two frames. Warm batch=2 throughput was 6.787 fps. A three-operation batch against capacity 2 is rejected with HTTP 400. Mapping now writes directly into an immutable columnar frame in one pass; server cache, transport, browser store, Renderer, and Widgets no longer build, inflate, or deep-copy a sampled-grid row graph. The detailed equivalence, timing reconciliation, and residual 2x boundary are recorded in the canonical-frame acceptance report linked above.

For a Mapping-only equivalence and CPU benchmark:

```powershell
python scripts\sampled_grid_mapping_microbenchmark.py --rows 24192 --repeats 5
```

Run the cold duplicate/mixed query storm against a running adapter:

```powershell
python scripts\sampled_grid_query_storm.py --base-url http://127.0.0.1:5083
```

The final 2026-07-18 spatial/column acceptance run sent 12 simultaneous requests for one frame and observed one source HTTP plus 11 cache/in-flight reuses at **11.954 fps**. A second storm requested 15 unique frames across five Pipeline Iceberg datasets with ten clients and completed at **3.764 fps**. Mapping-driven source projection reduced a representative 92,432-cell response from 20.06 MB to 6.42 MB. That larger-window 30-frame cold path reached **1.292 fps**; a fresh-process, complete-Taiwan A/B reached **2.774 fps** with batch=2 and a 0.707 s P95 per two frames. All five sampled-grid datasets exceeded the 1x consumption rate in a cold matrix. The final observer-loop regression played chlorophyll plus EEZ from 2020-01-01 through 2020-06-27 while selecting a virtual cell, zooming z6→z7, switching 1x→2x→1x, and dragging the map. Playback remained responsive, the line chart advanced from cached scalar summaries, ready-ahead recovered after each scope change, and browser warning/error logs stayed empty.

The 2026-07-19 Runtime-truth checkpoint separates requested, effective query, and observed actual resolution in physical Frame identity; gives `PlaybackEngineCore` one explicit `PlaybackBufferEpisode`; captures `run_id` when demand is created; and records a non-overlapping sampled-grid timing ledger. A fresh smoke measured 5085 batch=2 at **1.912 fps cold** and **15.309 fps warm**, with zero timing reconciliation error. The final query storm completed 12 duplicate consumers with one source request and 15 unique mixed-dataset Frames at **2.618 fps**. In the side browser, every Pipeline Iceberg dataset completed its full 2020 range while the run exercised speed changes, buffering recovery, Zoom, cell selection, Seek, Widgets, Event Viewer, and an active dataset switch. No run became permanently fetching, no late scope overwrote the current dataset, and browser warning/error logs were empty. Full evidence is in the Runtime-truth acceptance report linked above.

JavaScript syntax check:

```powershell
Get-ChildItem static\js -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
node --check static\app.js
node --check static\TimingMetrics.js
```

Git whitespace check:

```powershell
git diff --check -- static templates scripts *.py config requirements.txt docker-compose.yml README.md
```

## Notes

- Do not commit `config/runtime/adapter.local.json`.
- Do not commit runtime logs, PID files, database files, or downloaded datasets.
- Use environment variables for local secrets.
- This app is designed as a small local exploratory adapter. Keep data access, rendering, and UI behavior separated as the feature set grows.
- EEZ country/claim attribution is available through the registered `1x1` maritime jurisdiction Widget. It consumes saved virtual-grid selections, computes exact EEZ union coverage in the attribution query, and exposes the remaining land/high-seas complement without summing overlapping claims. It distinguishes jurisdiction, disputed, joint-regime, and other mapped cases; it is an exploratory dataset interpretation, not a legal determination.
- AIS has one runtime path: AISStream deltas are merged by the collector into the registered MySQL read model, and the map consumes that read model. Alternative brokers such as Kafka are a future upstream architecture option, not a dormant runtime fallback.
