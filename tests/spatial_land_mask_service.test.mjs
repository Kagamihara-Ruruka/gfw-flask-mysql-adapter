import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function point(x, y) {
  return {
    x,
    y,
    divideBy(value) { return point(this.x / value, this.y / value); },
    floor() { return point(Math.floor(this.x), Math.floor(this.y)); },
  };
}

function loadService() {
  const context = vm.createContext({ console, AbortController });
  context.globalThis = context;
  context.CustomEvent = class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  };
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/core/runtime-primitives.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/services/spatial-land-mask-service.js"), "utf8"),
    context,
  );
  return context.SpatialLandMaskServiceCore;
}

test("spatial land mask composes only tiles required by the current viewport", async () => {
  const SpatialLandMaskServiceCore = loadService();
  const drawn = [];
  const maskContext = {
    imageSmoothingEnabled: true,
    clearRect() {},
    drawImage(image, x, y) { drawn.push([image.url, x, y]); },
  };
  const events = [];
  const listeners = new Map();
  const map = {
    on() {}, off() {},
    getZoom: () => 2,
    getSize: () => ({ x: 512, y: 256 }),
    getPixelBounds: () => ({ min: point(0, 0), max: point(511, 255) }),
  };
  const state = { dataLayer: "temperature" };
  const capabilityProvider = (layerId, name) => {
    if (layerId === "temperature" && name === "land_mask_consumer") {
      return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
    }
    if (layerId === "eez" && name === "land_mask_provider") {
      return {
        status: "supported",
        source_version: "v12",
        capability_version: "rrkal.eez_land_mask.v2",
        tile_template: "/mask/{z}/{x}/{y}.svg",
      };
    }
    return null;
  };
  const service = new SpatialLandMaskServiceCore({
    targetMap: map,
    targetState: state,
    capabilityProvider,
    eventTarget: {
      addEventListener(type, callback) { listeners.set(type, callback); },
      removeEventListener(type) { listeners.delete(type); },
      dispatchEvent(event) { events.push(event); },
    },
    renderClock: { request: (callback) => { callback(); return 1; }, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => {
      let width = 0;
      let height = 0;
      return {
        get width() { return width; },
        set width(value) { width = value; maskContext.imageSmoothingEnabled = true; },
        get height() { return height; },
        set height(value) { height = value; maskContext.imageSmoothingEnabled = true; },
        getContext: () => maskContext,
      };
    },
    imageLoader: async (url) => ({ url }),
  });

  await service.refresh("test");

  assert.equal(service.snapshot().ready, true);
  assert.equal(maskContext.imageSmoothingEnabled, false);
  assert.equal(service.snapshot().revision, 1);
  assert.equal(drawn.length, 2);
  assert.deepEqual(drawn.map(([url]) => url), [
    "/mask/2/0/0.svg?v=v12%3Arrkal.eez_land_mask.v2",
    "/mask/2/1/0.svg?v=v12%3Arrkal.eez_land_mask.v2",
  ]);
  assert.equal(events.length, 1);
  assert.equal(events.at(-1).type, "rrkal:spatial-land-mask-changed");

  await service.refresh("same_viewport");

  assert.equal(service.snapshot().revision, 1);
  assert.equal(drawn.length, 2);
  assert.equal(events.length, 1);
});

test("spatial land mask publishes a new immutable canvas for each viewport generation", async () => {
  const SpatialLandMaskServiceCore = loadService();
  let minimumX = 0;
  let canvasId = 0;
  const canvases = [];
  const capabilityProvider = (layerId, name) => {
    if (layerId === "temperature" && name === "land_mask_consumer") {
      return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
    }
    if (layerId === "eez" && name === "land_mask_provider") {
      return { status: "supported", source_version: "v12", capability_version: "v2", tile_template: "/{z}/{x}/{y}" };
    }
    return null;
  };
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {}, getZoom: () => 2, getSize: () => ({ x: 256, y: 256 }),
      getPixelBounds: () => ({ min: point(minimumX, 0), max: point(minimumX + 256, 256) }),
    },
    targetState: { dataLayer: "temperature" },
    capabilityProvider,
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => {
      const canvas = {
        id: ++canvasId,
        width: 0,
        height: 0,
        getContext: () => ({ clearRect() {}, drawImage() {} }),
      };
      canvases.push(canvas);
      return canvas;
    },
    imageLoader: async () => ({}),
  });

  await service.refresh("first_viewport");
  const first = service.snapshot();
  minimumX = 256;
  await service.refresh("second_viewport");
  const second = service.snapshot();

  assert.equal(canvases.length, 2);
  assert.notEqual(first.canvas, second.canvas);
  assert.equal(first.canvas.id, 1);
  assert.equal(second.canvas.id, 2);
  assert.notEqual(first.scopeSignature, second.scopeSignature);
});

