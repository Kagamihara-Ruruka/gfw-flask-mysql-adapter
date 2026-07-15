import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const coreOwners = [
  ["static/js/services/lifecycle-event-log.js", "LifecycleEventLogCore"],
  ["static/js/services/layer-query-coordinator.js", "QueryScheduler"],
  ["static/js/services/data-frame-store.js", "DataFrameStoreCore"],
  ["static/js/playback/playback-preheater.js", "PlaybackPreheaterController"],
  ["static/js/playback/playback-engine.js", "PlaybackEngineCore"],
  ["static/js/playback/playback-renderer.js", "PlaybackRendererController"],
  ["static/js/core/render-state.js", "RenderStateController"],
  ["static/js/services/gfw-render-artifact-cache.js", "RenderArtifactCache"],
  ["static/js/rendering/virtual-grid-contract.js", "VirtualGridRuntimeController"],
  ["static/js/ui/map/layer-viewport-controller.js", "DatasetViewportController"],
];

test("stateful core owners are defined without self-instantiating singletons", () => {
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");
  for (const [relativePath, className] of coreOwners) {
    const source = read(relativePath);
    assert.match(source, new RegExp(`class ${className}\\b`), relativePath);
    assert.doesNotMatch(source, new RegExp(`new ${className}\\s*\\(`), relativePath);
    assert.match(compositionRoot, new RegExp(`new ${className}\\s*\\(`), className);
  }
  assert.equal((compositionRoot.match(/new RuntimeCompositionRoot\s*\(/g) || []).length, 1);
});

test("stateless application services use injected factories instead of classes", () => {
  const demand = read("static/js/services/frame-demand-service.js");
  const cache = read("static/js/playback/playback-cache-service.js");
  const renderIntent = read("static/js/services/render-intent-service.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");

  assert.match(demand, /function createFrameDemandService\(\{/);
  assert.doesNotMatch(demand, /class FrameDemandService/);
  assert.match(cache, /function createPlaybackCacheService\(\{/);
  assert.doesNotMatch(cache, /class PlaybackCacheService/);
  assert.doesNotMatch(cache, /const PlaybackCacheService\s*=\s*\(\(\)\s*=>/);
  assert.match(renderIntent, /function createRenderIntentService\(\{/);
  assert.doesNotMatch(renderIntent, /class RenderIntentService/);
  assert.doesNotMatch(renderIntent, /const RenderIntentService\s*=\s*\(\(\)\s*=>/);
  assert.doesNotMatch(renderIntent, /\bwindow\.|\bstate\.|\bFrameIdentity\b|\bSampledGridContract\b/);
  assert.doesNotMatch(renderIntent, /toGfwPacketRequest|toGfwRangeRequest/);
  assert.match(compositionRoot, /createFrameDemandService\(\{/);
  assert.match(compositionRoot, /createPlaybackCacheService\(\{/);
  assert.match(compositionRoot, /createRenderIntentService\(\{/);
});

test("runtime definitions load before the composition root and consumers load after it", () => {
  const template = read("templates/index.html");
  const scripts = [...template.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1].split("?")[0]);
  const indexOf = (suffix) => scripts.findIndex((source) => source.endsWith(suffix));
  const rootIndex = indexOf("/static/js/runtime/runtime-composition-root.js");
  assert.ok(rootIndex >= 0, "composition root script is required");

  for (const definition of [
    "/static/js/services/lifecycle-event-log.js",
    "/static/js/services/layer-query-coordinator.js",
    "/static/js/services/data-frame-store.js",
    "/static/js/services/frame-demand-service.js",
    "/static/js/services/render-intent-service.js",
    "/static/js/playback/playback-cache-service.js",
    "/static/js/playback/playback-preheater.js",
    "/static/js/playback/playback-engine.js",
    "/static/js/playback/playback-renderer.js",
  ]) {
    assert.ok(indexOf(definition) >= 0 && indexOf(definition) < rootIndex, definition);
  }
  for (const consumer of [
    "/static/js/ui/map/tile-selection-layer.js",
    "/static/js/ui/layers/layer-activation-controller.js",
    "/static/js/ui/widgets/runtime/widgets-runtime.js",
    "/static/app.js",
  ]) {
    assert.ok(indexOf(consumer) > rootIndex, consumer);
  }
});

test("runtime-owned resources expose symmetric teardown", () => {
  const lifecycleFiles = [
    "static/js/services/lifecycle-event-log.js",
    "static/js/services/layer-query-coordinator.js",
    "static/js/services/data-frame-store.js",
    "static/js/playback/playback-preheater.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/playback-renderer.js",
    "static/js/rendering/virtual-grid-contract.js",
    "static/js/ui/map/layer-viewport-controller.js",
    "static/js/ui/map/tile-selection-layer.js",
    "static/js/ui/layers/layer-activation-controller.js",
    "static/js/ui/widgets/runtime/widgets-runtime.js",
  ];
  for (const relativePath of lifecycleFiles) {
    assert.match(read(relativePath), /\bdispose\s*\(/, relativePath);
  }
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");
  assert.match(compositionRoot, /\[\.\.\.this\.disposalOrder\]\.reverse\(\)/);
  assert.doesNotMatch(compositionRoot, /instance\?\.dispose\?\.\(\);\s*instance\?\.destroy/);
});

test("pure calculations and registry decisions are not replaced by inheritance", () => {
  const viewport = read("static/js/ui/map/layer-viewport-controller.js");
  const widgetCore = read("static/js/ui/widgets/core/widget-core.js");
  const widgetRegistry = read("static/js/ui/widgets/registry/widget-registry.js");

  assert.match(viewport, /function createDatasetCoverageModel\(/);
  assert.doesNotMatch(viewport, /class DatasetCoverageModel/);
  assert.match(widgetCore, /const WidgetSizeAbleDict = Object\.freeze/);
  assert.match(widgetRegistry, /const WidgetAbilityRegistry = Object\.freeze/);
  assert.match(widgetRegistry, /function createWidgetInstance\(/);
});

test("the Application Service template is stateless and dependency-injected", () => {
  const template = read("docs/architecture/application-service.template.js");
  assert.match(template, /function createExampleApplicationService\(\{/);
  assert.match(template, /return Object\.freeze\(\{ execute \}\)/);
  assert.doesNotMatch(template, /\bclass\s+[A-Z]/);
  assert.doesNotMatch(template, /\bwindow\.|\bglobalThis\.|\bstate\./);
});

test("runtime JavaScript has no shared service-locator entrypoint", () => {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relativePath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.name.endsWith(".js")) assert.doesNotMatch(read(relativePath), /\.shared\(\)/, relativePath);
    }
  };
  visit("static/js");
});
