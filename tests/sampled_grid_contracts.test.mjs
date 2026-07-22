import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function canonicalTransport(rows = []) {
  const values = Array.isArray(rows) ? rows : [];
  const fields = [];
  for (const row of values) {
    for (const field of Object.keys(row || {})) {
      if (field !== "bounds" && !fields.includes(field)) fields.push(field);
    }
    if (row?.bounds) {
      for (const direction of ["west", "south", "east", "north"]) {
        const field = `bounds.${direction}`;
        if (!fields.includes(field)) fields.push(field);
      }
    }
  }
  return {
    schema: "rrkal.canonical_grid_frame.v1",
    row_fields: fields,
    frame_fields: {},
    columns: fields.map((field) => values.map((row) => (
      field.startsWith("bounds.") ? row?.bounds?.[field.slice(7)] ?? null : row?.[field] ?? null
    ))),
    row_count: values.length,
  };
}

function installCanonicalFrame(context) {
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/core/canonical-grid-frame.js"), "utf8"),
    context,
  );
}

function frameFromRows(context, rows) {
  return new context.CanonicalGridFrame(canonicalTransport(rows));
}

function loadContract(dataset) {
  const context = {
    console,
    state: {
      datasetId: "mapped-source",
      datasets: { "mapped-source": dataset },
      sampledGridMeta: null,
      sampledGridMetaByDataset: {},
      sampledGridResolutionByDataset: {},
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
  installCanonicalFrame(context);
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
    path.join(root, "static/js/rendering/sampled-grid-paint.js"),
    "utf8",
  );
  vm.runInContext(source, loaded.context);
  return {
    ...loaded,
    colorScale: vm.runInContext("SampledGridColorScale", loaded.context),
    frameFromRows: (rows) => frameFromRows(loaded.context, rows),
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

test("resolution labels preserve numeric truth without exposing raw floating-point tails", () => {
  const context = {
    document: { getElementById: () => null },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "static/js/core/dom.js"), "utf8"), context);

  assert.equal(vm.runInContext("formatResolutionKm(4)", context), "4 km");
  assert.equal(vm.runInContext("formatResolutionKm(9.276666666666666)", context), "9.28 km");
  assert.equal(vm.runInContext("formatResolutionKm(null)", context), "-");
});

function loadWidgetQueryContext(packetRows) {
  const context = {
    console,
    URLSearchParams,
    appState: {
      datasets: {},
      layerContracts: [],
      importedLayers: {},
      tileSelection: { selected: null, items: [] },
    },
  };
  context.window = context;
  vm.createContext(context);
  installCanonicalFrame(context);
  for (const file of ["widget-model-functions.js", "widget-query-context.js"]) {
    vm.runInContext(
      fs.readFileSync(path.join(root, "static/js/application/widgets", file), "utf8"),
      context,
    );
  }
  return new context.WidgetQueryContext({
    stateProvider: () => context.appState,
    layerRegistryProvider: () => ({ sampledGridLayers: () => [] }),
    tileSelectionProvider: () => [],
    selectedDateProvider: () => "2024-01-01",
    mapSnapshotProvider: () => ({ zoom: 6, latitude: 21 }),
    sampledGridContract: {
      queryResolution: () => 4,
      requestResolution: () => 4,
    },
    renderIntentService: { unlimitedLimit: () => "max" },
    dataFrameStore: {
      inspect() {
        return {
          status: "ready",
          packet: { frame: frameFromRows(context, packetRows) },
          cacheHit: true,
        };
      },
    },
    frameDemandService: {
      async demand() {
        return {
          status: "ready",
          packet: { frame: frameFromRows(context, packetRows) },
          cacheHit: false,
        };
      },
    },
  });
}

function loadLayerViewportController(dataset, { boundsZoom = () => 5 } = {}) {
  const mapState = {
    invalidations: 0,
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
      bounds: { west, south, east, north },
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
      getBoundsZoom: (bounds, inside) => boundsZoom(bounds, inside),
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
      invalidateSize: () => { mapState.invalidations += 1; },
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
  installCanonicalFrame(context);
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

test("sampled-grid records actual resolution without feeding it back into query policy", () => {
  const { contract } = loadContract({
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      available_resolutions_km: [4, 16, 32],
      default_coverage_id: "taiwan",
      coverage_areas: [
        { id: "taiwan", bounds: { west: 118, south: 20, east: 124, north: 27 } },
        { id: "northwest_pacific", bounds: { west: 105, south: 15, east: 135, north: 35 } },
      ],
      geometry: {
        encoding: "global_index",
        origin_lat: 90,
        origin_lon: -180,
        index_units_per_degree: 24,
        base_resolution_km: 4,
      },
    },
  });
  const taiwanBbox = "118,20,124,27";
  const northwestPacificBbox = "125,15,135,25";

  contract.recordResolvedResolution("mapped-source", {
    requested_resolution_km: 4,
    actual_resolution_km: 16,
    lod_degraded: true,
    coverage_id: "northwest_pacific",
  }, { bbox: northwestPacificBbox });
  assert.equal(contract.requestResolution({ datasetId: "mapped-source" }), 4);
  assert.equal(contract.queryResolution({
    datasetId: "mapped-source",
    bbox: northwestPacificBbox,
  }), 4);
  assert.equal(contract.queryResolution({ datasetId: "mapped-source", bbox: taiwanBbox }), 4);
  assert.deepEqual(
    JSON.parse(JSON.stringify(contract.resolutionState("mapped-source"))),
    {
      datasetId: "mapped-source",
      requestedResolutionKm: 4,
      actualResolutionKm: 16,
      selectionResolutionKm: 4,
      queryResolutionKm: 4,
      degraded: true,
      resolved: true,
    },
  );

  contract.recordResolvedResolution("mapped-source", {
    requested_resolution_km: 16,
    actual_resolution_km: 16,
    lod_degraded: false,
    coverage_id: "northwest_pacific",
  }, { bbox: northwestPacificBbox });
  assert.equal(contract.queryResolution({
    datasetId: "mapped-source",
    bbox: northwestPacificBbox,
  }), 4);
  assert.equal(contract.queryResolution({ datasetId: "mapped-source", bbox: taiwanBbox }), 4);

  contract.setRequestedResolution("mapped-source", 32);
  assert.equal(contract.requestResolution({ datasetId: "mapped-source" }), 32);
  assert.equal(contract.queryResolution({
    datasetId: "mapped-source",
    bbox: northwestPacificBbox,
  }), 32);
});

test("sampled-grid uses mapping default resolution before falling back to finest grid", () => {
  const { contract } = loadContract({
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      available_resolutions_km: [4, 16, 32],
      default_resolution_km: 16,
      geometry: {
        encoding: "global_index",
        origin_lat: 90,
        origin_lon: -180,
        index_units_per_degree: 24,
        base_resolution_km: 4,
      },
    },
  });

  assert.equal(contract.requestResolution({ datasetId: "mapped-source" }), 16);
  assert.equal(contract.queryResolution({ datasetId: "mapped-source" }), 16);

  contract.setRequestedResolution("mapped-source", 4);
  assert.equal(contract.requestResolution({ datasetId: "mapped-source" }), 4);
  assert.equal(contract.queryResolution({ datasetId: "mapped-source" }), 4);
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
  assert.ok(Math.abs(snapshot.geometry.cell_width_degrees - (1 / 12)) < 1e-12);
  assert.ok(Math.abs(snapshot.geometry.cell_height_degrees - (1 / 12)) < 1e-12);
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
  assert.ok(Math.abs(snapshot.geometry.cell_width_degrees - (1 / 12)) < 1e-12);
  assert.equal(snapshot.participants.find((item) => item.layer_id === "pipeline.fishing").requested_resolution_km, 4);
});

test("virtual grid keeps requested query resolution while exposing observed source resolution", () => {
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
  assert.ok(Math.abs(snapshot.geometry.cell_width_degrees - (1 / 24)) < 1e-12);
  assert.equal(snapshot.resolutionKm, 4);
  assert.equal(snapshot.participants[0].requested_resolution_km, 4);
  assert.equal(snapshot.participants[0].actual_resolution_km, 16);
  assert.equal(snapshot.participants[0].selection_resolution_km, 4);
  assert.equal(snapshot.participants[0].query_resolution_km, 4);
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
  assert.ok(Math.abs(ownLod.geometry.cell_width_degrees - (1 / 12)) < 1e-12);
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
  assert.ok(Math.abs(common.geometry.cell_width_degrees - (1 / 12)) < 1e-12);

  const misaligned = loadVirtualGridContract({ zoom: 6 });
  misaligned.state.datasets["pipeline.fishing"].sampled_grid.geometry.origin_lon = -180 + (1 / 48);
  misaligned.state.datasets["pipeline.fishing"].sampled_grid.alignment.origin_lon = -180 + (1 / 48);
  const unavailable = misaligned.VirtualGridController.refresh("test-misaligned-origin");
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.detail, /原點不相容/);
});

