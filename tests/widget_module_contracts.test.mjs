import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createContext, runInContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const applicationModules = [
  "static/js/application/widgets/widget-model-functions.js",
  "static/js/application/widgets/widget-query-context.js",
  "static/js/application/widgets/line-chart-data-source.js",
  "static/js/application/widgets/slice-chart-data-sources.js",
  "static/js/application/widgets/table-widget-data-source.js",
  "static/js/application/widgets/eez-attribution-data-source.js",
  "static/js/application/widgets/widget-application-runtime.js",
];

const jsModules = [
  ...applicationModules,
  "static/js/ui/widgets/core/widget-core.js",
  "static/js/ui/widgets/capabilities/shared.js",
  "static/js/ui/widgets/capabilities/line-chart.js",
  "static/js/ui/widgets/capabilities/horizontal-bar-chart.js",
  "static/js/ui/widgets/capabilities/pie-chart.js",
  "static/js/ui/widgets/capabilities/eez-attribution.js",
  "static/js/ui/widgets/capabilities/table.js",
  "static/js/ui/widgets/capabilities/map-jump.js",
  "static/js/ui/widgets/capabilities/metrics.js",
  "static/js/ui/widgets/capabilities/event-viewer.js",
  "static/js/ui/widgets/registry/widget-registry.js",
  "static/js/ui/widgets/runtime/widgets-runtime.js",
  "static/js/ui/widgets/widget-launchpad.js",
];

const cssModules = [
  "static/css/widgets/core/panel.css",
  "static/css/widgets/core/launchpad.css",
  "static/css/widgets/core/widget-core.css",
  "static/css/widgets/capabilities/line-chart.css",
  "static/css/widgets/capabilities/horizontal-bar-chart.css",
  "static/css/widgets/capabilities/pie-chart.css",
  "static/css/widgets/capabilities/table.css",
  "static/css/widgets/capabilities/map-jump.css",
  "static/css/widgets/capabilities/eez-attribution.css",
  "static/css/widgets/capabilities/metrics.css",
  "static/css/widgets/capabilities/event-viewer.css",
  "static/css/widgets/core/size-adaptations.css",
  "static/css/widgets/runtime/popover.css",
];

function assertOrdered(documentText, paths) {
  let cursor = -1;
  for (const relativePath of paths) {
    const publicPath = `/${relativePath}`;
    const index = documentText.indexOf(publicPath);
    assert.ok(index > cursor, `${publicPath} must be present in dependency order`);
    cursor = index;
  }
}

test("widget JavaScript modules load in dependency order", () => {
  assertOrdered(read("templates/index.html"), jsModules);
});

test("widget CSS modules preserve cascade order", () => {
  const template = read("templates/index.html");
  assertOrdered(template, cssModules);
  const mainStylesIndex = template.indexOf("/static/styles.css");
  const lastWidgetStyleIndex = template.indexOf(`/${cssModules.at(-1)}`);
  assert.ok(mainStylesIndex > lastWidgetStyleIndex, "main responsive styles must load after Widgets CSS");
});

test("launchpad SVG size is owned by a module-scoped selector", () => {
  const launchpadStyles = read("static/css/widgets/core/launchpad.css");
  const rule = launchpadStyles.match(
    /\.widget-launchpad-app-icon\s+\.widget-launchpad-lucide-icon\.control-icon\s*\{([^}]*)\}/,
  );
  assert.ok(rule, "Launchpad icons must outrank the global control-icon rule without relying on load order");
  assert.match(rule[1], /width:\s*46%;/);
  assert.match(rule[1], /height:\s*46%;/);
});

test("widget boot path has no compatibility entrypoint", () => {
  const template = read("templates/index.html");
  assert.equal(existsSync(path.join(root, "static/js/ui/widgets/widgets-panel.js")), false);
  assert.doesNotMatch(template, /widgets-panel\.js/);
});

test("sampled-grid selection exposes no GFW compatibility global", () => {
  const source = read("static/js/ui/map/tile-selection-layer.js");
  assert.doesNotMatch(source, /window\.GfwCellHitTester/);
  assert.match(source, /window\.SampledGridCellHitTester/);
});

