import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadContract(dataset) {
  const context = {
    console,
    state: {
      datasetId: "mapped-source",
      datasets: { "mapped-source": dataset },
      sampledGridMeta: null,
      sampledGridMetaByDataset: {},
      sampledGridResolutionByDataset: {},
      sampledGridQueryResolutionByDataset: {},
    },
    map: {
      getZoom: () => 6,
      getCenter: () => ({ lat: 21, lng: 121 }),
    },
    normalizeLongitude(value) {
      return ((((Number(value) + 180) % 360) + 360) % 360) - 180;
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent() {},
  };
  context.window = context;
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(root, "static/js/rendering/sampled-grid-contract.js"),
    "utf8",
  );
  vm.runInContext(source, context);
  return {
    context,
    contract: vm.runInContext("SampledGridContract", context),
  };
}

function loadColorScale(dataset) {
  const loaded = loadContract(dataset);
  Object.assign(loaded.context.state, {
    dataLayer: dataset.layer_id,
    sampledGridPaint: {
      scaleMode: "contract",
      colorStops: [
        { position: 0, color: "#163b4a" },
        { position: 0.25, color: "#2d8296" },
        { position: 0.5, color: "#4dbb9b" },
        { position: 0.75, color: "#e2bd52" },
        { position: 1, color: "#d85a30" },
      ],
      maxValue: null,
    },
    sampledGridPaintProfiles: {},
  });
  const source = fs.readFileSync(
    path.join(root, "static/js/rendering/gfw-paint.js"),
    "utf8",
  );
  vm.runInContext(source, loaded.context);
  return {
    ...loaded,
    colorScale: vm.runInContext("SampledGridColorScale", loaded.context),
    rowsForRender: vm.runInContext("sampledGridRowsForRender", loaded.context),
  };
}