test("virtual grid multiplier control reaches its runtime owner and reports effective state", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/ui/settings/virtual-grid-settings.js"),
    "utf8",
  );
  assert.match(source, /virtual-grid-multiplier/);
  assert.match(source, /VirtualGridController\?\.setMultiplier/);

  const context = loadVirtualGridContract({ enabledLayerIds: ["pipeline.fishing"] });
  const snapshot = context.VirtualGridController.setMultiplier(3);
  assert.equal(snapshot.multiplier, 3);
  assert.equal(snapshot.controlMetadata.multiplier.requested_value, 3);
  assert.equal(snapshot.controlMetadata.multiplier.effective_value, 3);
  assert.equal(snapshot.controlMetadata.multiplier.owner, "VirtualGridRuntimeController");
  assert.equal(snapshot.controlMetadata.multiplier.requires_restart, false);
});

test("non-zero sampled-grid extent expands a narrow distribution across multiple color stops", () => {
  const { colorScale, frameFromRows: makeFrame } = loadColorScale({
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
  colorScale.frame(makeFrame(rows), profile);

  const domain = colorScale.domain(profile);
  assert.equal(domain.mode, "nonzero_extent");
  assert.equal(domain.min, 94.406);
  assert.equal(domain.max, 100);
  const colors = rows.slice(1).map((row) => Array.from(colorScale.colorParts(row, profile)).join(","));
  assert.equal(new Set(colors).size, 3);
  assert.equal(colors[0], "22,59,74");
  assert.equal(colors[2], "216,90,48");

  colorScale.frame(makeFrame([
    { value: 10, bounds: { west: 120, south: 20, east: 121, north: 21 } },
    { value: 20, bounds: { west: 121, south: 20, east: 122, north: 21 } },
  ]), profile);
  assert.equal(colorScale.domain(profile).min, 10);
  assert.equal(colorScale.domain(profile).max, 20);
});

test("mapping can hide zero-value paint without removing zero from the grid contract", () => {
  const { contract, colorScale, frameFromRows: makeFrame } = loadColorScale({
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
  const paintPlan = colorScale.frame(makeFrame([{
    value: 0,
    coverage_ratio: 1,
    bounds: { west: 120, south: 20, east: 121, north: 21 },
  }]));
  assert.equal(paintPlan.indices.length, 0);
  assert.equal(paintPlan.validIndices.length, 1);
});

test("invalid persisted display limit cannot collapse a contract color domain", () => {
  const dataset = {
    layer_id: "pipeline_iceberg.chlor_a",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      value_domain: { min: 0, max: 100 },
      geometry: {
        encoding: "center",
        cell_width_degrees: 1,
        cell_height_degrees: 1,
      },
      visualization: {
        color_scale: {
          mode: "contract",
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
  };
  const { context, colorScale, frameFromRows: makeFrame } = loadColorScale(dataset);
  context.state.sampledGridPaintProfiles[dataset.layer_id] = {
    layerId: dataset.layer_id,
    datasetId: "mapped-source",
    mode: "contract",
    spatialInterpolation: "linear",
    colorStops: dataset.sampled_grid.visualization.color_scale.stops,
    maxValue: 0,
  };

  const profile = colorScale.profile(dataset.layer_id, "mapped-source");
  const paintFrame = colorScale.frame(makeFrame([
    { value: 6.071487475368852, data_status: "filled", bounds: { west: 120, south: 20, east: 121, north: 21 } },
    { value: 100, data_status: "observed", bounds: { west: 121, south: 20, east: 122, north: 21 } },
  ]), profile);

  assert.equal(profile.maxValue, null);
  assert.equal(paintFrame.domain.min, 0);
  assert.equal(paintFrame.domain.max, 100);
  const lowColor = paintFrame.colorPartsForValue(6.071487475368852);
  const highColor = paintFrame.colorPartsForValue(100);
  assert.ok(lowColor[0] < 60, `expected a low-domain color, got ${lowColor.join(",")}`);
  assert.deepEqual(Array.from(highColor), [216, 90, 48]);
});

test("canonical filled status remains renderable regardless of source coverage metadata", () => {
  const { contract, colorScale, frameFromRows: makeFrame } = loadColorScale({
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
    { value: 8.6485, coverage_ratio: 0, data_status: "filled", bounds },
    { value: 11, coverage_ratio: 0.5, data_status: "filled", bounds },
    { value: 12, data_status: "no_data", bounds },
    { value: 13, data_status: "observed", bounds },
  ];

  assert.equal(contract.model().renderable(rows[0]), true);
  assert.equal(contract.model().renderable(rows[1]), true);
  const frame = makeFrame(rows);
  const plan = colorScale.frame(frame);
  assert.deepEqual(Array.from(plan.indices, (index) => frame.valueAt("value", index)), [8.6485, 11, 13]);
  assert.equal(colorScale.domain().min, 8.6485);
  assert.equal(colorScale.domain().max, 13);
});

test("linear sampled-grid paint consumes canonical validity without reinterpreting coverage metadata", () => {
  const loaded = loadColorScale({
    layer_id: "coverage-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: {
        color_scale: { mode: "nonzero_extent", zero_opacity: 1 },
      },
    },
  });
  loaded.context.LayerRuntimeContractRegistry = {
    spatialInterpolation() {
      return { status: "supported", methods: ["nearest", "linear"], default_method: "linear" };
    },
  };
  const profile = loaded.colorScale.profile("coverage-grid");
  profile.spatialInterpolation = "linear";
  const bounds = { west: 120, south: 20, east: 121, north: 21 };
  const rows = [
    { value: 8.6485, coverage_ratio: 0, data_status: "filled", bounds },
    { value: 13, coverage_ratio: 1, data_status: "observed", bounds },
    { value: 99, coverage_ratio: 0, data_status: "observed", bounds },
    { value: 12, coverage_ratio: 1, data_status: "no_data", bounds },
  ];

  assert.equal(loaded.contract.model().renderable(rows[0]), true);
  const frame = loaded.frameFromRows(rows);
  const plan = loaded.colorScale.frame(frame, profile);
  assert.deepEqual(Array.from(plan.validIndices, (index) => frame.valueAt("value", index)), [8.6485, 13, 99]);
  assert.deepEqual(Array.from(plan.indices, (index) => frame.valueAt("value", index)), [8.6485, 13, 99]);
});

test("renderer does not interpret provider-specific sampled-grid status vocabulary", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/rendering/sampled-grid-paint.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /contains_filled|derived_with_fill|zero_filled/);
  assert.doesNotMatch(source, /coverage_ratio/);
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
  assert.equal(visibleZeroScale.colorScale.frame(visibleZeroScale.frameFromRows([{
    value: 0,
    coverage_ratio: 1,
    bounds: { west: 120, south: 20, east: 121, north: 21 },
  }])).indices.length, 1);
});

test("sampled-grid frame plan reuses one compiled paint context per frame", () => {
  const { colorScale, frameFromRows: makeFrame } = loadColorScale({
    layer_id: "planned-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { mode: "nonzero_extent", zero_opacity: 0 } },
    },
  });
  const bounds = { west: 120, south: 20, east: 121, north: 21 };
  const frame = makeFrame([
    { value: 0, coverage_ratio: 1, bounds },
    { value: 10, coverage_ratio: 1, bounds },
    { value: 20, coverage_ratio: 1, bounds },
  ]);
  const plan = colorScale.frame(frame);
  const scratch = [0, 0, 0];

  assert.deepEqual(Array.from(plan.indices, (index) => frame.valueAt("value", index)), [10, 20]);
  assert.deepEqual({ min: plan.domain.min, max: plan.domain.max }, { min: 10, max: 20 });
  assert.equal(plan.opacityForValue(0), 0);
  assert.equal(plan.colorPartsForValue(10, scratch), scratch);
  assert.deepEqual(scratch, [22, 59, 74]);
  plan.colorPartsForValue(20, scratch);
  assert.deepEqual(scratch, [216, 90, 48]);
});

test("sampled-grid RenderContext freezes frame-owned paint and grid identities", () => {
  const loaded = loadColorScale({
    layer_id: "context-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { zero_opacity: 1 } },
    },
  });
  loaded.context.state.layerAlpha = { "context-grid": 0.6 };
  loaded.context.state.renderGridProfile = {
    signature: "grid-a",
    aggregationFactor: 1,
    participants: [{ layerId: "context-grid", resolutionKm: 4 }],
    geometry: { cellWidthDegrees: 1, cellHeightDegrees: 1 },
  };
  const frame = loaded.frameFromRows([{
    value: 10,
    coverage_ratio: 1,
    bounds: { west: 120, south: 20, east: 121, north: 21 },
  }]);
  const createContext = vm.runInContext("createSampledGridRenderContext", loaded.context);
  const frameIdentity = {
    normalizeRequest: (request) => Object.freeze({ ...request, bbox: String(request.bbox || "") }),
    scopeKey: (request) => `scope|${request.datasetId}|${request.bbox}|${request.queryResolution}`,
    frameKey: (request) => `frame|${request.datasetId}|${request.date}|${request.bbox}`,
  };
  const renderContext = createContext(frame, {
    layerId: "context-grid",
    datasetId: "mapped-source",
    requestContext: {
      datasetId: "mapped-source",
      date: "2020-01-01",
      bbox: "120,20,121,21",
      queryResolution: 4,
    },
    frameIdentity,
    renderEpoch: 7,
    validityMask: Object.freeze({
      enabled: true,
      ready: true,
      maskId: "eez",
      maskVersion: "v12:v2",
      revision: 4,
      scopeSignature: "mask-scope-a",
      canvas: Object.freeze({ id: "mask-canvas-a" }),
    }),
  });
  const initialColor = renderContext.paintFrame.colorCssForValue(10);

  loaded.context.state.layerAlpha["context-grid"] = 0.1;
  loaded.context.state.renderGridProfile.signature = "grid-b";
  loaded.colorScale.profile("context-grid").colorStops[0].color = "#ffffff";

  assert.equal(renderContext.alpha, 0.6);
  assert.equal(renderContext.date, "2020-01-01");
  assert.equal(renderContext.bbox, "120,20,121,21");
  assert.equal(renderContext.scopeKey, "scope|mapped-source|120,20,121,21|4");
  assert.equal(renderContext.frameKey, "frame|mapped-source|2020-01-01|120,20,121,21");
  assert.equal(renderContext.renderEpoch, 7);
  assert.equal(renderContext.maskId, "eez");
  assert.equal(renderContext.maskVersion, "v12:v2");
  assert.equal(renderContext.maskRevision, 4);
  assert.equal(renderContext.maskScopeSignature, "mask-scope-a");
  assert.equal(renderContext.validityMask.canvas.id, "mask-canvas-a");
  assert.equal(Object.isFrozen(renderContext.requestContext), true);
  assert.equal(renderContext.renderGridProfile.signature, "grid-a");
  assert.equal(renderContext.paintFrame.colorCssForValue(10), initialColor);
  assert.equal(Object.isFrozen(renderContext), true);
  assert.equal(Object.isFrozen(renderContext.renderGridProfile), true);
  const matchesMask = vm.runInContext("sampledGridRenderContextMatchesMask", loaded.context);
  assert.equal(matchesMask(renderContext, {
    ready: true,
    maskId: "eez",
    maskVersion: "v12:v2",
    revision: 4,
    scopeSignature: "mask-scope-a",
  }), true);
  assert.equal(matchesMask(renderContext, {
    ready: true,
    maskId: "eez",
    maskVersion: "v12:v2",
    revision: 5,
    scopeSignature: "mask-scope-a",
  }), false);
  assert.throws(
    () => createContext(frame, { layerId: "context-grid", datasetId: "mapped-source" }),
    /request identity/,
  );
  assert.throws(
    () => createContext(frame, {
      layerId: "context-grid",
      datasetId: "mapped-source",
      requestContext: {
        layerId: "context-grid",
        datasetId: "another-source",
        date: "2020-01-01",
        bbox: "120,20,121,21",
      },
      frameIdentity,
    }),
    /dataset identity mismatch/,
  );
});

test("sampled-grid WebGL preserves the configured alpha instead of squaring it", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/rendering/sampled-grid-webgl-renderer.js"),
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
  const settings = fs.readFileSync(path.join(root, "static/js/ui/layers/sampled-grid-settings.js"), "utf8");
  assert.match(template, /id="sampled-grid-resolution"/);
  assert.match(template, /id="sampled-grid-scale-mode"/);
  assert.match(template, /id="sampled-grid-color-stops"/);
  assert.match(template, /id="sampled-grid-spatial-interpolation"/);
  assert.match(settings, /availableResolutionsKm/);
  assert.match(settings, /spatialInterpolation/);
  assert.match(settings, /setRequestedResolution/);
  assert.doesNotMatch(settings, /\[\s*4\s*,\s*16\s*,\s*32\s*\]/);
  assert.doesNotMatch(template, /id="gfw-(?:low|high)-color"/);
});

