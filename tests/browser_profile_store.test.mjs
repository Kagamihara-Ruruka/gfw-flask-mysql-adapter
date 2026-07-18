import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = fs.readFileSync(
  path.join(process.cwd(), "static/js/services/browser-profile-store.js"),
  "utf8",
);

function loadModule() {
  const context = createContext({
    console,
    EventTarget,
    globalThis: null,
  });
  context.globalThis = context;
  runInContext(source, context);
  return context;
}

test("browser profile hydrates only device and visual preferences", () => {
  const context = loadModule();
  const targetState = {
    datasetId: "must-remain",
    queryPolicy: { network_concurrency: 6 },
    mapSettings: { basemapId: "carto_light", dragging: true },
    layerAlpha: { eez: 1 },
    eezPaint: { polTypeColors: { disputed: "#red" } },
    sampledGridPaintProfiles: {},
    browserProfile: {},
  };
  context.BrowserProfileContract.hydrate(targetState, {
    mapSettings: { basemapId: "esri_world_imagery", dragging: false },
    layerAlpha: { eez: 0.4 },
    eezPaint: { polTypeColors: { joint: "#yellow" } },
    sampledGridPaintProfiles: {},
    hardwareMode: "webgl",
    aisRenderStrategy: "point_dots",
  });

  assert.equal(targetState.datasetId, "must-remain");
  assert.equal(targetState.queryPolicy.network_concurrency, 6);
  assert.equal(targetState.mapSettings.basemapId, "esri_world_imagery");
  assert.equal(targetState.mapSettings.dragging, false);
  assert.equal(targetState.eezPaint.polTypeColors.disputed, "#red");
  assert.equal(targetState.eezPaint.polTypeColors.joint, "#yellow");
  assert.equal(targetState.browserProfile.hardwareMode, "webgl");
});

test("browser profile persistence degrades without changing runtime truth", () => {
  const context = loadModule();
  const eventTarget = new EventTarget();
  const targetState = {
    mapSettings: { basemapId: "carto_light" },
    layerAlpha: {},
    eezPaint: {},
    sampledGridPaintProfiles: {},
    browserProfile: { hardwareMode: "auto", aisRenderStrategy: "density_grid" },
  };
  const storage = {
    setItem() {
      throw new Error("storage blocked");
    },
  };
  const store = new context.BrowserProfileStoreCore({ targetState, storage, eventTarget }).mount();

  assert.equal(store.persist(), false);
  assert.equal(store.snapshot().persistence, "session_fallback");
  assert.equal(targetState.mapSettings.basemapId, "carto_light");
  store.dispose();
});

test("browser profile reports session fallback when storage is unavailable", () => {
  const context = loadModule();
  const eventTarget = new EventTarget();
  const targetState = {
    mapSettings: {},
    layerAlpha: {},
    eezPaint: {},
    sampledGridPaintProfiles: {},
    browserProfile: { hardwareMode: "auto", aisRenderStrategy: "density_grid" },
  };
  const store = new context.BrowserProfileStoreCore({
    targetState,
    storage: null,
    eventTarget,
  }).mount();

  assert.equal(store.snapshot().persistence, "session_fallback");
  assert.equal(store.persist(), false);
  assert.equal(store.snapshot().persistence, "session_fallback");
  store.dispose();
});

test("browser profile codec rejects unrelated and malformed persisted state", () => {
  const context = loadModule();
  const unrelated = {
    getItem: () => JSON.stringify({ schema: "other.v1", datasetId: "injected" }),
  };
  const malformed = { getItem: () => "{" };

  assert.equal(context.BrowserProfileContract.read(unrelated), null);
  assert.equal(context.BrowserProfileContract.read(malformed), null);
});
