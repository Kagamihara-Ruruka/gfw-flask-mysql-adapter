import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const coreOwners = [
  ["static/js/services/lifecycle-event-log.js", "LifecycleEventLogCore"],
  ["static/js/services/layer-query-coordinator.js", "QueryScheduler"],
  ["static/js/services/query-broker.js", "QueryBroker"],
  ["static/js/services/query-policy-controller.js", "QueryPolicyControllerCore"],
  ["static/js/services/data-frame-store.js", "DataFrameStoreCore"],
  ["static/js/services/frame-demand-service.js", "FrameDemandServiceCore"],
  ["static/js/playback/playback-preheater.js", "PlaybackPreheaterController"],
  ["static/js/playback/playback-engine.js", "PlaybackEngineCore"],
  ["static/js/playback/playback-runtime-controller.js", "PlaybackRuntimeController"],
  ["static/js/playback/adaptive-watermark-controller.js", "AdaptiveWatermarkControllerCore"],
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

test("stateful demand is a DI-owned class while stateless application services stay factories", () => {
  const demand = read("static/js/services/frame-demand-service.js");
  const cache = read("static/js/playback/playback-cache-service.js");
  const renderIntent = read("static/js/services/render-intent-service.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");

  assert.match(demand, /class FrameDemandServiceCore\b/);
  assert.doesNotMatch(demand, /function createFrameDemandService/);
  assert.match(cache, /function createPlaybackCacheService\(\{/);
  assert.doesNotMatch(cache, /class PlaybackCacheService/);
  assert.doesNotMatch(cache, /const PlaybackCacheService\s*=\s*\(\(\)\s*=>/);
  assert.match(renderIntent, /function createRenderIntentService\(\{/);
  assert.doesNotMatch(renderIntent, /class RenderIntentService/);
  assert.doesNotMatch(renderIntent, /const RenderIntentService\s*=\s*\(\(\)\s*=>/);
  assert.doesNotMatch(renderIntent, /\bwindow\.|\bstate\.|\bFrameIdentity\b|\bSampledGridContract\b/);
  assert.doesNotMatch(renderIntent, /toGfwPacketRequest|toGfwRangeRequest/);
  assert.match(compositionRoot, /new FrameDemandServiceCore\(\{/);
  assert.match(compositionRoot, /decorateFrameDemandService\(/);
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
    "/static/js/services/query-broker.js",
    "/static/js/services/query-policy-controller.js",
    "/static/js/services/data-frame-store.js",
    "/static/js/services/frame-demand-service.js",
    "/static/js/services/frame-demand-decorators.js",
    "/static/js/services/render-intent-service.js",
    "/static/js/playback/playback-cache-service.js",
    "/static/js/playback/playback-preheater.js",
    "/static/js/playback/playback-engine.js",
    "/static/js/playback/playback-runtime-controller.js",
    "/static/js/playback/adaptive-watermark-controller.js",
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
    "static/js/services/query-broker.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/frame-demand-service.js",
    "static/js/playback/playback-preheater.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/playback-runtime-controller.js",
    "static/js/playback/adaptive-watermark-controller.js",
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
  const frameIdentity = read("static/js/services/frame-identity.js");
  const viewport = read("static/js/ui/map/layer-viewport-controller.js");
  const widgetCore = read("static/js/ui/widgets/core/widget-core.js");
  const widgetRegistry = read("static/js/ui/widgets/registry/widget-registry.js");

  assert.match(frameIdentity, /function createFrameIdentity\(\{ datasetResolver \}/);
  assert.doesNotMatch(frameIdentity, /\bstate\b|class FrameIdentity/);
  assert.match(viewport, /function createDatasetCoverageModel\(/);
  assert.doesNotMatch(viewport, /class DatasetCoverageModel/);
  assert.match(widgetCore, /const WidgetSizeAbleDict = Object\.freeze/);
  assert.match(widgetRegistry, /const WidgetAbilityRegistry = Object\.freeze/);
  assert.match(widgetRegistry, /function createWidgetInstance\(/);
});

test("query coordinator does not expose its scheduler implementation", () => {
  const coordinator = read("static/js/services/layer-query-coordinator.js");
  const returnBlock = coordinator.slice(
    coordinator.indexOf("return Object.freeze({", coordinator.indexOf("function createLayerQueryCoordinator")),
    coordinator.indexOf("});", coordinator.indexOf("function createLayerQueryCoordinator")) + 3,
  );
  assert.doesNotMatch(returnBlock, /\bscheduler\s*,/);
});

test("sampled-grid transport has one DI-owned batch boundary", () => {
  const broker = read("static/js/services/query-broker.js");
  const demand = read("static/js/services/frame-demand-service.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");

  assert.match(broker, /class QueryBroker\b/);
  assert.match(broker, /compileQueryBatch/);
  assert.match(broker, /splitQueryBatchEvent/);
  assert.match(broker, /"\/api\/query\/batch"/);
  assert.doesNotMatch(demand, /\bfetch\s*\(|fetchJson|\/api\/datasets\//);
  assert.match(demand, /this\.queryBroker\.requestSampledGrid/);
  assert.match(compositionRoot, /this\.own\("QueryBroker", new QueryBroker\(\{/);
  assert.match(broker, /operation\?\.source_key/);
  assert.doesNotMatch(broker, /source_key:\s*String\(operation\.source_key/);
});

test("query policy mutations are aggregated behind the DI-owned controller", () => {
  const controls = read("static/js/playback/playback-controls.js");
  const controller = read("static/js/services/query-policy-controller.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");

  assert.doesNotMatch(controls, /LayerQueryCoordinator\.drain/);
  assert.doesNotMatch(controls, /queryPolicy\.(?:network_concurrency|background_network_concurrency)\s*=/);
  assert.match(controls, /QueryPolicyController\.setNetworkConcurrency/);
  assert.match(controls, /QueryPolicyController\.setBackgroundConcurrency/);
  assert.match(controller, /class QueryPolicyControllerCore\b/);
  assert.match(compositionRoot, /new QueryPolicyControllerCore\(\{/);
});

test("demand telemetry is a DI-composed decorator with no business authority", () => {
  const decorator = read("static/js/services/frame-demand-decorators.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");

  assert.match(decorator, /function decorateFrameDemandService\(service, \{ eventLog, clock \}/);
  assert.match(compositionRoot, /decorateFrameDemandService\([\s\S]*new FrameDemandServiceCore\(\{/);
  assert.doesNotMatch(decorator, /\bfetch\s*\(|fetchJson|DataFrameStore|LayerQueryCoordinator|QueryScheduler/);
  assert.doesNotMatch(decorator, /\bwindow\.|\bstate\.|\bglobalThis\.(?!decorateFrameDemandService)/);
  assert.doesNotMatch(decorator, /CACHE_HIT|CACHE_MISS|HTTP_STARTED|HTTP_FINISHED/);
});

test("the Application Service template is stateless and dependency-injected", () => {
  const template = read("docs/architecture/application-service.template.js");
  assert.match(template, /function createExampleApplicationService\(\{/);
  assert.match(template, /return Object\.freeze\(\{ execute \}\)/);
  assert.doesNotMatch(template, /\bclass\s+[A-Z]/);
  assert.doesNotMatch(template, /\bwindow\.|\bglobalThis\.|\bstate\./);
});

test("runtime architecture documentation describes the current owners and facades", () => {
  const architecture = read("docs/architecture/runtime-oop.md");
  const readme = read("README.md");
  const readmeZh = read("README.zh-TW.md");

  assert.match(architecture, /FrameDemandServiceCore/);
  assert.match(architecture, /PlaybackRuntime.*UI.*唯一 facade/);
  assert.match(architecture, /decorateFrameDemandService/);
  assert.doesNotMatch(architecture, /FrameDemandService IIFE|FrameDemand Application Service/);
  assert.doesNotMatch(architecture, /FrameDemandService.*無可變狀態/);
  for (const source of [readme, readmeZh]) {
    assert.match(source, /playback-runtime-controller\.js/);
    assert.match(source, /frame-demand-decorators\.js/);
    assert.doesNotMatch(source, /UI->>Playback: setPlayback/);
  }
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