test("spatial interpolation uses valid values independently of display opacity", () => {
  const { colorScale, frameFromRows: makeFrame } = loadColorScale({
    layer_id: "continuous-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { zero_opacity: 0 } },
    },
  });
  const frame = makeFrame([
    { value: 10, bounds: { west: 0, south: 0, east: 1, north: 1 } },
    { value: 30, bounds: { west: 1, south: 0, east: 2, north: 1 } },
    { value: 0, bounds: { west: 2, south: 0, east: 3, north: 1 } },
  ]);
  const paintFrame = colorScale.frame(frame);
  const surface = colorScale.spatialSurface(frame, paintFrame);

  assert.equal(surface.count, 3);
  assert.deepEqual(Array.from(surface.indices), [0, 1, 2]);
  assert.deepEqual(
    Array.from(surface.values),
    [10, 20, 10, 20, 20, 15, 20, 15, 15, 0, 15, 0],
  );
});

test("spatial interpolation excludes null and no-data cells from the validity surface", () => {
  const { colorScale, frameFromRows: makeFrame } = loadColorScale({
    layer_id: "continuous-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { zero_opacity: 1 } },
    },
  });
  const frame = makeFrame([
    { value: 0, data_status: "observed", bounds: { west: 0, south: 0, east: 1, north: 1 } },
    { value: null, data_status: "no_data", bounds: { west: 1, south: 0, east: 2, north: 1 } },
  ]);
  const paintFrame = colorScale.frame(frame);
  const surface = colorScale.spatialSurface(frame, paintFrame);

  assert.deepEqual(Array.from(paintFrame.validIndices), [0]);
  assert.deepEqual(Array.from(surface.indices), [0]);
  assert.deepEqual(Array.from(surface.values), [0, 0, 0, 0]);
});

