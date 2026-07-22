import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...javascriptFiles(relativePath));
    else if (entry.name.endsWith(".js")) files.push(relativePath);
  }
  return files;
}

test("renderers consume canonical frames and never own sampled-grid transport", () => {
  for (const relativePath of javascriptFiles("static/js/rendering")) {
    if (relativePath.endsWith("/render-capability.js")) continue;
    const source = read(relativePath);
    assert.doesNotMatch(source, /\bfetchJson\s*\(|\bfetch\s*\(/, relativePath);
    assert.doesNotMatch(source, /FrameDemandService|LayerQueryCoordinator/, relativePath);
    assert.doesNotMatch(source, /["'`]\/api\/datasets|\/records\?/, relativePath);
  }

  const capabilityProbe = read("static/js/rendering/render-capability.js");
  assert.equal((capabilityProbe.match(/\bfetch\s*\(/g) || []).length, 1);
  assert.match(capabilityProbe, /fetch\("\/api\/render\/capability"\)/);
  assert.match(capabilityProbe, /WEBGL_lose_context/);
  assert.doesNotMatch(capabilityProbe, /\/api\/datasets|\/records\?/);
});

test("playback lifecycle owners cannot evict completed DataFrameStore entries", () => {
  for (const relativePath of [
    "static/js/playback/playback-engine.js",
    "static/js/playback/playback-preheater.js",
    "static/js/services/frame-demand-service.js",
  ]) {
    const source = read(relativePath);
    assert.doesNotMatch(
      source,
      /(?:DataFrameStore|dataFrameStore|this\.store)\.(?:clear|evictAll|reset|delete)\s*\(/,
      relativePath,
    );
  }

  const controls = read("static/js/playback/playback-controls.js");
  const manualClearStart = controls.indexOf('$("playback-cache-clear")?.addEventListener');
  const manualClearEnd = controls.indexOf('$("sampled-grid-transition-ms")?.addEventListener', manualClearStart);
  assert.ok(manualClearStart >= 0 && manualClearEnd > manualClearStart);
  const manualClear = controls.slice(manualClearStart, manualClearEnd);
  assert.match(manualClear, /DataFrameStore\.evictAll\?\.\(\)/);
});

test("sampled-grid runtime has no GFW state mirrors or compatibility entrypoints", () => {
  const state = read("static/js/core/state.js");
  const layer = read("static/js/layers/sampled-grid-layer.js");
  const effects = read("static/js/layers/sampled-grid-layer-effects.js");
  const registry = read("static/js/rendering/renderer-registry.js");
  const artifacts = read("static/js/services/sampled-grid-render-artifact-cache.js");
  const controls = read("static/js/playback/playback-controls.js");

  for (const source of [state, layer, effects, registry, artifacts, controls]) {
    assert.doesNotMatch(
      source,
      /renderedGfwDate|gfwTransitionMs|gfwZoomBlurPx|gfwRenderArtifactCache|gfwRetiringLayers|GfwRenderArtifactCache/,
    );
  }
  assert.doesNotMatch(registry, /chooseGfwLayer|recordGfwRender|gfwMode|gfwBackend/);
  assert.doesNotMatch(layer, /reloadGfwRecords|removeGfwLayer|createGfwLayer|renderGfwMap|syncGfwTransitionStyle/);
  assert.match(artifacts, /sampledGridRetiringLayers/);
  assert.match(controls, /state\.sampledGridTransitionMs/);
  assert.match(controls, /state\.sampledGridZoomBlurPx/);
});

test("generic frame pipeline contains no source-specific schema truth", () => {
  const genericOwners = [
    "static/js/services/render-intent-service.js",
    "static/js/services/frame-identity.js",
    "static/js/services/frame-demand-service.js",
    "static/js/services/data-frame-store.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/playback-preheater.js",
    "static/js/application/widgets/widget-query-context.js",
    "static/js/application/widgets/line-chart-data-source.js",
    "static/js/application/widgets/table-widget-data-source.js",
  ];
  const forbidden = /fish_sum|gfw_full|pipeline_iceberg|fishing_hours|chlor_a|sea_temperature|ocean_productivity_score|sustainability_pressure/;
  for (const relativePath of genericOwners) {
    assert.doesNotMatch(read(relativePath), forbidden, relativePath);
  }
});

test("configured, routed and actual resolution remain separate pipeline roles", () => {
  const intent = read("static/js/services/render-intent-service.js");
  const identity = read("static/js/services/frame-identity.js");
  const demand = read("static/js/services/frame-demand-service.js");
  const apiClient = read("static/js/services/api-client.js");

  assert.match(intent, /requestedResolutionKm:\s*sampledGridContract\.requestResolution/);
  assert.match(intent, /effectiveQueryResolutionKm:\s*sampledGridContract\.queryResolution/);
  assert.match(identity, /function queryResolution\(/);
  assert.match(demand, /source_requested_resolution_km/);
  assert.match(demand, /effective_query_resolution_km/);
  assert.doesNotMatch(apiClient, /resolvedRequestContext|resolution:\s*actualResolution/);
});

test("sampled-grid runtime cannot reconstruct the removed row graph", () => {
  const frameOwners = [
    "static/js/services/query-broker.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/frame-demand-service.js",
    "static/js/layers/sampled-grid-layer.js",
    "static/js/rendering/sampled-grid-paint.js",
    "static/js/rendering/sampled-grid-webgl-renderer.js",
    "static/js/ui/map/layer-viewport-controller.js",
    "static/js/application/widgets/widget-query-context.js",
    "static/js/application/widgets/line-chart-data-source.js",
    "static/js/application/widgets/table-widget-data-source.js",
  ];
  for (const relativePath of frameOwners) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /packet\??\.rows|packet\[?['"]rows|sampledGridRowsForRender|inflateSampledGrid/, relativePath);
  }
  assert.doesNotMatch(read("static/js/core/canonical-grid-frame.js"), /get\s+rows\s*\(/);
});

test("PlaybackEngine exclusively owns buffer episodes and wall-clock timeout policy", () => {
  const engine = read("static/js/playback/playback-engine.js");
  const controls = read("static/js/playback/playback-controls.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");

  assert.match(engine, /class PlaybackBufferEpisode/);
  assert.match(engine, /buffer_episode_id/);
  assert.match(engine, /episode\.waitMs\(this\.clock\.now\(\)\)/);
  assert.doesNotMatch(controls, /BUFFER_TIMEOUT|bufferTimeoutMs|bufferWaitStartedAt/);
  assert.match(compositionRoot, /frameBufferPolicy:\s*PlaybackFrameBuffer/);
  assert.match(compositionRoot, /bufferTimeoutMs:\s*PlaybackTimePolicy\.bufferTimeoutMs\(this\.runtimeIdentity\)/);
});

test("long-lived UI helpers own and dispose their browser resources", () => {
  const aerial = read("static/js/ui/background/aerial-backdrop.js");
  const chart = read("static/js/ui/telemetry/snapshot-performance-chart.js");
  const metricsWidget = read("static/js/ui/widgets/capabilities/metrics.js");

  assert.match(aerial, /dispose\(\)\s*{/);
  assert.match(aerial, /removeEventListener\("rrkal:tile-selection-changed"/);
  assert.match(aerial, /this\.abortController\?\.abort\(\)/);
  assert.match(aerial, /URL\.revokeObjectURL/);
  assert.match(chart, /dispose\(\)\s*{/);
  assert.match(chart, /this\.resizeObserver\?\.disconnect/);
  assert.match(chart, /cancelAnimationFrame/);
  assert.match(metricsWidget, /chart\.__snapshotPerformanceChart\?\.dispose\?\.\(\)/);
  assert.match(metricsWidget, /releaseTelemetryContainer\(container\)/);
});
