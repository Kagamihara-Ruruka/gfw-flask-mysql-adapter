import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadLayerActivationController({ schemaError = null } = {}) {
  const calls = {
    clear: 0,
    close: 0,
    dates: [],
    dispatch: [],
    menu: 0,
    reload: 0,
    schema: 0,
    schemaSnapshots: [],
    select: 0,
    stop: 0,
    reloadSnapshots: [],
    viewport: [],
    virtualGrid: [],
  };
  const menu = { open: true };
  const state = {
    datasets: {
      grid_dataset: { layer_id: "grid" },
    },
    datasetId: null,
    dataLayer: null,
    enabledLayerIds: [],
    importedLayers: { grid: true, eez: true },
    overlayLayers: { eez: false },
    schema: null,
    availableDates: [],
  };
  const context = {
    console,
    state,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    isImportedLayer: (layerId) => Boolean(state.importedLayers[layerId]),
    isPrimaryDataLayer: (layerId) => layerId === "grid",
    isSampledGridLayer: (layerId) => layerId === "grid",
    stopPlayback: () => { calls.stop += 1; },
    clearPrimaryLayerRecords: () => { calls.clear += 1; },
    loadSchema: async () => {
      calls.schema += 1;
      calls.schemaSnapshots.push({
        dataLayer: state.dataLayer,
        datasetId: state.datasetId,
        enabledLayerIds: [...state.enabledLayerIds],
      });
      if (schemaError) throw schemaError;
      state.schema = { dates: ["2020-01-01"] };
      state.availableDates = ["2020-01-01"];
    },
    reloadActiveLayer: async () => {
      calls.reload += 1;
      calls.reloadSnapshots.push({
        dataLayer: state.dataLayer,
        datasetId: state.datasetId,
        enabledLayerIds: [...state.enabledLayerIds],
        schema: state.schema,
        availableDates: [...state.availableDates],
      });
    },
    setAvailableDates: (dates) => {
      calls.dates = [...dates];
      state.availableDates = [...dates];
    },
    renderDatasetSelect: () => { calls.select += 1; },
    updateDataLayerMenu: () => { calls.menu += 1; },
    $: () => menu,
    LayerViewportController: {
      syncForDataset: (datasetId, options) => calls.viewport.push({ datasetId, options }),
    },
    VirtualGridController: {
      refresh: (reason) => calls.virtualGrid.push(reason),
    },
    dispatchEvent: (event) => calls.dispatch.push(event),
  };
  context.AppRuntime = {
    install(name, factory) {
      const instance = factory();
      context[name] = instance;
      return instance;
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(
      path.join(root, "static/js/ui/layers/layer-activation-controller.js"),
      "utf8",
    ),
    context,
  );
  return { calls, controller: context.LayerActivationController, menu, state };
}

test("registered datasets remain dormant while the dashboard has no enabled layer", async () => {
  const { calls, controller, state } = loadLayerActivationController();

  await controller.reconcile({ reload: true, reason: "bootstrap" });

  assert.equal(state.dataLayer, null);
  assert.equal(state.datasetId, null);
  assert.equal(state.schema, null);
  assert.deepEqual(plain(state.enabledLayerIds), []);
  assert.equal(state.importedLayers.grid, true);
  assert.equal(state.overlayLayers.eez, false);
  assert.equal(calls.schema, 0);
  assert.equal(calls.reload, 0);
  assert.deepEqual(plain(calls.viewport.at(-1)), {
    datasetId: null,
    options: { focus: false },
  });
});

test("the data-layer drawer owns the complete activation and deactivation sequence", async () => {
  const { calls, controller, menu, state } = loadLayerActivationController();

  await controller.toggle("grid");
  assert.equal(state.dataLayer, "grid");
  assert.equal(state.datasetId, "grid_dataset");
  assert.deepEqual(plain(state.enabledLayerIds), ["grid"]);
  assert.equal(calls.schema, 1);
  assert.equal(calls.reload, 1);
  assert.deepEqual(plain(calls.schemaSnapshots[0]), {
    dataLayer: null,
    datasetId: "grid_dataset",
    enabledLayerIds: [],
  });
  assert.deepEqual(plain(calls.reloadSnapshots[0]), {
    dataLayer: "grid",
    datasetId: "grid_dataset",
    enabledLayerIds: ["grid"],
    schema: { dates: ["2020-01-01"] },
    availableDates: ["2020-01-01"],
  });
  assert.deepEqual(plain(calls.viewport.at(-1)), {
    datasetId: "grid_dataset",
    options: { focus: true },
  });
  assert.equal(menu.open, false);

  menu.open = true;
  await controller.toggle("grid");
  assert.equal(state.dataLayer, null);
  assert.equal(state.datasetId, null);
  assert.equal(state.schema, null);
  assert.deepEqual(plain(state.enabledLayerIds), []);
  assert.deepEqual(plain(calls.viewport.at(-1)), {
    datasetId: null,
    options: { focus: false },
  });
  assert.equal(menu.open, false);
});

test("a schema failure never publishes a half-activated layer", async () => {
  const { calls, controller, state } = loadLayerActivationController({
    schemaError: new Error("schema unavailable"),
  });

  await assert.rejects(controller.toggle("grid"), /schema unavailable/);

  assert.equal(state.dataLayer, null);
  assert.equal(state.datasetId, null);
  assert.equal(state.schema, null);
  assert.deepEqual(plain(state.enabledLayerIds), []);
  assert.deepEqual(plain(state.availableDates), []);
  assert.equal(calls.reload, 0);
  assert.equal(calls.dispatch.at(-1)?.detail?.reason, "activation_failed");
});

test("rapid drawer commands are serialized instead of racing state mutations", async () => {
  const { controller, state } = loadLayerActivationController();

  await Promise.all([
    controller.toggle("grid"),
    controller.toggle("grid"),
  ]);

  assert.equal(state.dataLayer, null);
  assert.equal(state.datasetId, null);
  assert.deepEqual(plain(state.enabledLayerIds), []);
});

test("disposed activation controllers reject new transitions", async () => {
  const { controller } = loadLayerActivationController();
  controller.dispose();
  await assert.rejects(controller.toggle("grid"), /is disposed/);
});

test("dashboard bootstrap keeps the developer control plane lazy", () => {
  const template = fs.readFileSync(path.join(root, "templates/index.html"), "utf8");
  const aisSettings = fs.readFileSync(path.join(root, "static/js/ui/layers/ais-settings.js"), "utf8");
  const iframe = template.match(/<iframe[\s\S]*?id="developer-control-frame"[\s\S]*?<\/iframe>/)?.[0] || "";
  assert.match(template, /id="data-layer-summary">沒有圖層</);
  assert.match(iframe, /data-src="\{\{ developer_url \}\}\/\?embedded=1"/);
  assert.doesNotMatch(iframe, /\ssrc=/);
  assert.match(template, /layer-activation-controller\.js/);
  assert.doesNotMatch(aisSettings, /function bindAisSettingsControls\(\)\s*\{[\s\S]*?loadAisSettings\(\)/);
});

test("hidden dashboard resize cannot publish a zero-sized map viewport", () => {
  const source = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
  const start = source.indexOf("function syncMapContainerSize");
  const end = source.indexOf("function bindMapContainerResize", start);
  const body = source.slice(start, end);

  assert.match(body, /rect\.width <= 0 \|\| rect\.height <= 0/);
  assert.match(body, /\{ force = false \}/);
  assert.match(source, /syncMapContainerSize\([^\n]+\{ force: true \}\)/);
});