test("spatial interpolation does not share corner values through land", () => {
  const { colorScale, frameFromRows: makeFrame } = loadColorScale({
    layer_id: "continuous-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { zero_opacity: 1 } },
    },
  });
  const frame = makeFrame([
    { value: 10, bounds: { west: 0, south: 0, east: 1, north: 1 } },
    { value: 30, bounds: { west: 1, south: 0, east: 2, north: 1 } },
  ]);
  const validityMask = {
    ready: true,
    sampleLand(longitude) { return longitude > 1; },
  };
  const surface = colorScale.spatialSurface(frame, colorScale.frame(frame), validityMask);

  assert.deepEqual(Array.from(surface.values), [10, 10, 10, 10, 30, 30, 30, 30]);
});

test("spatial interpolation capability is compiled without source-specific layer names", () => {
  const capability = fs.readFileSync(
    path.join(root, "common_adapter/layers/capabilities.py"),
    "utf8",
  );
  const mappingController = fs.readFileSync(
    path.join(root, "static/js/ui/developer/developer-mapping-controller.js"),
    "utf8",
  );
  const renderer = fs.readFileSync(
    path.join(root, "static/js/rendering/sampled-grid-webgl-renderer.js"),
    "utf8",
  );
  const scoutCompilerStart = mappingController.indexOf("scoutValueSemantics(select)");
  const scoutCompiler = mappingController.slice(
    scoutCompilerStart,
    mappingController.indexOf("mappingForTable(profile, table)", scoutCompilerStart),
  );
  assert.doesNotMatch(capability, /pipeline_iceberg|gfw|chlor_a/i);
  assert.match(scoutCompiler, /columnValueSemantics/);
  assert.doesNotMatch(scoutCompiler, /numeric_candidate|continuous_candidate/);
  assert.match(renderer, /spatialSurface/);
  assert.match(renderer, /a_value/);
  assert.match(renderer, /sampledColor/);
});