function loadVirtualGridContract({ zoom = 6, enabledLayerIds = ["gfw", "pipeline.fishing"] } = {}) {
  const datasets = {
    gfw_full: {
      layer_id: "gfw",
      sampled_grid: {
        contract_version: "rrkal.sampled_grid.v1",
        available_resolutions_km: [9.276666666666666],
        geometry: {
          encoding: "center",
          cell_width_degrees: 1 / 12,
          cell_height_degrees: 1 / 12,
        },
        alignment: { origin_lat: -90, origin_lon: -180 },
      },
    },
    "pipeline.fishing": {
      layer_id: "pipeline.fishing",
      sampled_grid: {
        contract_version: "rrkal.sampled_grid.v1",
        available_resolutions_km: [4, 16, 32],
        geometry: {
          encoding: "global_index",
          origin_lat: 90,
          origin_lon: -180,
          index_units_per_degree: 24,
        },
        alignment: { origin_lat: 90, origin_lon: -180, index_units_per_degree: 24 },
      },
    },
  };
  const context = {
    console,
    state: {
      datasetId: "gfw_full",
      dataLayer: null,
      enabledLayerIds,
      datasets,
      sampledGridMeta: null,
      sampledGridMetaByDataset: {},
      sampledGridResolutionByDataset: {},
      sampledGridQueryResolutionByDataset: {},
      importedLayers: { gfw: true, "pipeline.fishing": true, eez: true },
      layerContracts: [
        { layer_id: "gfw", label: "GFW", imported: true, capabilities: { sampled_grid: true } },
        { layer_id: "pipeline.fishing", dataset_id: "pipeline.fishing", label: "Fishing", imported: true, capabilities: { sampled_grid: true } },
        { layer_id: "eez", label: "EEZ", imported: true, capabilities: { sampled_grid: false } },
      ],
      virtualGrid: {
        strategy: "least_common_multiple",
        status: "unresolved",
        revision: 0,
        signature: "",
        participants: [],
        geometry: null,
        resolutionKm: null,
      },
    },
    map: {
      getZoom: () => zoom,
      getCenter: () => ({ lat: 21, lng: 121 }),
      on() {},
    },
    normalizeLongitude(value) {
      return ((((Number(value) + 180) % 360) + 360) % 360) - 180;
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    addEventListener() {},
    dispatchEvent() {},
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["sampled-grid-contract.js", "virtual-grid-contract.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "static/js/rendering", file), "utf8"), context);
  }
  context.VirtualGridController = new context.VirtualGridRuntimeController({
    targetState: context.state,
    contract: context.VirtualGridContract,
    eventTarget: context,
    targetMap: context.map,
  });
  context.VirtualGridController.bind();
  return context;
}

function loadWidgetQueryContext(packetRows) {
  const context = {
    console,
    URLSearchParams,
    state: {
      datasets: {},
      layerContracts: [],
      importedLayers: {},
      tileSelection: { selected: null, items: [] },
    },
    map: {
      getZoom: () => 6,
      getCenter: () => ({ lat: 21, lng: 121 }),
    },
    document: {
      getElementById: () => ({ value: "2024-01-01" }),
    },
    WidgetCore: { lineChartEscape: (value) => String(value) },
    LayerRuntimeContractRegistry: { sampledGridLayers: () => [] },
    SampledGridContract: {
      queryResolution: () => 4,
      requestResolution: () => 4,
    },
    RenderIntentService: { unlimitedLimit: () => "max" },
    DataFrameStore: {
      inspect() {
        return { status: "ready", packet: { rows: packetRows }, cacheHit: true };
      },
    },
    FrameDemandService: {
      async demand() {
        return { status: "ready", packet: { rows: packetRows }, cacheHit: false };
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/ui/widgets/capabilities/shared.js"), "utf8"),
    context,
  );
  return context.WidgetCapabilityShared.WidgetQueryContext;
}

function loadLayerViewportController(dataset) {
  const mapState = {
    minZoom: 2,
    maxBounds: null,
    center: { lat: 0, lng: 0 },
    zoom: 2,
  };
  const latLngBounds = (southWest, northEast) => {
    const south = Number(southWest[0]);
    const west = Number(southWest[1]);
    const north = Number(northEast[0]);
    const east = Number(northEast[1]);
    return {
      getCenter: () => ({ lat: (south + north) / 2, lng: (west + east) / 2 }),
      contains: (point) => (
        Number(point.lat) >= south && Number(point.lat) <= north
        && Number(point.lng) >= west && Number(point.lng) <= east
      ),
    };
  };
  const context = {
    console,
    state: {
      datasetId: "bounded",
      datasets: { bounded: dataset },
      layerViewport: null,
    },
    map: {
      getMinZoom: () => 2,
      getMaxZoom: () => 18,
      getBoundsZoom: () => 5,
      setMinZoom: (value) => { mapState.minZoom = value; },
      setMaxBounds: (value) => { mapState.maxBounds = value; },
      getCenter: () => mapState.center,
      getZoom: () => mapState.zoom,
      setView: (center, zoom) => {
        mapState.center = center;
        mapState.zoom = zoom;
      },
      setZoom: (zoom) => { mapState.zoom = zoom; },
      panInsideBounds() {},
    },
    L: { latLngBounds },
    SampledGridContract: {
      model: () => ({ bounds: (row) => row.bounds || null }),
    },
    normalizeLongitude: (value) => Number(value),
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/ui/map/layer-viewport-controller.js"), "utf8"),
    context,
  );
  context.LayerViewportController = new context.DatasetViewportController({
    targetMap: context.map,
    targetState: context.state,
    eventTarget: context.window,
  });
  return { context, mapState };
}

test("sampled-grid defaults to the finest mapped resolution and accepts a per-dataset override", () => {
  const { contract } = loadContract({
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      available_resolutions_km: [4, 16, 32],
      geometry: {
        encoding: "global_index",
        origin_lat: 90,
        origin_lon: -180,
        index_units_per_degree: 24,
        base_resolution_km: 4,
      },
      alignment: {
        origin_lat: 90,
        origin_lon: -180,
        index_units_per_degree: 24,
      },
    },
  });

  assert.equal(contract.requestResolution({ zoom: 3, latitude: 21 }), 4);
  assert.equal(contract.requestResolution({ zoom: 6, latitude: 21 }), 4);
  assert.equal(contract.setRequestedResolution("mapped-source", 16), 16);
  assert.equal(contract.requestResolution({ datasetId: "mapped-source" }), 16);
  const cell = contract.model().cellAt(21.99, 120.01, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(cell.bounds)), {
    west: 120,
    south: 21.958333333333332,
    east: 120.04166666666667,
    north: 22,
  });
});

test("sampled-grid reuses a resolved source fallback without changing the configured resolution", () => {
  const { contract } = loadContract({
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      available_resolutions_km: [4, 16, 32],
      geometry: {
        encoding: "global_index",
        origin_lat: 90,
        origin_lon: -180,
        index_units_per_degree: 24,
        base_resolution_km: 4,
      },
    },
  });

  contract.recordResolvedResolution("mapped-source", {
    requested_resolution_km: 4,
    actual_resolution_km: 16,
    lod_degraded: true,
  });
  assert.equal(contract.requestResolution({ datasetId: "mapped-source" }), 4);
  assert.equal(contract.queryResolution({ datasetId: "mapped-source" }), 16);
  assert.deepEqual(
    JSON.parse(JSON.stringify(contract.resolutionState("mapped-source"))),
    {
      datasetId: "mapped-source",
      requestedResolutionKm: 4,
      actualResolutionKm: 16,
      effectiveResolutionKm: 16,
      queryResolutionKm: 16,
      degraded: true,
      resolved: true,
    },
  );

  contract.recordResolvedResolution("mapped-source", {
    requested_resolution_km: 16,
    actual_resolution_km: 16,
    lod_degraded: false,
  });
  assert.equal(contract.queryResolution({ datasetId: "mapped-source" }), 16);

  contract.setRequestedResolution("mapped-source", 32);
  assert.equal(contract.requestResolution({ datasetId: "mapped-source" }), 32);
  assert.equal(contract.queryResolution({ datasetId: "mapped-source" }), 32);
});

test("zero remains data and center-grid alignment is mapping-owned", () => {
  const { contract } = loadContract({
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      available_resolutions_km: [9.276666666666666],
      geometry: {
        encoding: "center",
        cell_width_degrees: 1 / 12,
        cell_height_degrees: 1 / 12,
      },
      alignment: { origin_lat: -90, origin_lon: -180 },
      zero_is_data: true,
    },
  });

  const model = contract.model();
  assert.equal(model.value({ value: 0 }), 0);
  assert.equal(model.value({ value: null }), null);
  assert.equal(model.value({ value: "" }), null);
  assert.equal(model.value({}), null);
  assert.equal(model.valueDomain.min, null);
  assert.equal(model.valueDomain.max, null);
  assert.equal(model.bounds({ bounds: { west: null, south: 0, east: 1, north: 1 } }), null);
  const cell = model.cellAt(21.375, 121.95833333333333);
  assert.ok(Math.abs(cell.bounds.west - 121.91666666666669) < 1e-10);
  assert.ok(Math.abs(cell.bounds.north - 21.41666666666667) < 1e-10);
});

