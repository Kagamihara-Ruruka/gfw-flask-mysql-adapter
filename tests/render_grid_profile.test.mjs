import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "static/js/rendering/render-grid-profile.js"),
  "utf8",
);

function loadPolicy() {
  const events = [];
  const context = vm.createContext({
    console,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
  });
  vm.runInContext(source, context, { filename: "render-grid-profile.js" });
  return { context, events };
}

function baseGrid() {
  return {
    status: "single",
    detail: "Ocean grid x 1",
    baseResolutionKm: 4,
    participants: [{ dataset_id: "ocean", layer_id: "ocean", label: "Ocean" }],
    geometry: {
      encoding: "global_index",
      origin_lon: -180,
      origin_lat: 90,
      cell_width_degrees: 1 / 24,
      cell_height_degrees: 1 / 24,
    },
  };
}

function dataset({ aggregation = true } = {}) {
  return {
    sampled_grid: {
      visualization: aggregation ? {
        aggregation: {
          reducer: "mean",
          null_policy: "ignore",
          min_cell_pixels: 1.5,
          max_factor: 64,
          zoom_hysteresis: 0.2,
        },
      } : {},
    },
  };
}

test("zoom aggregation derives a render-only power-of-two grid profile", () => {
  const { context } = loadPolicy();
  const profile = context.buildRenderGridProfile({
    baseGrid: baseGrid(),
    zoom: 4,
    requestedMultiplier: 1,
    gpuAggregationAvailable: true,
    datasetProvider: () => dataset(),
  });

  assert.equal(profile.aggregationFactor, 4);
  assert.equal(profile.baseResolutionKm, 4);
  assert.equal(profile.renderResolutionKm, 16);
  assert.equal(profile.geometry.cell_width_degrees, 1 / 6);
  assert.equal(profile.reducer, "mean");
  assert.equal(profile.nullPolicy, "ignore");
  assert.equal(profile.gpuAggregation, true);
});

test("zoom bucket hysteresis prevents boundary churn", () => {
  const { context } = loadPolicy();
  assert.equal(context.resolveRenderGridZoomBucket(5.6, 6, 0.2), 6);
  assert.equal(context.resolveRenderGridZoomBucket(5.2, 6, 0.2), 5);
  assert.equal(context.resolveRenderGridZoomBucket(6, 5, 0.2), 6);
});

test("missing reducer or GPU capability keeps the canonical base grid", () => {
  const { context } = loadPolicy();
  const noReducer = context.buildRenderGridProfile({
    baseGrid: baseGrid(),
    zoom: 3,
    requestedMultiplier: 8,
    gpuAggregationAvailable: true,
    datasetProvider: () => dataset({ aggregation: false }),
  });
  const noGpu = context.buildRenderGridProfile({
    baseGrid: baseGrid(),
    zoom: 3,
    requestedMultiplier: 8,
    gpuAggregationAvailable: false,
    datasetProvider: () => dataset(),
  });

  assert.equal(noReducer.aggregationFactor, 1);
  assert.equal(noReducer.overrideReason, "aggregation_contract_missing_or_incompatible");
  assert.equal(noGpu.aggregationFactor, 1);
  assert.equal(noGpu.overrideReason, "gpu_aggregation_unavailable");
});

test("render profile controller owns one immutable profile and emits only on change", () => {
  const { context } = loadPolicy();
  const targetState = { virtualGrid: { requestedMultiplier: 1 } };
  const events = [];
  const controller = new context.RenderGridProfileControllerCore({
    targetState,
    baseGridProvider: () => baseGrid(),
    zoomProvider: () => 5,
    gpuAggregationAvailableProvider: () => true,
    datasetProvider: () => dataset(),
    eventTarget: { dispatchEvent: (event) => events.push(event) },
  });

  const first = controller.refresh("first");
  const second = controller.refresh("same");
  assert.equal(first.aggregationFactor, 2);
  assert.equal(first, targetState.renderGridProfile);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "rrkal:render-grid-profile-changed");
  assert.equal(Object.isFrozen(first), true);
});

test("render grid profile is absent from query identity and transport requests", () => {
  const renderIntent = fs.readFileSync(
    path.join(root, "static/js/services/render-intent-service.js"),
    "utf8",
  );
  const frameIdentity = fs.readFileSync(
    path.join(root, "static/js/services/frame-identity.js"),
    "utf8",
  );
  assert.doesNotMatch(renderIntent, /renderGridProfile|zoomBucket|aggregationFactor/);
  assert.doesNotMatch(frameIdentity, /renderGridProfile|zoomBucket|aggregationFactor/);
});