test("non-zero extent includes negative values instead of silently meaning positive-only", () => {
  const { colorScale, frameFromRows: makeFrame } = loadColorScale({
    layer_id: "signed-grid",
    sampled_grid: {
      contract_version: "rrkal.sampled_grid.v1",
      geometry: { encoding: "center", cell_width_degrees: 1, cell_height_degrees: 1 },
      visualization: { color_scale: { mode: "nonzero_extent" } },
    },
  });
  const profile = colorScale.profile("signed-grid");
  const bounds = { west: 120, south: 20, east: 121, north: 21 };
  colorScale.frame(makeFrame([{ value: -4, bounds }, { value: 0, bounds }, { value: 2, bounds }]), profile);
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
    "static/js/rendering/sampled-grid-paint.js",
    "static/js/layers/sampled-grid-layer.js",
    "static/js/rendering/sampled-grid-webgl-renderer.js",
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

test("bounded sampled-grid layers clip canonical query bboxes to source coverage", () => {
  const dataset = {
    sampled_grid: {
      default_coverage_id: "small",
      coverage_areas: [
        { id: "small", bounds: { west: 118, south: 20, east: 122, north: 26 } },
        { id: "large", bounds: { west: 105, south: 15, east: 135, north: 35 } },
      ],
    },
  };
  const { context, mapState } = loadLayerViewportController(dataset);
  const model = context.createDatasetCoverageModel(dataset);
  assert.equal(model.defaultCoverageId, "small");
  assert.deepEqual(JSON.parse(JSON.stringify(model.initialBounds)), {
    west: 118,
    south: 20,
    east: 122,
    north: 26,
  });
  assert.equal(model.queryBboxString("100,10,140,40"), "105.000000,15.000000,135.000000,35.000000");
  assert.equal(model.queryBboxString("125,20,140,30"), "125.000000,20.000000,135.000000,30.000000");
  assert.equal(model.queryBboxString("0,0,1,1"), null);

  const viewport = context.LayerViewportController.syncForDataset("bounded", { focus: true });
  assert.equal(viewport.mode, "coverage");
  assert.equal(viewport.minZoom, 5);
  assert.equal(viewport.defaultCoverageId, "small");
  assert.deepEqual(JSON.parse(JSON.stringify(viewport.initialBounds)), {
    west: 118,
    south: 20,
    east: 122,
    north: 26,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(mapState.center)), { lat: 23, lng: 120 });
  assert.equal(mapState.zoom, 5);
  assert.ok(mapState.maxBounds);
  assert.equal(
    context.LayerViewportController.queryBbox("118,20,122,26", "bounded"),
    "118.000000,20.000000,122.000000,26.000000",
  );

  const frame = frameFromRows(context, [
    { id: "inside", bounds: { west: 119, south: 23, east: 120, north: 24 } },
    { id: "outside", bounds: { west: 1, south: 1, east: 2, north: 2 } },
  ]);
  const visible = context.LayerViewportController.filterFrame(frame, "bounded");
  assert.deepEqual([...visible.rows()].map((row) => row.id), ["inside"]);

  const source = fs.readFileSync(
    path.join(root, "static/js/ui/map/layer-viewport-controller.js"),
    "utf8",
  );
  assert.match(source, /coverage_areas/);
  assert.match(source, /queryBboxString/);
  assert.match(source, /setMaxBounds/);
  assert.match(source, /filterFrame/);
  assert.doesNotMatch(source, /coverage_mask|destination-out|sampledGridMaskPane/);
  assert.doesNotMatch(source, /pipeline_iceberg|fishing_hours|northwest_pacific/);

  const template = fs.readFileSync(path.join(root, "templates/index.html"), "utf8");
  assert.match(template, /layer-viewport-controller\.js/);
  assert.doesNotMatch(template, /sampled-grid-coverage-mask\.js/);
  assert.equal(fs.existsSync(path.join(root, "static/js/layers/sampled-grid-coverage-mask.js")), false);
});

test("coverage CC starts at the union minimum zoom while the adapter owns source scope translation", () => {
  const dataset = {
    sampled_grid: {
      default_coverage_id: "taiwan",
      coverage_areas: [
        { id: "taiwan", bounds: { west: 118, south: 20, east: 124, north: 27 } },
        { id: "northwest_pacific", bounds: { west: 105, south: 15, east: 135, north: 35 } },
      ],
    },
  };
  const { context, mapState } = loadLayerViewportController(dataset, {
    boundsZoom: (bounds) => (
      bounds.bounds.east - bounds.bounds.west >= 20 ? 6 : 8
    ),
  });

  const viewport = context.LayerViewportController.syncForDataset("bounded", { focus: true });

  assert.equal(viewport.minZoom, 6);
  assert.equal(mapState.zoom, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(mapState.center)), { lat: 23.5, lng: 121 });
  assert.deepEqual(JSON.parse(JSON.stringify(viewport.coverageBounds)), {
    west: 105,
    south: 15,
    east: 135,
    north: 35,
  });
  assert.equal(viewport.queryBounds, null);
  assert.equal(
    context.LayerViewportController.queryBbox("118.9,21.8,123.1,25.1", "bounded"),
    "118.900000,21.800000,123.100000,25.100000",
  );
  assert.equal(
    context.LayerViewportController.queryBbox("112.8,19.2,129.1,27.6", "bounded"),
    "112.800000,19.200000,129.100000,27.600000",
  );
});

test("dataset activation settles layout before deriving its first query viewport", async () => {
  const dataset = {
    sampled_grid: {
      coverage_areas: [
        { id: "bounded", bounds: { west: 105, south: 15, east: 135, north: 35 } },
      ],
    },
  };
  const { context, mapState } = loadLayerViewportController(dataset);

  const viewport = await context.LayerViewportController.settleForQuery("bounded", { focus: true });

  assert.equal(mapState.invalidations, 1);
  assert.equal(viewport.datasetId, "bounded");
  assert.deepEqual(JSON.parse(JSON.stringify(mapState.center)), { lat: 25, lng: 120 });
});

test("schema candidates never become mapping roles automatically", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/ui/developer/developer-mapping-controller.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /guessedRole/);
  assert.match(source, /roleForColumn\([\s\S]*?return "ignore";/);
  assert.match(source, /table\?\.resolved_mapping/);
});