test("virtual grid resolves an exact common cell from enabled mapping contracts", () => {
  const context = loadVirtualGridContract({ zoom: 6 });
  const snapshot = context.VirtualGridController.refresh("test");
  assert.equal(snapshot.status, "common");
  assert.equal(snapshot.participants.length, 2);
  assert.equal(snapshot.geometry.cell_width_degrees, 1 / 12);
  assert.equal(snapshot.geometry.cell_height_degrees, 1 / 12);
  assert.deepEqual(snapshot.participants.map((item) => item.layer_id), ["gfw", "pipeline.fishing"]);

  const cell = context.VirtualGridContract.cellAt(21.01, 120.01, snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(cell.bounds)), {
    west: 120,
    south: 21,
    east: 120.083333333333,
    north: 21.083333333333,
  });
  assert.equal(cell.grid_contract.participants.length, 2);
});

test("virtual grid keeps the finest configured resolution independent of map zoom", () => {
  const context = loadVirtualGridContract({ zoom: 3 });
  const snapshot = context.VirtualGridController.refresh("test");
  assert.equal(snapshot.status, "common");
  assert.equal(snapshot.geometry.cell_width_degrees, 1 / 12);
  assert.equal(snapshot.participants.find((item) => item.layer_id === "pipeline.fishing").requested_resolution_km, 4);
});

test("virtual grid follows the per-dataset actual resolution after a source fallback", () => {
  const context = loadVirtualGridContract({
    zoom: 6,
    enabledLayerIds: ["pipeline.fishing"],
  });
  context.SampledGridContract.recordResolvedResolution("pipeline.fishing", {
    requested_resolution_km: 4,
    actual_resolution_km: 16,
    lod_degraded: true,
  });
  const snapshot = context.VirtualGridController.refresh("test-fallback");
  assert.equal(snapshot.status, "single");
  assert.equal(snapshot.geometry.cell_width_degrees, 1 / 6);
  assert.equal(snapshot.resolutionKm, 16);
  assert.equal(snapshot.participants[0].requested_resolution_km, 4);
  assert.equal(snapshot.participants[0].actual_resolution_km, 16);
  assert.equal(snapshot.participants[0].effective_resolution_km, 16);
  assert.equal(snapshot.participants[0].lod_degraded, true);
});

test("virtual grid exists only when at least one sampled-grid layer is imported", () => {
  const empty = loadVirtualGridContract({ zoom: 6 });
  empty.state.layerContracts.forEach((contract) => { contract.imported = false; });
  empty.state.importedLayers = { gfw: false, "pipeline.fishing": false, eez: true };
  const unavailable = empty.VirtualGridController.refresh("test-empty");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.participants.length, 0);
  assert.equal(unavailable.geometry, null);

  const single = loadVirtualGridContract({ zoom: 6 });
  single.state.layerContracts.find((contract) => contract.layer_id === "pipeline.fishing").imported = false;
  single.state.importedLayers["pipeline.fishing"] = false;
  const ownLod = single.VirtualGridController.refresh("test-single");
  assert.equal(ownLod.status, "single");
  assert.equal(ownLod.participants.length, 1);
  assert.equal(ownLod.participants[0].layer_id, "gfw");
  assert.equal(ownLod.geometry.cell_width_degrees, 1 / 12);
});

test("imported sampled-grid layers remain dormant until the data-layer drawer enables them", () => {
  const none = loadVirtualGridContract({ zoom: 6, enabledLayerIds: [] });
  const unavailable = none.VirtualGridController.refresh("test-disabled");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(none.LayerRuntimeContractRegistry.sampledGridLayers().length, 2);
  assert.equal(none.LayerRuntimeContractRegistry.sampledGridLayers({ enabledOnly: true }).length, 0);

  none.state.enabledLayerIds = ["pipeline.fishing"];
  const enabled = none.VirtualGridController.refresh("test-enabled");
  assert.equal(enabled.status, "single");
  assert.deepEqual(enabled.participants.map((item) => item.layer_id), ["pipeline.fishing"]);
});

