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
  "static/js/application/widgets/spotify-player-session.js",
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
  "static/js/ui/widgets/capabilities/usage-guide.js",
  "static/js/ui/widgets/capabilities/spotify-player.js",
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
  "static/css/widgets/capabilities/usage-guide.css",
  "static/css/widgets/capabilities/spotify-player.css",
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
  assert.match(effects, /globalThis\.SampledGridLayerTransitionControllerCore/);
  assert.doesNotMatch(effects, /SampledGridLayerEffects/);
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

test("usage guide is a registered 1x1 static widget", () => {
  const core = read("static/js/ui/widgets/core/widget-core.js");
  const guide = read("static/js/ui/widgets/capabilities/usage-guide.js");
  const registry = read("static/js/ui/widgets/registry/widget-registry.js");

  assert.match(core, /"usage-guide": Object\.freeze\(\["1x1"\]\)/);
  assert.match(guide, /class UsageGuideWidget extends DashboardWidget/);
  assert.match(guide, /快速開始/);
  assert.match(guide, /選格與 Widget/);
  assert.doesNotMatch(guide, /usage-guide-close-button|onClose/);
  assert.doesNotMatch(guide, /DataFrameStore|FrameDemandService|LayerQueryCoordinator|fetchJson|["'`]\/api\//);
  assert.match(registry, /"usage-guide"/);
  assert.match(registry, /UsageGuideWidget/);
});

test("Spotify easter egg is a lazy registered 1x1 external player", () => {
  const core = read("static/js/ui/widgets/core/widget-core.js");
  const player = read("static/js/ui/widgets/capabilities/spotify-player.js");
  const session = read("static/js/application/widgets/spotify-player-session.js");
  const applicationRuntime = read("static/js/application/widgets/widget-application-runtime.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");
  const registry = read("static/js/ui/widgets/registry/widget-registry.js");
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");
  const popoverCss = read("static/css/widgets/runtime/popover.css");

  assert.match(core, /"spotify-player": Object\.freeze\(\["1x1"\]\)/);
  assert.match(player, /class SpotifyPlayerWidget extends DashboardWidget/);
  assert.match(player, /43b6I3gZnUiVxNBUeq9FsL/);
  assert.match(player, /Wish me luck!!!! - instrumental/);
  assert.match(player, /thumbnailUrl:\s*"https:\/\/image-cdn-[^"]+\.spotifycdn\.com\/image\//);
  assert.match(player, /class="spotify-player-cover"/);
  assert.match(player, /class="spotify-player-equalizer"/);
  assert.doesNotMatch(player, /spotify-player-compact-copy/);
  assert.match(player, /showsDashboardHeader\(\)\s*\{\s*return false;/);
  assert.match(core, /showsDashboardHeader\(\)\s*\{\s*return true;/);
  assert.match(core, /item\.setAttribute\("aria-label", this\.title\)/);
  assert.doesNotMatch(player, /7IY2C495boRx3P5bTmdt3N/);
  assert.match(player, /348NF6vX0Yh22xvH0EZEro/);
  assert.match(player, /NIGHT DANCER/);
  assert.match(player, /2ZT6eELxeETGamaiXu6vmk/);
  assert.match(player, /more than words/);
  assert.match(player, /3uI2KolgU1Pt41ywffsggr/);
  assert.match(player, /Voyaging Star's Farewell/);
  assert.match(player, /7Lm9ji00foCFC68YxVhw9E/);
  assert.match(player, /夏枯れ/);
  assert.match(player, /0SAnLrDBdgZLg6ioLzRBNn/);
  assert.match(player, /With Glory I Shall Fall/);
  assert.match(player, /kind:\s*"track"/);
  assert.match(player, /https:\/\/open\.spotify\.com\/embed\/\$\{kind\}/);
  assert.match(player, /loading="lazy"/);
  assert.match(player, /if \(expanded\) this\.renderExpandedContent\(container, \{ cinema \}\)/);
  assert.match(player, /class="spotify-player-shell\$\{cinema \? " is-cinema" : ""\}"/);
  assert.match(player, /\$\{cinema \? this\.renderPlaylist\(\) : ""\}/);
  assert.match(player, /renderCinema\(container\)/);
  assert.match(player, /draggable="true"/);
  assert.match(player, /moveItem\(itemId, targetId/);
  assert.match(player, /this\.services\.readPreference\?\.\("trackOrder"\)/);
  assert.match(player, /this\.services\.writePreference\?\.\("trackOrder"/);
  assert.doesNotMatch(player, /renderHeading|spotify-player-heading|spotify-player-brand-mark|RuRuKa recommend/);
  assert.doesNotMatch(player, /spotify-player-close-button|dashboard-widget-size|onClose/);
  assert.match(player, /https:\/\/accounts\.spotify\.com\/login/);
  assert.match(player, /data-spotify-reconnect/);
  assert.doesNotMatch(player, /data-lucide="log-in"/);
  assert.match(player, /popoverRetentionKey\(\)[\s\S]*spotify-player-session/);
  assert.match(player, /this\.services\.playerSession/);
  assert.doesNotMatch(player, /localStorage|sessionStorage/);
  assert.match(session, /class SpotifyPlayerSession/);
  assert.match(applicationRuntime, /normalized === "spotify-player"[\s\S]*playerSession/);
  assert.match(compositionRoot, /this\.own\("SpotifyPlayerSession"/);
  assert.match(core, /renderCinema\(container\)[\s\S]*this\.replaceRenderedTemplate\(container, \{ expanded: true, cinema: true \}\)/);
  assert.match(runtime, /widget\.renderCinema\(body\)/);
  assert.match(runtime, /this\.retainedViews = new Map\(\)/);
  assert.match(runtime, /for \(const retainedView of this\.retainedViews\.values\(\)\)[\s\S]*retainedView\.pane\.hidden = true/);
  assert.match(
    runtime,
    /if \(!view\.retentionKey\)[\s\S]*view\.widget\?\.disposeRenderedView\?\.\(view\.pane\)[\s\S]*view\.pane\.remove\(\)/,
  );
  assert.match(popoverCss, /\.widget-popover\[hidden\],[\s\S]*\.widget-settings-popover\[hidden\][\s\S]*display:\s*none/);
  assert.doesNotMatch(core, /forceCloseWidgetPopoverLayers/);
  assert.doesNotMatch(runtime, /forceCloseWidgetPopoverLayers|layer\.replaceChildren\(\)/);
  assert.doesNotMatch(player, /DataFrameStore|FrameDemandService|LayerQueryCoordinator|fetchJson|["'`]\/api\//);
  assert.match(registry, /"spotify-player"/);
  assert.match(registry, /SpotifyPlayerWidget/);
  assert.match(registry, /title:\s*"彩蛋"/);
});

test("Spotify session preserves one selection and playlist order across widget views", () => {
  const context = createContext({});
  runInContext(read("static/js/application/widgets/spotify-player-session.js"), context);
  const session = new context.SpotifyPlayerSessionCore();
  const items = [
    Object.freeze({ id: "a", label: "A" }),
    Object.freeze({ id: "b", label: "B" }),
    Object.freeze({ id: "c", label: "C" }),
  ];
  session.configure(items, { order: ["b", "a"] });
  assert.deepEqual(Array.from(session.snapshot().order), ["b", "a", "c"]);
  assert.equal(session.activeItem().id, "b");
  assert.equal(session.select("c"), true);
  assert.equal(session.activeItem().id, "c");
  assert.equal(session.move("c", "b", { after: false }), true);
  assert.deepEqual(Array.from(session.snapshot().order), ["c", "b", "a"]);
});

test("line-chart moving averages are pure cache-view overlays", () => {
  const context = createContext({});
  runInContext(read("static/js/application/widgets/widget-model-functions.js"), context);
  const movingAverage = context.WidgetApplicationFunctions.widgetSimpleMovingAverage;

  assert.deepEqual(Array.from(movingAverage([1, 2, 3, 4, 5, 6], 5)), [null, null, null, null, 3, 4]);
  assert.deepEqual(Array.from(movingAverage([1, 2, null, 4, 5, 6], 5)), [null, null, null, null, null, null]);
  assert.deepEqual(Array.from(movingAverage([0, 0, 0, 0, 0], 5)), [null, null, null, null, 0]);

  const lineChart = read("static/js/ui/widgets/capabilities/line-chart.js");
  assert.match(lineChart, /renderCapabilitySettings/);
  assert.match(lineChart, /MA5/);
  assert.match(lineChart, /MA10/);
  assert.match(lineChart, /widgetSimpleMovingAverage/);
  assert.match(lineChart, /presentation_settings_changed/);
  assert.doesNotMatch(lineChart, /dataSource\.clear\(|FrameDemandService|fetchJson|["'`]\/api\//);
});

test("map-jump exposes only explicit destination commands", () => {
  const mapCore = read("static/js/core/map.js");
  const applicationRuntime = read("static/js/application/widgets/widget-application-runtime.js");
  const compositionRoot = read("static/js/runtime/runtime-composition-root.js");
  const mapJump = read("static/js/ui/widgets/capabilities/map-jump.js");
  assert.match(mapCore, /const MapViewActionRegistry = Object\.freeze/);
  assert.match(mapCore, /"northwest-pacific"[\s\S]*label:\s*"西北太平洋"/);
  assert.match(mapCore, /fitBounds\(\[\[15,\s*105\],\s*\[35,\s*135\]\]/);
  assert.match(mapCore, /reset:[\s\S]*exposed:\s*false/);
  assert.match(mapJump, /this\.services\.viewActions/);
  assert.match(mapJump, /this\.services\.runViewAction/);
  assert.doesNotMatch(mapJump, /"world"|"taiwan"|"northwest-pacific"|西北太平洋|重設/);
  assert.match(applicationRuntime, /viewActions:\s*this\.mapViewActions/);
  assert.match(compositionRoot, /mapViewActions:\s*this\.globalTarget\.MapViewActionCatalog/);
});

test("dashboard defaults preserve the accepted six-widget layout", () => {
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");
  assert.match(runtime, /type:\s*"line-chart"[^}]*slotIndex:\s*0/);
  assert.match(runtime, /type:\s*"pie-chart"[^}]*slotIndex:\s*2/);
  assert.match(runtime, /type:\s*"map-jump"[^}]*slotIndex:\s*5/);
  assert.match(runtime, /type:\s*"eez-attribution"[^}]*slotIndex:\s*11/);
  assert.match(runtime, /type:\s*"metrics"[^}]*slotIndex:\s*12/);
  assert.match(runtime, /type:\s*"horizontal-bar-chart"[^}]*slotIndex:\s*14/);
  assert.match(runtime, /type:\s*"spotify-player"[^}]*slotIndex:\s*17/);
});

test("widget popovers use one backdrop-owned chrome without size capsules", () => {
  const core = read("static/js/ui/widgets/core/widget-core.js");
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");
  const guide = read("static/js/ui/widgets/capabilities/usage-guide.js");
  const player = read("static/js/ui/widgets/capabilities/spotify-player.js");
  assert.doesNotMatch(core, /dashboard-widget-size/);
  assert.match(runtime, /const pane = widget\.renderExpanded\(\)/);
  assert.doesNotMatch(runtime, /widget\.renderExpanded\(\{[\s\S]{0,120}onClose/);
  assert.doesNotMatch(guide, /close-button|onClose/);
  assert.doesNotMatch(player, /close-button|onClose/);
});

test("compact pie uses a half-donut while expanded views retain Plotly", () => {
  const pie = read("static/js/ui/widgets/capabilities/pie-chart.js");
  const styles = read("static/css/widgets/capabilities/pie-chart.css");
  assert.match(pie, /usePlotlyRenderer\(\{ expanded = false \}[\s\S]*return expanded/);
  assert.match(pie, /semiDonutPath/);
  assert.match(pie, /aria-label="半圓比例圖"/);
  assert.match(styles, /\.widget-pie-shape[\s\S]*aspect-ratio:\s*2\s*\/\s*1\.08/);
});

test("horizontal comparison layouts stay inside compact and expanded bounds", () => {
  const horizontal = read("static/js/ui/widgets/capabilities/horizontal-bar-chart.js");
  const styles = read("static/css/widgets/capabilities/horizontal-bar-chart.css");
  assert.match(horizontal, /pane\.classList\.add\("horizontal-bar-popover"\)/);
  assert.match(styles, /\.dashboard-widget\[data-widget-size="1x3"\][\s\S]*\.widget-chart-empty-state[\s\S]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  assert.match(styles, /\.widget-horizontal-bar-plotly-stage[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.widget-horizontal-bar-plotly-chart[\s\S]*max-width:\s*100%[\s\S]*min-height:\s*0/);
  assert.match(styles, /\.widget-popover\.horizontal-bar-popover\[data-widget-size="1x3"\][\s\S]*height:\s*min\(460px[\s\S]*aspect-ratio:\s*auto/);
});

test("latest-date is an accessible icon command", () => {
  const template = read("templates/index.html");
  const button = template.match(/<button id="latest-date"[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(button, /aria-label="最後一日"/);
  assert.match(button, /data-lucide="skip-forward"/);
  assert.match(button, /control-icon-fallback" aria-hidden="true">⏭<\/span>/);
  assert.doesNotMatch(button, />最後一日</);
});

test("developer route state tables share one column track", () => {
  const styles = read("static/css/developer-status.css");
  const statusMachines = read("static/js/ui/developer/developer-status-machines.js");
  assert.match(styles, /\.developer-status-table:is\(\.is-database, \.is-websocket, \.is-spatial\)/);
  assert.match(statusMachines, /ROUTE_STATUS_COLUMN_WIDTHS\s*=\s*Object\.freeze/);
  assert.equal((statusMachines.match(/columns:\s*routeStatusColumns\(/g) || []).length, 3);
  for (const width of ["22%", "13%", "18%", "7%", "26%"]) {
    assert.match(statusMachines, new RegExp(`"${width.replace("%", "\\%")}"`));
  }
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
  const runtime = read("static/js/ui/widgets/runtime/widgets-runtime.js");
  assert.match(core, /class WidgetPlotlyLifecycle/);
  assert.match(core, /!chart\?\.isConnected/);
  assert.match(core, /chart\.getClientRects\(\)\.length === 0/);
  assert.match(core, /static purge\(root\)/);
  assert.match(core, /window\.Plotly\.purge\(chart\)/);
  assert.match(runtime, /replaceRenderedTemplate\(body/);
  assert.match(runtime, /WidgetPlotlyLifecycle\.purge\(this\.grid\)/);

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
  const metricsCss = read("static/css/widgets/capabilities/metrics.css");
  assert.match(metrics, /METRICS_TELEMETRY_REFRESH_MS\s*=\s*500/);
  assert.match(metrics, /pane\.classList\.add\("metrics-popover"\)/);
  assert.match(metricsCss, /\.widget-popover\.metrics-popover\[data-widget-size="1x2"\][\s\S]*height:\s*min\(460px/);
  assert.match(metricsCss, /data-metrics-view="expanded"[\s\S]*grid-template-rows:\s*auto auto auto auto/);
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