test("readonly source mappings distinguish unmapped fields from query exclusion", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/ui/developer/developer-mapping-controller.js"),
    "utf8",
  );
  assert.match(source, /readonlyRoleMarkup/);
  assert.match(source, /未映射/);
  assert.match(source, /mappingCapability/);
  assert.doesNotMatch(source, /readonly \? "disabled"/);
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
    "static/js/application/widgets/widget-model-functions.js",
    "static/js/application/widgets/widget-query-context.js",
    "static/js/application/widgets/line-chart-data-source.js",
    "static/js/application/widgets/slice-chart-data-sources.js",
    "static/js/application/widgets/table-widget-data-source.js",
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
  const functions = fs.readFileSync(path.join(root, files[0]), "utf8");
  assert.match(functions, /dataset\?\.sampled_grid\) return "value"/);
});

test("widget queries keep requested resolution when the observed source resolution differs", () => {
  const queryContext = loadWidgetQueryContext([]);
  const layer = { datasetId: "pipeline.fishing", layerId: "pipeline.fishing" };
  const selection = {
      selection_grid: {
        participants: [{
          dataset_id: "pipeline.fishing",
          layer_id: "pipeline.fishing",
          requested_resolution_km: 4,
          actual_resolution_km: 16,
          effective_resolution_km: 16,
        }],
      },
      bbox: [120, 20, 121, 21],
    };
  const resolution = queryContext.resolutionFor(layer, selection);
  const request = queryContext.request(layer, selection);
  assert.equal(resolution, 4);
  assert.equal(request.resolution, 4);
  assert.equal(request.queryResolution, 4);
});