test("virtual grid accepts source origins aligned on native cell boundaries", () => {
  const aligned = loadVirtualGridContract({ zoom: 6 });
  aligned.state.datasets["pipeline.fishing"].sampled_grid.geometry.origin_lon = -180 + (1 / 24);
  aligned.state.datasets["pipeline.fishing"].sampled_grid.alignment.origin_lon = -180 + (1 / 24);
  const common = aligned.VirtualGridController.refresh("test-aligned-origin");
  assert.equal(common.status, "common");
  assert.equal(common.geometry.cell_width_degrees, 1 / 12);

  const misaligned = loadVirtualGridContract({ zoom: 6 });
  misaligned.state.datasets["pipeline.fishing"].sampled_grid.geometry.origin_lon = -180 + (1 / 48);
  misaligned.state.datasets["pipeline.fishing"].sampled_grid.alignment.origin_lon = -180 + (1 / 48);
  const unavailable = misaligned.VirtualGridController.refresh("test-misaligned-origin");
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.detail, /原點不相容/);
});

test("non-zero sampled-grid extent expands a narrow distribution across multiple color stops", () => {
  const { colorScale } = loadColorScale({
    layer_id: "pipeline_iceberg.fishing_hours",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: {
        encoding: "center",
        cell_width_degrees: 1,
        cell_height_degrees: 1,
      },
      visualization: {
        color_scale: {
          mode: "nonzero_extent",
          stops: [
            { position: 0, color: "#163b4a" },
            { position: 0.25, color: "#2d8296" },
            { position: 0.5, color: "#4dbb9b" },
            { position: 0.75, color: "#e2bd52" },
            { position: 1, color: "#d85a30" },
          ],
        },
      },
    },
  });
  const profile = colorScale.profile("pipeline_iceberg.fishing_hours");
  assert.equal(profile.maxValue, null);
  const rows = [0, 94.406, 97.203, 100].map((value) => ({
    value,
    bounds: { west: 120, south: 20, east: 121, north: 21 },
  }));
  colorScale.prepare(rows, profile);

  const domain = colorScale.domain(profile);
  assert.equal(domain.mode, "nonzero_extent");
  assert.equal(domain.min, 94.406);
  assert.equal(domain.max, 100);
  const colors = rows.slice(1).map((row) => Array.from(colorScale.colorParts(row, profile)).join(","));
  assert.equal(new Set(colors).size, 3);
  assert.equal(colors[0], "22,59,74");
  assert.equal(colors[2], "216,90,48");

  colorScale.prepare([{ value: 10 }, { value: 20 }], profile);
  assert.equal(colorScale.domain(profile).min, 10);
  assert.equal(colorScale.domain(profile).max, 20);
});

test("mapping can hide zero-value paint without removing zero from the grid contract", () => {
  const { contract, colorScale, rowsForRender } = loadColorScale({
    layer_id: "mapped-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      zero_is_data: true,
      visualization: {
        color_scale: { mode: "nonzero_extent", zero_opacity: 0 },
      },
    },
  });
  const profile = colorScale.profile("mapped-grid");

  assert.equal(contract.model().value({ value: 0 }), 0);
  assert.equal(colorScale.opacity({ value: 0 }, profile), 0);
  assert.equal(colorScale.opacity({ value: 1 }, profile), 1);
  assert.equal(rowsForRender([{
    value: 0,
    coverage_ratio: 1,
    bounds: { west: 120, south: 20, east: 121, north: 21 },
  }]).length, 0);
});

test("sampled-grid paint excludes no-coverage fill values before computing the color domain", () => {
  const { contract, colorScale, rowsForRender } = loadColorScale({
    layer_id: "coverage-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: {
        color_scale: { mode: "nonzero_extent", zero_opacity: 0 },
      },
    },
  });
  const bounds = { west: 120, south: 20, east: 121, north: 21 };
  const rows = [
    { value: 8.6485, coverage_ratio: 0, data_status: "contains_filled", bounds },
    { value: 11, coverage_ratio: 0.5, data_status: "contains_filled", bounds },
    { value: 12, data_status: "no_data", bounds },
    { value: 13, data_status: "observed", bounds },
  ];

  assert.equal(contract.model().renderable(rows[0]), false);
  assert.equal(contract.model().renderable(rows[1]), true);
  assert.deepEqual(Array.from(rowsForRender(rows), (row) => row.value), [11, 13]);
  assert.equal(colorScale.domain().min, 11);
  assert.equal(colorScale.domain().max, 13);
});

