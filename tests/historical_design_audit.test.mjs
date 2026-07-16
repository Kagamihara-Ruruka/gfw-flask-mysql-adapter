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
  const manualClearEnd = controls.indexOf('$("gfw-transition-ms")?.addEventListener', manualClearStart);
  assert.ok(manualClearStart >= 0 && manualClearEnd > manualClearStart);
  const manualClear = controls.slice(manualClearStart, manualClearEnd);
  assert.match(manualClear, /DataFrameStore\.evictAll\?\.\(\)/);
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
