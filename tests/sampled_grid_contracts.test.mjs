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
    },
    map: {
      getZoom: () => 6,
      getCenter: () => ({ lat: 21, lng: 121 }),
    },
    normalizeLongitude(value) {
      return ((((Number(value) + 180) % 360) + 360) % 360) - 180;
    },
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
  };
}

test("sampled-grid LOD and virtual cells come from the mapped contract", () => {
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

  assert.equal(contract.requestResolution({ zoom: 3, latitude: 21 }), 32);
  assert.equal(contract.requestResolution({ zoom: 6, latitude: 21 }), 4);
  const cell = contract.model().cellAt(21.99, 120.01, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(cell.bounds)), {
    west: 120,
    south: 21.958333333333332,
    east: 120.04166666666667,
    north: 22,
  });
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
  const { contract, colorScale } = loadColorScale({
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
});

test("sampled-grid settings expose contract-driven multi-stop controls", () => {
  const template = fs.readFileSync(path.join(root, "templates/index.html"), "utf8");
  assert.match(template, /id="sampled-grid-scale-mode"/);
  assert.match(template, /id="sampled-grid-color-stops"/);
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
    "static/js/services/gfw-record-cache.js",
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

test("sampled-grid coverage mask is contract-driven and source-agnostic", () => {
  const source = fs.readFileSync(
    path.join(root, "static/js/layers/sampled-grid-coverage-mask.js"),
    "utf8",
  );
  assert.match(source, /coverage_areas/);
  assert.match(source, /coverage_mask/);
  assert.match(source, /destination-out/);
  assert.match(source, /sampledGridMaskPane/);
  assert.doesNotMatch(source, /pipeline_iceberg|fishing_hours|northwest_pacific/);
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
  assert.match(datasetRoutes, /"layers": active_layer_contract_rows\(/);
  assert.doesNotMatch(developerRoutes, /build_layer_contracts\(/);
});