test("sampled-grid paint skips zero by default while preserving an explicit override", () => {
  const defaultScale = loadColorScale({
    layer_id: "default-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
    },
  });
  const visibleZeroScale = loadColorScale({
    layer_id: "visible-zero-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { zero_opacity: 0.4 } },
    },
  });

  assert.equal(defaultScale.colorScale.opacity({ value: 0 }), 0);
  assert.equal(visibleZeroScale.colorScale.opacity({ value: 0 }), 0.4);
  assert.equal(visibleZeroScale.rowsForRender([{
    value: 0,
    coverage_ratio: 1,
    bounds: { west: 120, south: 20, east: 121, north: 21 },
  }]).length, 1);
});

test("sampled-grid WebGL preserves the configured alpha instead of squaring it", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/rendering/gfw-webgl-renderer.js"),
    "utf8",
  );
  assert.match(source, /premultipliedAlpha:\s*true/);
  assert.match(
    source,
    /blendFuncSeparate\(\s*gl\.SRC_ALPHA,\s*gl\.ONE_MINUS_SRC_ALPHA,\s*gl\.ONE,\s*gl\.ONE_MINUS_SRC_ALPHA\s*\)/,
  );
  assert.doesNotMatch(source, /gl\.blendFunc\(gl\.SRC_ALPHA,\s*gl\.ONE_MINUS_SRC_ALPHA\)/);
});

test("sampled-grid settings expose contract-driven multi-stop controls", () => {
  const template = fs.readFileSync(path.join(root, "templates/index.html"), "utf8");
  const settings = fs.readFileSync(path.join(root, "static/js/ui/layers/gfw-settings.js"), "utf8");
  assert.match(template, /id="sampled-grid-resolution"/);
  assert.match(template, /id="sampled-grid-scale-mode"/);
  assert.match(template, /id="sampled-grid-color-stops"/);
  assert.match(settings, /availableResolutionsKm/);
  assert.match(settings, /setRequestedResolution/);
  assert.doesNotMatch(settings, /\[\s*4\s*,\s*16\s*,\s*32\s*\]/);
  assert.doesNotMatch(template, /id="gfw-(?:low|high)-color"/);
});

test("non-zero extent includes negative values instead of silently meaning positive-only", () => {
  const { colorScale } = loadColorScale({
    layer_id: "signed-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { mode: "nonzero_extent" } },
    },
  });
  const profile = colorScale.profile("signed-grid");
  colorScale.prepare([{ value: -4 }, { value: 0 }, { value: 2 }], profile);
  assert.deepEqual(
    { min: colorScale.domain(profile).min, max: colorScale.domain(profile).max },
    { min: -4, max: 2 },
  );
});