test("sampled-grid rendering exposes no GFW compatibility globals", () => {
  const effects = read("static/js/layers/sampled-grid-layer-effects.js");
  const renderer = read("static/js/rendering/sampled-grid-webgl-renderer.js");
  assert.doesNotMatch(effects, /window\.GfwLayerEffects/);
  assert.match(effects, /window\.SampledGridLayerEffects/);
  assert.doesNotMatch(renderer, /window\.GfwWebglLayer/);
  assert.match(renderer, /window\.SampledGridWebglLayer/);
});

test("widget dependency direction stays one-way", () => {
  const core = read("static/js/ui/widgets/core/widget-core.js");
  assert.doesNotMatch(core, /WidgetCapabilities|WidgetRegistry|WidgetRuntime/);

  for (const relativePath of jsModules.filter((item) => item.includes("/capabilities/"))) {
    const capability = read(relativePath);
    assert.doesNotMatch(capability, /WidgetRegistry|WidgetRuntime/);
  }

  const registry = read("static/js/ui/widgets/registry/widget-registry.js");
  assert.doesNotMatch(registry, /addEventListener\(|map\.on\(|fetchJson\(/);

  for (const relativePath of applicationModules) {
    const application = read(relativePath);
    assert.doesNotMatch(application, /WidgetCore|WidgetCapabilities|WidgetRegistry|WidgetRuntime/);
    assert.doesNotMatch(application, /\bdocument\.|\bwindow\./);
  }
});

test("widget capabilities do not own server transport", () => {
  for (const relativePath of jsModules.filter((item) => item.includes("/capabilities/"))) {
    const capability = read(relativePath);
    assert.doesNotMatch(capability, /\bfetchJson\s*\(/, `${relativePath} must not call the server directly`);
    assert.doesNotMatch(capability, /["'`]\/api\//, `${relativePath} must not own API routes`);
  }
});

test("table widget is a read-only current-snapshot cache inspector", () => {
  const table = read("static/js/ui/widgets/capabilities/table.js");
  const source = read("static/js/application/widgets/table-widget-data-source.js");
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");

  assert.match(source, /this\.dataFrameStore\.inspect/);
  assert.match(source, /目前快照尚無快取資料/);
  assert.doesNotMatch(source, /frameDemandService|queryCoordinator|\bfetch\s*\(|\binflight\b|\/records\?/);
  assert.doesNotMatch(table, /DataFrameStore|FrameDemandService|LayerQueryCoordinator|\bstate\s*[?.]/);
  assert.doesNotMatch(runtime, /refreshTableWidgets[\s\S]{0,180}source\.clear\(\)/);
});

test("table widget formats canonical numbers without exposing floating-point tails", () => {
  const context = createContext({
    formatDisplayNumber(value, { maximumFractionDigits = 2 } = {}) {
      return Number(value).toLocaleString("zh-TW", { maximumFractionDigits });
    },
    window: {
      WidgetCore: { DashboardWidget: class {} },
      WidgetCapabilityShared: { lineChartEscape: String },
      WidgetCapabilities: {},
    },
  });
  runInContext(read("static/js/ui/widgets/capabilities/table.js"), context);
  const { formatTableCell } = context.window.WidgetCapabilities;

  assert.equal(formatTableCell(23.520833333333336, "lat"), "23.520833");
  assert.equal(formatTableCell(40.28771030548551, "value"), "40.29");
  assert.equal(
    formatTableCell({ west: 121.20833333333333, south: 23.5, east: 121.25, north: 23.541666666666668 }, "bounds"),
    "{ west: 121.208333, south: 23.5, east: 121.25, north: 23.541667 }",
  );
});

test("widget application services own data while capabilities only render injected models", () => {
  const rootSource = read("static/js/runtime/runtime-composition-root.js");
  const appRuntime = read("static/js/application/widgets/widget-application-runtime.js");
  const lineChartSource = read("static/js/application/widgets/line-chart-data-source.js");
  const registry = read("static/js/ui/widgets/registry/widget-registry.js");
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");

  assert.match(rootSource, /createWidgetApplicationRuntime\(\{/);
  assert.match(rootSource, /this\.own\("WidgetApplicationRuntime"/);
  assert.match(appRuntime, /class WidgetApplicationRuntime/);
  assert.match(appRuntime, /sources\.set\("line-chart"/);
  assert.match(registry, /createWidgetInstance\(widgetType, params = \{\}, services = \{\}\)/);
  assert.match(runtime, /applicationRuntime\.servicesFor/);
  assert.match(runtime, /targetWidget\.dispose\?\.\(\)/);
  assert.doesNotMatch(runtime, /currentWidget\.dispose\?\.\(\)/);
  assert.match(lineChartSource, /refresh\(\{ cause = "context_changed" \}/);
  assert.match(lineChartSource, /playbackOwnsQueryLifecycle/);
  assert.doesNotMatch(runtime, /networkMode|PlaybackEngine/);

  for (const relativePath of jsModules.filter((item) => item.includes("/capabilities/"))) {
    const capability = read(relativePath);
    assert.doesNotMatch(capability, /class \w+DataSource\b|\.shared\(\)/, relativePath);
    assert.doesNotMatch(capability, /DataFrameStore|FrameDemandService|LayerQueryCoordinator/, relativePath);
  }
});

test("event viewer is a registered read-only lifecycle widget", () => {
  const eventViewer = read("static/js/ui/widgets/capabilities/event-viewer.js");
  const registry = read("static/js/ui/widgets/registry/widget-registry.js");
  assert.match(eventViewer, /LifecycleEventLog/);
  assert.match(eventViewer, /exportRun/);
  assert.match(eventViewer, /renderExpandedContent\(container, model\)/);
  assert.match(eventViewer, /scheduleBindingRender\(binding\)/);
  assert.match(eventViewer, /this\.services\.schedule\?\.\(\(\) =>/);
  assert.match(eventViewer, /bindingByContainer = new WeakMap\(\)/);
  assert.match(eventViewer, /WATERMARK_POLICY_CHANGED/);
  assert.match(eventViewer, /RUN_FINISHED[\s\S]{0,180}event\.reason/);
  assert.match(eventViewer, /effective|有效水位|低 \$\{Number\(event\.low_watermark/);
  const exportHandlerStart = eventViewer.indexOf('querySelector("[data-event-export]")');
  const exportMethodStart = eventViewer.indexOf("\n  exportRun(runId)", exportHandlerStart);
  assert.ok(exportHandlerStart >= 0 && exportMethodStart > exportHandlerStart);
  assert.match(eventViewer.slice(exportHandlerStart, exportMethodStart), /addEventListener\("click"/);
  assert.equal((eventViewer.match(/this\.exportRun\(/g) || []).length, 1);
  assert.doesNotMatch(eventViewer, /\n\s*renderExpanded\s*\(/);
  assert.doesNotMatch(eventViewer, /FrameDemandService|LayerQueryCoordinator|fetchJson|["'`]\/api\//);
  assert.match(registry, /"event-viewer"/);
  assert.match(registry, /LifecycleEventViewerWidget/);
});

test("visible metric values use the shared formatter without fixed trailing zeroes", () => {
  const numericSurfaces = [
    read("static/js/ui/widgets/capabilities/table.js"),
    read("static/js/ui/widgets/capabilities/metrics.js"),
    read("static/js/ui/widgets/capabilities/event-viewer.js"),
    read("static/js/ui/telemetry/snapshot-performance-chart.js"),
    read("static/js/playback/playback-controls.js"),
    read("static/js/playback/playback-cache-service.js"),
    read("static/js/ui/layers/ais-settings.js"),
    read("static/js/services/api-client.js"),
    read("static/js/ui/developer/developer-utils.js"),
  ];
  for (const source of numericSurfaces) {
    assert.doesNotMatch(source, /\.toFixed\(/);
  }
  for (const source of numericSurfaces.slice(0, 8)) {
    assert.match(source, /formatDisplayNumber/);
  }
});

test("widget page lifecycle is owned by runtime only", () => {
  for (const relativePath of jsModules) {
    const source = read(relativePath);
    if (relativePath.endsWith("runtime/widgets-runtime.js")) {
      assert.match(source, /AppRuntime\.install\(/);
      assert.match(source, /class WidgetRuntimeController/);
      assert.match(source, /class WidgetRefreshCoordinator/);
      assert.match(source, /createWidgetRuntimeOwner\(\{/);
      const runtimeClass = source.slice(
        source.indexOf("class WidgetRuntimeController"),
        source.indexOf("function createWidgetRuntimeOwner"),
      );
      assert.doesNotMatch(runtimeClass, /new WidgetRefreshCoordinator/);
      assert.match(source, /refreshCoordinatorFactory: \(dependencies\) => new WidgetRefreshCoordinator/);
      assert.doesNotMatch(source, /function bindChartWidgetRefresh/);
      assert.match(source, /this\.refreshCoordinator\?\.dispose\(\)/);
      assert.match(source, /this\.applicationRuntime\.cancelSchedule\(timerId\)/);
      assert.doesNotMatch(source, /WidgetPopoverController\.shared\(\)/);
      continue;
    }
    assert.doesNotMatch(source, /initWidgetsPanels\(\)|bindChartWidgetRefresh\(\)/);
  }
});

test("Plotly widgets share one visibility-aware resize lifecycle", () => {
  const core = read("static/js/ui/widgets/core/widget-core.js");
  assert.match(core, /class WidgetPlotlyLifecycle/);
  assert.match(core, /!chart\?\.isConnected/);
  assert.match(core, /chart\.getClientRects\(\)\.length === 0/);

  for (const relativePath of [
    "static/js/ui/widgets/capabilities/line-chart.js",
    "static/js/ui/widgets/capabilities/horizontal-bar-chart.js",
    "static/js/ui/widgets/capabilities/pie-chart.js",
  ]) {
    const capability = read(relativePath);
    assert.match(capability, /WidgetPlotlyLifecycle\.waitUntilDisplayed/);
    assert.match(capability, /WidgetPlotlyLifecycle\.scheduleResize/);
    assert.doesNotMatch(capability, /Plotly\?*\.Plots\?*\.resize/);
  }
});

test("metrics observation is coalesced and does not redraw unchanged history", () => {
  const metrics = read("static/js/ui/widgets/capabilities/metrics.js");
  assert.match(metrics, /METRICS_TELEMETRY_REFRESH_MS\s*=\s*500/);
  assert.match(metrics, /updateTelemetryView\(container, latestPacket, \{ updateHistory: historyDirty \}\)/);
  assert.match(metrics, /metricsHistorySignature/);
  assert.doesNotMatch(metrics, /schedule\?\.\(update, 160\)/);
});

test("widget deletion policy is owned by the ability registry", () => {
  const registry = read("static/js/ui/widgets/registry/widget-registry.js");
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");
  const metricsDefinition = registry.match(/metrics:\s*Object\.freeze\(\{([\s\S]*?)\}\),/);
  const defaultMetrics = runtime.match(/Object\.freeze\(\{\s*type:\s*"metrics"([^}]*)\}\),/);

  assert.ok(metricsDefinition, "metrics ability must be registered");
  assert.match(metricsDefinition[1], /deletable:\s*true/);
  assert.ok(defaultMetrics, "metrics must exist in the default layout");
  assert.doesNotMatch(defaultMetrics[1], /deletable:/);
  assert.match(runtime, /deletable:\s*definition\?\.deletable/);
});

test("launchpad enumerates registered abilities instead of blank templates", () => {
  const registry = read("static/js/ui/widgets/registry/widget-registry.js");
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");
  const launchpad = read("static/js/ui/widgets/widget-launchpad.js");

  assert.match(registry, /function createRegisteredWidgetCatalog\(\)/);
  assert.match(registry, /createWidgetCatalog\(\)\.filter\(\(item\) => item\.group === "registered"\)/);
  assert.match(runtime, /registered:\s*createRegisteredWidgetCatalog/);
  assert.match(launchpad, /WidgetCatalog\?\.registered\?\.\(\)/);
  assert.doesNotMatch(launchpad, /WidgetCatalog\?\.create\?\.\(\)/);
});

test("widget CSS modules are syntactically balanced", () => {
  for (const relativePath of cssModules) {
    const source = read(relativePath);
    const openCount = source.match(/\{/g)?.length || 0;
    const closeCount = source.match(/\}/g)?.length || 0;
    assert.equal(openCount, closeCount, `${relativePath} has unbalanced braces`);
  }
  const mainStyles = read("static/styles.css");
  assert.doesNotMatch(mainStyles, /\.widget-template-line\s*\{/);
  assert.doesNotMatch(mainStyles, /\.widget-popover-layer\s*\{/);
});