test("spatial land mask crops server-side tile bleed before viewport composition", async () => {
  const SpatialLandMaskServiceCore = loadService();
  const draws = [];
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {}, getZoom: () => 2, getSize: () => ({ x: 256, y: 256 }),
      getPixelBounds: () => ({ min: point(0, 0), max: point(256, 256) }),
    },
    targetState: { dataLayer: "temperature" },
    capabilityProvider: (layerId, name) => {
      if (layerId === "temperature" && name === "land_mask_consumer") {
        return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
      }
      if (layerId === "eez" && name === "land_mask_provider") {
        return { status: "supported", source_version: "v12", capability_version: "v2", tile_template: "/{z}/{x}/{y}" };
      }
      return null;
    },
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ clearRect() {}, drawImage(...args) { draws.push(args); } }),
    }),
    imageLoader: async () => ({ naturalWidth: 260, naturalHeight: 260 }),
  });

  await service.refresh("bleed_crop");

  assert.equal(draws.length, 1);
  assert.deepEqual(draws[0].slice(1), [2, 2, 256, 256, 0, 0, 256, 256]);
});

test("spatial land mask publishes a world-coordinate validity contract", async () => {
  const SpatialLandMaskServiceCore = loadService();
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 0, 0, 0,
  ]);
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {},
      getZoom: () => 0,
      getSize: () => ({ x: 2, y: 1 }),
      getPixelBounds: () => ({ min: point(0, 0), max: point(2, 1) }),
      project: ([latitude, longitude]) => ({ x: longitude, y: latitude }),
    },
    targetState: { dataLayer: "temperature" },
    capabilityProvider: (layerId, name) => {
      if (layerId === "temperature" && name === "land_mask_consumer") {
        return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
      }
      if (layerId === "eez" && name === "land_mask_provider") {
        return { status: "supported", source_version: "v12", capability_version: "v2", tile_template: "/{z}/{x}/{y}" };
      }
      return null;
    },
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage() {},
        getImageData: () => ({ data: pixels }),
      }),
    }),
    imageLoader: async () => ({}),
  });

  await service.refresh("contract");
  const snapshot = service.snapshot();

  assert.equal(snapshot.schema, "rrkal.spatial_validity_mask.v1");
  assert.equal(snapshot.maskId, "eez");
  assert.equal(snapshot.maskVersion, "v12:v2");
  assert.equal(snapshot.sampleLand(0, 0), true);
  assert.equal(snapshot.sampleOcean(1, 0), true);
  assert.equal(snapshot.sampleSegmentLand(0, 0, 1, 0), true);
  assert.equal(snapshot.sampleLand(3, 0), null);
});

test("non-marine layers do not load EEZ domain tiles", async () => {
  const SpatialLandMaskServiceCore = loadService();
  let loads = 0;
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {}, getZoom: () => 2, getSize: () => ({ x: 1, y: 1 }),
      getPixelBounds: () => ({ min: point(0, 0), max: point(0, 0) }),
    },
    targetState: { dataLayer: "land-data" },
    capabilityProvider: () => ({ status: "unsupported" }),
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }) }),
    imageLoader: async () => { loads += 1; return {}; },
  });

  await service.refresh("test");

  assert.equal(service.snapshot().status, "DISABLED");
  assert.equal(loads, 0);
});

test("tile planning treats the pixel maximum as an exclusive boundary", () => {
  const SpatialLandMaskServiceCore = loadService();
  const service = new SpatialLandMaskServiceCore({
    targetMap: { on() {}, off() {} },
    targetState: {},
    capabilityProvider: () => null,
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => ({ getContext: () => ({}) }),
    imageLoader: async () => ({}),
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(service.tileCoordinates(2, { min: point(0, 0), max: point(512, 512) }))),
    [
      { x: 0, y: 0, wrappedX: 0, zoom: 2 },
      { x: 1, y: 0, wrappedX: 1, zoom: 2 },
      { x: 0, y: 1, wrappedX: 0, zoom: 2 },
      { x: 1, y: 1, wrappedX: 1, zoom: 2 },
    ],
  );
});

test("mask tile requests respect the provider concurrency capacity", async () => {
  const SpatialLandMaskServiceCore = loadService();
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  const started = [];
  const pending = [];
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {},
      getZoom: () => 2,
      getSize: () => ({ x: 512, y: 512 }),
      getPixelBounds: () => ({ min: point(0, 0), max: point(512, 512) }),
    },
    targetState: { dataLayer: "temperature" },
    capabilityProvider: (layerId, name) => {
      if (layerId === "temperature" && name === "land_mask_consumer") {
        return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
      }
      if (layerId === "eez" && name === "land_mask_provider") {
        return {
          status: "supported",
          source_version: "v12",
          capability_version: "v6",
          tile_template: "/{z}/{x}/{y}",
          tile_request_concurrency: 2,
        };
      }
      return null;
    },
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => ({
      width: 0, height: 0,
      getContext: () => ({ clearRect() {}, drawImage() {} }),
    }),
    imageLoader: (url) => new Promise((resolve) => {
      activeLoads += 1;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      started.push(url);
      pending.push(() => {
        activeLoads -= 1;
        resolve({ url });
      });
    }),
  });

  const refresh = service.refresh("capacity");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 2);
  assert.equal(maximumActiveLoads, 2);

  pending.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 4);
  assert.equal(maximumActiveLoads, 2);

  pending.splice(0).forEach((resolve) => resolve());
  await refresh;
  assert.equal(service.snapshot().status, "READY");
});