test("primary sampled-grid pipeline does not read source dataset columns", () => {
  const files = [
    "static/js/services/api-client.js",
    "static/js/services/frame-identity.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/frame-demand-service.js",
    "static/js/rendering/gfw-paint.js",
    "static/js/layers/gfw-layer.js",
    "static/js/rendering/gfw-webgl-renderer.js",
    "static/js/ui/map/tile-selection-layer.js",
  ];
  const forbidden = ["fish_sum", "obs_date", "grid_id", "GFW_MIN_RENDER_CELL_KM", "gfwRenderCellKm"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} still contains ${token}`);
    }
  }
});

test("bounded sampled-grid layers constrain viewport, queries, and rendered rows from Mapping coverage", () => {
  const dataset = {
    sampled_grid: {
      coverage_areas: [
        { id: "small", bounds: { west: 118, south: 20, east: 124, north: 27 } },
        { id: "large", bounds: { west: 105, south: 15, east: 135, north: 35 } },
      ],
    },
  };
  const { context, mapState } = loadLayerViewportController(dataset);
  const model = context.createDatasetCoverageModel(dataset);
  assert.equal(model.clipBboxString("100,10,140,40"), "105.000000,15.000000,135.000000,35.000000");
  assert.equal(model.clipBboxString("0,0,1,1"), null);

  const viewport = context.LayerViewportController.syncForDataset("bounded", { focus: true });
  assert.equal(viewport.mode, "coverage");
  assert.equal(viewport.minZoom, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(mapState.center)), { lat: 25, lng: 120 });
  assert.equal(mapState.zoom, 5);
  assert.ok(mapState.maxBounds);

  const visible = context.LayerViewportController.filterRows([
    { id: "inside", bounds: { west: 119, south: 23, east: 120, north: 24 } },
    { id: "outside", bounds: { west: 1, south: 1, east: 2, north: 2 } },
  ], "bounded");
  assert.deepEqual(visible.map((row) => row.id), ["inside"]);

  const source = fs.readFileSync(
    path.join(root, "static/js/ui/map/layer-viewport-controller.js"),
    "utf8",
  );
  assert.match(source, /coverage_areas/);
  assert.match(source, /clipBboxString/);
  assert.match(source, /setMaxBounds/);
  assert.match(source, /filterRows/);
  assert.doesNotMatch(source, /coverage_mask|destination-out|sampledGridMaskPane/);
  assert.doesNotMatch(source, /pipeline_iceberg|fishing_hours|northwest_pacific/);

  const template = fs.readFileSync(path.join(root, "templates/index.html"), "utf8");
  assert.match(template, /layer-viewport-controller\.js/);
  assert.doesNotMatch(template, /sampled-grid-coverage-mask\.js/);
  assert.equal(fs.existsSync(path.join(root, "static/js/layers/sampled-grid-coverage-mask.js")), false);
});

test("schema candidates never become mapping roles automatically", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/ui/developer/developer-mapping-controller.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /guessedRole/);
  assert.match(source, /roleForColumn\([\s\S]*?return "ignore";/);
});

test("database config wizard owns connections but not dataset mappings", () => {
  const wizard = fs.readFileSync(
    path.join(root, "static/js/ui/developer/developer-wizard.js"),
    "utf8",
  );
  const template = fs.readFileSync(path.join(root, "templates/developer.html"), "utf8");
  for (const token of ["wizard-time-column", "wizard-id-column", "wizard-metric-columns", "wizard-dataset-id"]) {
    assert.equal(wizard.includes(token), false, `wizard JavaScript still owns ${token}`);
    assert.equal(template.includes(token), false, `wizard markup still owns ${token}`);
  }
  assert.match(wizard, /schema:\s*"rrkal\.adapter\.database\.v1"/);
  assert.doesNotMatch(wizard, /\bdatasets\s*:/);
});

test("sampled-grid widgets consume canonical roles instead of GFW identifiers", () => {
  const files = [
    "static/js/ui/widgets/capabilities/shared.js",
    "static/js/ui/widgets/capabilities/line-chart.js",
    "static/js/ui/widgets/capabilities/pie-chart.js",
    "static/js/ui/widgets/capabilities/horizontal-bar-chart.js",
    "static/js/ui/widgets/capabilities/table.js",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(source.includes("renderedGfwDate"), false, `${file} still reads renderedGfwDate`);
    assert.equal(source.includes('dataLayer !== "gfw"'), false, `${file} still gates on the GFW layer id`);
    assert.equal(source.includes("GFW 顏色格"), false, `${file} still exposes GFW-only widget semantics`);
  }
  const shared = fs.readFileSync(path.join(root, files[0]), "utf8");
  assert.match(shared, /dataset\?\.sampled_grid\) return "value"/);
});

test("widget queries use the virtual cell effective resolution after fallback", () => {
  const queryContext = loadWidgetQueryContext([]);
  const resolution = queryContext.resolutionFor(
    { datasetId: "pipeline.fishing", layerId: "pipeline.fishing" },
    {
      selection_grid: {
        participants: [{
          dataset_id: "pipeline.fishing",
          layer_id: "pipeline.fishing",
          requested_resolution_km: 4,
          actual_resolution_km: 16,
          effective_resolution_km: 16,
        }],
      },
    },
  );
  assert.equal(resolution, 16);
});

test("line chart derives its moving window from the canonical snapshot cache", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/ui/widgets/capabilities/line-chart.js"),
    "utf8",
  );
  assert.match(source, /WidgetQueryContext\.resolutionFor/);
  assert.match(source, /DataFrameStore\.inspect/);
  assert.match(source, /FrameDemandService\.demandRange/);
  assert.doesNotMatch(source, /\/time-series\?|\bfetchJson\s*\(|new AbortController\(\)/);
  assert.doesNotMatch(source, /Playback(?:FrameBuffer|Cache|Controller)/);
  assert.match(source, /rawValue === null/);
  assert.doesNotMatch(source, /\?\? 0/);
});

test("daily record updates do not place line charts on the playback lifecycle", () => {
  const runtime = fs.readFileSync(
    path.join(root, "static/js/ui/widgets/runtime/widgets-runtime.js"),
    "utf8",
  );
  const recordsHandler = runtime.match(
    /addEventListener\("rrkal:records-updated",\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*listenerOptions\);/,
  );
  assert.ok(recordsHandler, "records-updated handler must remain explicit");
  assert.doesNotMatch(recordsHandler[1], /LineChart|line-chart/);
});

test("horizontal bars follow semantic date changes without waiting for record rendering", () => {
  const runtime = fs.readFileSync(
    path.join(root, "static/js/ui/widgets/runtime/widgets-runtime.js"),
    "utf8",
  );
  const activeDateHandler = runtime.match(
    /addEventListener\("rrkal:active-date-changed",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*listenerOptions\);/,
  );
  const recordsHandler = runtime.match(
    /addEventListener\("rrkal:records-updated",\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*listenerOptions\);/,
  );
  assert.ok(activeDateHandler, "active date handler must remain explicit");
  assert.match(activeDateHandler[1], /refreshHorizontalBarWidgets/);
  assert.ok(recordsHandler, "records-updated handler must remain explicit");
  assert.doesNotMatch(recordsHandler[1], /HorizontalBar|horizontal-bar/);
});

test("line charts follow semantic dates inside a scope-bounded moving window", () => {
  const runtime = fs.readFileSync(
    path.join(root, "static/js/ui/widgets/runtime/widgets-runtime.js"),
    "utf8",
  );
  const lineChart = fs.readFileSync(
    path.join(root, "static/js/ui/widgets/capabilities/line-chart.js"),
    "utf8",
  );
  const activeDateHandler = runtime.match(
    /addEventListener\("rrkal:active-date-changed",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*listenerOptions\);/,
  );
  assert.ok(activeDateHandler, "active date handler must remain explicit");
  assert.match(activeDateHandler[1], /renderLineChartWidgets/);
  assert.doesNotMatch(activeDateHandler[1], /refreshLineChartWidgets/);
  assert.match(activeDateHandler[1], /ensureCurrentWindow/);
  assert.match(lineChart, /WidgetQueryContext\.currentDate\(selected\)/);
  assert.match(lineChart, /scopeDates\(selected/);
  const modelBody = lineChart.slice(lineChart.indexOf("  model() {"), lineChart.indexOf("  ensureCurrentWindow() {"));
  const ensureBody = lineChart.slice(lineChart.indexOf("  ensureCurrentWindow() {"), lineChart.indexOf("  packetRequest("));
  assert.doesNotMatch(modelBody, /this\.fill\(/);
  assert.match(ensureBody, /this\.fill\(request\)/);
  assert.match(lineChart, /const windowSize = Math\.min\(scope\.length, \(this\.windowDays \* 2\) \+ 1\)/);
  assert.match(lineChart, /scope\.length - windowSize/);
  assert.match(lineChart, /dateX\(model, model\.anchorDate\)/);
  assert.match(lineChart, /anchorDate:\s*request\.anchorDate/);
  assert.match(lineChart, /x0:\s*model\.anchorDate/);
  assert.match(lineChart, /x1:\s*model\.anchorDate/);
  assert.match(lineChart, /range:\s*model\.xRange/);
  assert.match(lineChart, /當下切片/);
});

test("cache commit rendering cannot recursively schedule line-chart fills", () => {
  const runtime = fs.readFileSync(
    path.join(root, "static/js/ui/widgets/runtime/widgets-runtime.js"),
    "utf8",
  );
  const handler = runtime.match(
    /addEventListener\("rrkal:data-frame-store-changed",\s*\(event\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*listenerOptions\);/,
  );
  assert.ok(handler, "cache commit handler must remain explicit");
  assert.match(handler[1], /renderLineChartWidgets/);
  assert.doesNotMatch(handler[1], /ensureCurrentWindow|refreshLineChartWidgets|\.fill\(/);
});

test("pie and horizontal bar widgets query dynamic canonical layer matrices", () => {
  const shared = fs.readFileSync(path.join(root, "static/js/ui/widgets/capabilities/shared.js"), "utf8");
  const pie = fs.readFileSync(path.join(root, "static/js/ui/widgets/capabilities/pie-chart.js"), "utf8");
  const horizontal = fs.readFileSync(path.join(root, "static/js/ui/widgets/capabilities/horizontal-bar-chart.js"), "utf8");
  assert.match(shared, /LayerRuntimeContractRegistry\?\.sampledGridLayers\?\.\(\{ enabledOnly: true \}\)/);
  assert.match(shared, /columns:\s*"render"/);
  assert.match(shared, /row\?\.value/);
  assert.match(pie, /WidgetQueryContext\.sampledGridLayers/);
  assert.match(horizontal, /WidgetQueryContext\.selections/);
  assert.match(horizontal, /time_binding/);
  assert.doesNotMatch(horizontal, /\["Y1",\s*"Y2"/);
  assert.doesNotMatch(horizontal, /fish_sum|obs_date|grid_id/);
});

test("widget aggregation keeps canonical null distinct from zero", async () => {
  const selection = {
    bbox: [120, 20, 121, 21],
    center: { lat: 20.5, lon: 120.5 },
  };
  const layer = { datasetId: "mapped-grid", layerId: "mapped-grid", label: "Mapped grid" };
  const mixed = loadWidgetQueryContext([
    { value: null },
    { value: "" },
    { value: 0 },
    { value: "2.5" },
  ]);
  const observed = await mixed.fetchValue(layer, selection);
  assert.equal(observed.status, "observed");
  assert.equal(observed.value, 2.5);

  const missing = loadWidgetQueryContext([{ value: null }, { value: "" }]);
  const absent = await missing.fetchValue(layer, selection);
  assert.equal(absent.status, "missing");
  assert.equal(absent.value, null);

  const horizontalContext = {
    console,
    WidgetCore: { ChartWidget: class ChartWidget {} },
    WidgetCapabilityShared: {
      lineChartEscape: (value) => String(value),
      WidgetQueryContext: {},
      SampledGridWidgetLayerFilter: class SampledGridWidgetLayerFilter {},
    },
    WidgetCapabilities: {},
  };
  horizontalContext.window = horizontalContext;
  vm.createContext(horizontalContext);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/ui/widgets/capabilities/horizontal-bar-chart.js"), "utf8"),
    horizontalContext,
  );
  const HorizontalDataSource = horizontalContext.WidgetCapabilities.HorizontalBarChartDataSource;
  const horizontal = new HorizontalDataSource();
  assert.equal(horizontal.comparableValue({ status: "missing", value: null }), null);
  assert.equal(horizontal.comparableValue({ status: "unavailable", value: 9 }), null);
  assert.equal(horizontal.comparableValue({ status: "zero", value: 0 }), 0);
});

test("selection breathing uses a dedicated SVG renderer under a canvas-first map", () => {
  const selection = fs.readFileSync(
    path.join(root, "static/js/ui/map/tile-selection-layer.js"),
    "utf8",
  );
  const styles = fs.readFileSync(path.join(root, "static/styles.css"), "utf8");
  assert.match(selection, /selectionRenderer\s*=\s*L\.svg/);
  assert.match(selection, /renderer:\s*this\.selectionRenderer/);
  assert.match(selection, /className:\s*"tile-selection-rectangle"/);
  assert.match(selection, /performance\.now\(\)\s*%\s*TILE_SELECTION_BREATHE_PERIOD_MS/);
  assert.match(selection, /class VirtualGridCursorPolicy/);
  assert.match(selection, /cellForEvent\?\.\(selectionEvent,\s*\{ refreshGrid: false \}\)/);
  assert.match(selection, /addEventListener\("pointerenter",\s*this\.boundPointerEnter,\s*true\)/);
  assert.match(selection, /boundPointerLeave\s*=\s*\(\)\s*=>\s*this\.clear\(\{ forceRefresh: true \}\)/);
  assert.match(selection, /classList\.toggle\("is-virtual-grid-clickable",\s*next\)/);
  assert.match(selection, /invalidateSize\?\.\(\{ animate: false, pan: false, debounceMoveend: true \}\)/);
  assert.match(selection, /document\.body\?\.classList\.toggle\("is-tile-selection-mode-active",\s*next\)/);
  assert.match(styles, /body\.is-tile-selection-mode-active \*\s*\{\s*cursor:\s*default !important/);
  assert.match(styles, /#map\.is-tile-selection-enabled\.is-virtual-grid-clickable[\s\S]*?cursor:\s*crosshair !important/);
  assert.match(styles, /\.tile-selection-rectangle\s*\{[\s\S]*?animation:\s*tile-selection-breathe/);
});

test("developer control plane and dashboard share one layer-contract registry", () => {
  const developerRoutes = fs.readFileSync(
    path.join(root, "common_adapter/http/routes/developer.py"),
    "utf8",
  );
  const datasetRoutes = fs.readFileSync(
    path.join(root, "common_adapter/http/routes/datasets.py"),
    "utf8",
  );

  assert.match(
    developerRoutes,
    /def route_provided_layer_rows[\s\S]*?return active_layer_contract_rows\(runtime_config\)/,
  );
  assert.match(
    developerRoutes,
    /def developer_layer_contracts[\s\S]*?active_layer_contract_rows\(runtime_config\)/,
  );
  assert.match(datasetRoutes, /layer_rows = active_layer_contract_rows\(/);
  assert.match(datasetRoutes, /"layers": layer_rows/);
  assert.match(datasetRoutes, /if row\.get\("imported"\)/);
  assert.doesNotMatch(developerRoutes, /build_layer_contracts\(/);
});

test("AIS density rendering owns its LOD grid instead of borrowing GFW geometry", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/layers/ais-layer.js"),
    "utf8",
  );
  assert.match(source, /DEFAULT_AIS_DENSITY_CELLS_PER_TILE/);
  assert.match(source, /state\.aisSettings\?\.rendering\?\.density_cells_per_tile/);
  assert.match(source, /latLngToContainerPoint/);
  assert.doesNotMatch(source, /gfwCellCenter|GFW_CELL_HALF_DEGREES/);
});

test("EEZ resize keeps persistent vector grids and initial tiles paint progressively", () => {
  const app = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
  const eez = fs.readFileSync(path.join(root, "static/js/layers/eez-layer.js"), "utf8");
  const resizeHandler = app.match(/function scheduleEezResizeReload[\s\S]*?\n}/)?.[0] || "";
  assert.match(resizeHandler, /refreshEezTileReadiness\(reason\)/);
  assert.doesNotMatch(resizeHandler, /reloadEezLayer\(\{ force: true \}\)/);

  const vectorReload = eez.match(/if \(canUseEezVectorTiles\(\)\) \{[\s\S]*?\n  }/)?.[0] || "";
  const paneVisible = vectorReload.indexOf("setEezPaneVisibility(state.eezActivePane, true)");
  const tileWait = vectorReload.indexOf("await TimingMetrics.waitForLayers");
  assert.ok(paneVisible >= 0, "EEZ vector pane must become visible");
  assert.ok(tileWait > paneVisible, "EEZ first paint must not wait for every tile to settle");
});