test("line chart derives its moving window from the canonical snapshot cache", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/application/widgets/line-chart-data-source.js"),
    "utf8",
  );
  assert.match(source, /this\.queryContext\.resolutionFor/);
  assert.match(source, /this\.dataFrameStore\.inspect/);
  assert.match(source, /this\.frameDemandService\.demandRange/);
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
    path.join(root, "static/js/application/widgets/line-chart-data-source.js"),
    "utf8",
  );
  const lineChartView = fs.readFileSync(
    path.join(root, "static/js/ui/widgets/capabilities/line-chart.js"),
    "utf8",
  );
  const activeDateHandler = runtime.match(
    /addEventListener\("rrkal:active-date-changed",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*listenerOptions\);/,
  );
  assert.ok(activeDateHandler, "active date handler must remain explicit");
  assert.match(activeDateHandler[1], /renderLineChartWidgets/);
  assert.doesNotMatch(activeDateHandler[1], /refreshLineChartWidgets/);
  assert.doesNotMatch(activeDateHandler[1], /ensureCurrentWindow/);
  assert.match(lineChart, /this\.queryContext\.currentDate\(selected\)/);
  assert.match(lineChart, /scopeDates\(selected/);
  const modelBody = lineChart.slice(lineChart.indexOf("  model() {"), lineChart.indexOf("  ensureCurrentWindow("));
  const ensureBody = lineChart.slice(lineChart.indexOf("  ensureCurrentWindow("), lineChart.indexOf("  packetRequest("));
  assert.doesNotMatch(modelBody, /this\.fill\(/);
  assert.match(ensureBody, /allowNetwork && snapshots\.missingDates\.length \? this\.fill\(request\) : null/);
  assert.match(lineChart, /const windowSize = Math\.min\(scope\.length, \(this\.windowDays \* 2\) \+ 1\)/);
  assert.match(lineChart, /scope\.length - windowSize/);
  assert.match(lineChartView, /dateX\(model, model\.anchorDate\)/);
  assert.match(lineChart, /anchorDate:\s*request\.anchorDate/);
  assert.match(lineChartView, /x0:\s*model\.anchorDate/);
  assert.match(lineChartView, /x1:\s*model\.anchorDate/);
  assert.match(lineChartView, /range:\s*model\.xRange/);
  assert.match(lineChartView, /當下切片/);
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
  assert.match(handler[1], /queueFrameStoreRefresh/);
  const projection = runtime.match(/queueFrameStoreRefresh\(event\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*bind\(\)/);
  assert.ok(projection, "cache commit projection must remain explicit");
  assert.match(projection[1], /renderLineChartWidgets/);
  assert.doesNotMatch(projection[1], /ensureCurrentWindow|refreshLineChartWidgets|\.fill\(/);
});

test("pie and horizontal bar widgets query dynamic canonical layer matrices", () => {
  const queryContext = fs.readFileSync(path.join(root, "static/js/application/widgets/widget-query-context.js"), "utf8");
  const charts = fs.readFileSync(path.join(root, "static/js/application/widgets/slice-chart-data-sources.js"), "utf8");
  assert.match(queryContext, /registry\?\.sampledGridLayers\?\.\(\{ enabledOnly: true \}\)/);
  assert.match(queryContext, /columns:\s*"render"/);
  assert.match(queryContext, /numericSummary\("value"\)/);
  assert.match(charts, /this\.queryContext\.sampledGridLayers/);
  assert.match(charts, /this\.queryContext\.selections/);
  const horizontal = charts;
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
  };
  horizontalContext.window = horizontalContext;
  vm.createContext(horizontalContext);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/application/widgets/slice-chart-data-sources.js"), "utf8"),
    horizontalContext,
  );
  const horizontal = new horizontalContext.HorizontalBarChartDataSource({
    queryContext: {},
  });
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
  assert.doesNotMatch(selection, /invalidateSize/);
  assert.match(selection, /document\.body\?\.classList\.toggle\("is-tile-selection-mode-active",\s*next\)/);
  assert.match(styles, /body\.is-tile-selection-mode-active \*\s*\{\s*cursor:\s*default !important/);
  assert.match(styles, /#map\.is-tile-selection-enabled\.is-virtual-grid-clickable[\s\S]*?cursor:\s*crosshair !important/);
  assert.match(styles, /\.tile-selection-rectangle\s*\{[\s\S]*?animation:\s*tile-selection-breathe/);
});

test("sampled-grid renderers redraw once after viewport interaction settles", () => {
  const webgl = fs.readFileSync(
    path.join(root, "static/js/rendering/sampled-grid-webgl-renderer.js"),
    "utf8",
  );
  const canvas = fs.readFileSync(
    path.join(root, "static/js/layers/sampled-grid-layer.js"),
    "utf8",
  );
  const ais = fs.readFileSync(
    path.join(root, "static/js/layers/ais-layer.js"),
    "utf8",
  );
  assert.match(webgl, /targetMap\.on\("moveend zoomend resize",\s*layer\._scheduleViewportReset/);
  assert.match(webgl, /layer\._renderClock\.request\(\(\)\s*=>\s*\{/);
  assert.match(webgl, /layer\._renderClock\.cancel\(layer\._viewportResetFrame\)/);
  assert.doesNotMatch(webgl, /targetMap\.on\("move zoom resize"/);
  assert.match(canvas, /bindSampledGridViewportRedraw\(this, targetMap\)/);
  assert.doesNotMatch(canvas, /targetMap\.on\("move zoom resize"/);
  assert.doesNotMatch(canvas.match(/function renderSampledGridMap[\s\S]*?\n}/)?.[0] || "", /invalidateSize/);
  assert.doesNotMatch(ais.match(/function renderAisMap[\s\S]*?\n}/)?.[0] || "", /invalidateSize/);
});

test("sampled-grid WebGL contexts are explicitly released and support probing is cached", () => {
  const webgl = fs.readFileSync(
    path.join(root, "static/js/rendering/sampled-grid-webgl-renderer.js"),
    "utf8",
  );

  assert.match(webgl, /function releaseWebglContext\(gl\)/);
  assert.match(webgl, /WEBGL_lose_context/);
  assert.match(webgl, /releaseGpuResources\(\);\s*releaseWebglContext\(this\._gl\)/);
  assert.match(webgl, /let sampledGridWebglSupported = null/);
  assert.match(webgl, /if \(sampledGridWebglSupported !== null\) return sampledGridWebglSupported/);
  assert.match(webgl, /releaseWebglContext\(gl\);\s*return sampledGridWebglSupported/);
  assert.match(webgl, /webglcontextlost/);
  assert.match(webgl, /webglcontextrestored/);
  assert.match(webgl, /this\._continuousFieldProvider\?\.reconstruct/);
  assert.doesNotMatch(webgl, /SampledGridColorScale\.spatialSurface/);
});

test("sampled-grid playback reuses a DI-owned two-layer renderer pool", () => {
  const layer = fs.readFileSync(
    path.join(root, "static/js/layers/sampled-grid-layer.js"),
    "utf8",
  );
  const effects = fs.readFileSync(
    path.join(root, "static/js/layers/sampled-grid-layer-effects.js"),
    "utf8",
  );
  const composition = fs.readFileSync(
    path.join(root, "static/js/runtime/runtime-composition-root.js"),
    "utf8",
  );
  const template = fs.readFileSync(path.join(root, "templates/index.html"), "utf8");
  const settings = fs.readFileSync(
    path.join(root, "static/js/ui/layers/sampled-grid-settings.js"),
    "utf8",
  );
  const layerMenu = fs.readFileSync(
    path.join(root, "static/js/ui/layers/layer-menu.js"),
    "utf8",
  );

  assert.match(composition, /this\.own\("SampledGridLayerPool",\s*new SampledGridLayerPoolCore/);
  assert.match(composition, /this\.own\(\s*"ContinuousFieldService"/);
  assert.match(composition, /continuousFieldProvider:\s*continuousFieldService/);
  assert.ok(
    template.indexOf("continuous-field-service.js") < template.indexOf("sampled-grid-webgl-renderer.js"),
  );
  assert.match(composition, /maxLayers:\s*2/);
  assert.match(composition, /new SampledGridLayerTransitionControllerCore\(\{/);
  assert.match(composition, /renderContextValidator:\s*renderContextIsCurrent/);
  assert.match(layer, /SampledGridLayerPool\.acquire\(choice\.LayerClass/);
  assert.match(layer, /SampledGridLayerPool\.discard\(nextLayer\)/);
  assert.match(layer, /retainPrevious:\s*typeof SampledGridLayerPool !== "undefined"/);
  assert.match(effects, /retainPrevious = false/);
  assert.match(effects, /if \(retainPrevious\)[\s\S]*?setLayerOpacity\(previousLayer, 0\)/);
  assert.match(layer, /function repaintActiveSampledGridLayer/);
  assert.match(layer, /SampledGridLayerPool\.activate\(layer\)/);
  assert.match(layer, /requestContext:\s*current\?\.requestContext/);
  assert.match(layer, /nextLayer\.setFrame\([\s\S]*?activateLayer\(nextLayer\)/);
  assert.match(effects, /class SampledGridLayerTransitionControllerCore/);
  assert.match(effects, /cancelScheduledWork\(\)/);
  assert.doesNotMatch(settings, /state\.gridLayer\.setFrame/);
  assert.doesNotMatch(layerMenu, /state\.gridLayer\.setFrame/);
});

test("sampled-grid viewport changes replace the query scope after the settle window", () => {
  const stateSource = fs.readFileSync(path.join(root, "static/js/core/state.js"), "utf8");
  const refresh = fs.readFileSync(path.join(root, "static/js/core/render-refresh.js"), "utf8");
  assert.match(stateSource, /viewportReloadSettleMs:\s*700/);
  assert.match(refresh, /function viewportReloadSettleMs\(\)/);
  assert.match(refresh, /function primaryLayerDependsOnViewport\(\)/);
  assert.match(refresh, /isSampledGridLayer\(state\.dataLayer\)[\s\S]*?return true/);
  assert.doesNotMatch(refresh, /state\.layerViewport\?\.mode !== "coverage"/);
  assert.match(refresh, /state\.isBootstrapping \|\| !primaryLayerDependsOnViewport\(\)/);
  assert.match(refresh, /state\.rendering\?\.viewportReloadSettleMs/);
  assert.match(refresh, /schedulePrimaryReload\(viewportReloadSettleMs\(\)\)/);
  assert.match(refresh, /SampledGridLayerPool\.invalidateActiveContext\("viewport_scope_changed"\)/);
  assert.match(refresh, /function refreshAfterViewportResize\(\)/);
  assert.match(refresh, /map\.on\("resize", refreshAfterViewportResize\)/);
  assert.doesNotMatch(refresh, /schedulePrimaryReload\(250\)/);
});

test("a stale render transaction schedules the current viewport instead of reporting ready", () => {
  const apiClient = fs.readFileSync(
    path.join(root, "static/js/services/api-client.js"),
    "utf8",
  );
  const staleBranch = apiClient.indexOf("renderResult.committed === false");
  const readyOffset = apiClient.slice(staleBranch).search(/RenderState\.ready\(\s*requestedLayer/);
  const readyBranch = readyOffset >= 0 ? staleBranch + readyOffset : -1;
  assert.ok(staleBranch >= 0, "API client must detect a renderer-rejected transaction");
  assert.ok(readyBranch > staleBranch, "stale render handling must run before ready is reported");
  assert.match(
    apiClient.slice(staleBranch, readyBranch),
    /schedulePrimaryReload\(viewportReloadSettleMs\(\)\)/,
  );
  assert.match(
    apiClient.slice(staleBranch, readyBranch),
    /visible:\s*false/,
  );
});

test("sampled-grid viewport resize invalidates the active context and schedules one replacement", async () => {
  const source = fs.readFileSync(path.join(root, "static/js/core/render-refresh.js"), "utf8");
  const handlers = {};
  const scheduled = [];
  const invalidations = [];
  let reloadCalls = 0;
  const state = {
    dataLayer: "sea_temperature",
    fetchSeq: 0,
    isBootstrapping: false,
    primaryReloadTimer: null,
    rendering: { viewportReloadSettleMs: 700 },
  };
  const context = vm.createContext({
    state,
    ClockDomain: {
      monotonic: {
        cancel() {},
        schedule(callback, delay) {
          const task = { callback, delay };
          scheduled.push(task);
          return task;
        },
      },
    },
    reloadActiveLayer() {
      reloadCalls += 1;
      return Promise.resolve();
    },
    isSampledGridLayer() { return true; },
    SampledGridLayerPool: {
      invalidateActiveContext(reason) { invalidations.push(reason); },
    },
    clearSampledGridLayerForLodReload() {},
    RenderState: { loading() {} },
    isLodZoomEvent() { return false; },
    markEezTilesUpdating() { return false; },
    refreshEezTileReadiness() { return Promise.resolve(); },
    TimingMetrics: { setText() {} },
    setStatus() {},
    $() { return null; },
    map: {
      on(events, callback) {
        for (const event of events.split(/\s+/)) handlers[event] = callback;
      },
    },
    console,
  });

  vm.runInContext(source, context);
  context.bindMapRefresh();
  handlers.resize();

  assert.deepEqual(invalidations, ["viewport_scope_changed"]);
  assert.equal(state.fetchSeq, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 700);
  assert.equal(state.primaryReloadTimer, scheduled[0]);

  scheduled[0].callback();
  await Promise.resolve();
  assert.equal(reloadCalls, 1);
  assert.equal(state.primaryReloadTimer, null);
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
  const server = fs.readFileSync(
    path.join(root, "common_adapter/http/server.py"),
    "utf8",
  );

  assert.match(
    developerRoutes,
    /def route_provided_layer_rows\(layer_registry: RuntimeLayerRegistry\)[\s\S]*?layer_registry\.snapshot\(force=True\)\["layers"\]/,
  );
  assert.match(
    developerRoutes,
    /def developer_layer_contracts[\s\S]*?route_provided_layer_rows\(layer_registry\)/,
  );
  assert.match(datasetRoutes, /class DatasetRoutes[\s\S]*?self\.layer_registry = layer_registry/);
  assert.match(datasetRoutes, /registry = self\.layer_registry\.snapshot\(refresh_if_expired=False\)/);
  assert.match(server, /layer_registry = RuntimeLayerRegistry\(config\)/);
  assert.match(server, /route_status_registry = RouteStatusRegistry\(config, layer_registry\)/);
  assert.match(server, /create_developer_app\([\s\S]*?layer_registry=layer_registry/);
  assert.match(
    server,
    /create_app\([\s\S]*?developer_url=developer_url,[\s\S]*?layer_registry=layer_registry,[\s\S]*?route_status_registry=route_status_registry/,
  );
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
  assert.match(eez, /\/api\/overlays\/eez\/render\/tiles\/\{z\}\/\{x\}\/\{y\}\.pbf/);
  assert.match(eez, /eez:\s*eezVectorTileStyle,[\s\S]*?eez_boundary:\s*eezBoundaryTileStyle/);
  assert.doesNotMatch(eez, /createEezVectorGrid\("\/api\/overlays\/eez\/boundary\/tiles/);
});