test("a superseded mask failure cannot overwrite the latest successful generation", async () => {
  const SpatialLandMaskServiceCore = loadService();
  let zoom = 2;
  let pixelBounds = { min: point(0, 0), max: point(256, 256) };
  const pending = [];
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {},
      getZoom: () => zoom,
      getSize: () => ({ x: 256, y: 256 }),
      getPixelBounds: () => pixelBounds,
    },
    targetState: { dataLayer: "temperature" },
    capabilityProvider: (layerId, name) => {
      if (layerId === "temperature" && name === "land_mask_consumer") {
        return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
      }
      if (layerId === "eez" && name === "land_mask_provider") {
        return { status: "supported", source_version: "v12", capability_version: "v2", tile_template: "/{z}/{x}/{y}" };
      }
      return null;
    },
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => ({
      width: 0, height: 0,
      getContext: () => ({ clearRect() {}, drawImage() {} }),
    }),
    imageLoader: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
  });

  const first = service.refresh("first");
  await new Promise((resolve) => setImmediate(resolve));
  zoom = 3;
  pixelBounds = { min: point(256, 256), max: point(512, 512) };
  const second = service.refresh("second");
  await new Promise((resolve) => setImmediate(resolve));
  const latest = pending.at(-1);
  latest.resolve({ url: latest.url });
  await second;
  pending[0].reject(new Error("late old failure"));
  await first;

  assert.equal(service.snapshot().status, "READY");
  assert.equal(service.snapshot().revision, 1);
  assert.match(service.snapshot().scopeSignature, /:3:/);
});

test("mask tile loading is single-flight across viewport epochs", async () => {
  const SpatialLandMaskServiceCore = loadService();
  let loads = 0;
  let resolveImage;
  const imagePromise = new Promise((resolve) => { resolveImage = resolve; });
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {}, getZoom: () => 2, getSize: () => ({ x: 256, y: 256 }),
      getPixelBounds: () => ({ min: point(0, 0), max: point(256, 256) }),
    },
    targetState: { dataLayer: "temperature" },
    capabilityProvider: (layerId, name) => {
      if (layerId === "temperature" && name === "land_mask_consumer") {
        return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
      }
      if (layerId === "eez" && name === "land_mask_provider") {
        return { status: "supported", source_version: "v12", capability_version: "v2", tile_template: "/{z}/{x}/{y}" };
      }
      return null;
    },
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: { schedule: () => 1, cancel() {} },
    canvasFactory: () => ({
      width: 0, height: 0,
      getContext: () => ({ clearRect() {}, drawImage() {} }),
    }),
    imageLoader: (url) => {
      loads += 1;
      return imagePromise.then(() => ({ url }));
    },
  });

  const first = service.refresh("first");
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.refresh("second");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(loads, 1);
  resolveImage();
  await Promise.all([first, second]);
  assert.equal(service.snapshot().status, "READY");
  assert.equal(service.snapshot().revision, 1);
});

test("a current mask image timeout becomes a terminal failed snapshot", async () => {
  const SpatialLandMaskServiceCore = loadService();
  const timers = new Map();
  const timerDelays = [];
  let nextTimer = 0;
  const service = new SpatialLandMaskServiceCore({
    targetMap: {
      on() {}, off() {}, getZoom: () => 2, getSize: () => ({ x: 256, y: 256 }),
      getPixelBounds: () => ({ min: point(0, 0), max: point(256, 256) }),
    },
    targetState: { dataLayer: "temperature" },
    capabilityProvider: (layerId, name) => {
      if (layerId === "temperature") {
        return { status: "supported", provider_layer_id: "eez", provider_capability: "land_mask_provider" };
      }
      if (name === "land_mask_provider") {
        return {
          status: "supported",
          source_version: "v12",
          capability_version: "v2",
          tile_template: "/{z}/{x}/{y}",
          tile_timeout_ms: 45000,
        };
      }
      return null;
    },
    eventTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    renderClock: { request: () => 1, cancel() {} },
    timeoutClock: {
      schedule(callback, delay) {
        const id = ++nextTimer;
        timerDelays.push(delay);
        timers.set(id, callback);
        return id;
      },
      cancel(id) { timers.delete(id); },
    },
    imageTimeoutMs: 250,
    canvasFactory: () => ({ getContext: () => ({ clearRect() {}, drawImage() {} }) }),
    imageLoader: () => new Promise(() => {}),
  });

  const refresh = service.refresh("timeout");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timerDelays, [45000]);
  for (const callback of [...timers.values()]) callback();
  await assert.rejects(refresh, { name: "TimeoutError" });
  assert.equal(service.snapshot().status, "FAILED");
});
