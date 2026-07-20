import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadPool() {
  const context = vm.createContext({});
  context.globalThis = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/services/sampled-grid-layer-pool.js"), "utf8"),
    context,
  );
  return context.SampledGridLayerPoolCore;
}

test("sampled-grid layer pool reuses two renderer resources", () => {
  const SampledGridLayerPoolCore = loadPool();
  const attached = new Set();
  const targetMap = {
    hasLayer: (layer) => attached.has(layer),
    removeLayer: (layer) => attached.delete(layer),
  };
  const targetState = { gridLayer: null, sampledGridRetiringLayers: [] };
  const effects = {
    setLayerOpacity(layer, opacity) {
      layer.opacity = opacity;
    },
  };
  let created = 0;
  class WebglLayer {
    setActive(active) { this.active = Boolean(active); }
  }
  const pool = new SampledGridLayerPoolCore({
    targetMap,
    targetState,
    layerEffects: effects,
    layerFactory: (LayerClass) => {
      created += 1;
      const layer = new LayerClass();
      attached.add(layer);
      return layer;
    },
  });

  const first = pool.acquire(WebglLayer);
  pool.activate(first);
  const second = pool.acquire(WebglLayer);
  pool.activate(second);
  const reused = pool.acquire(WebglLayer);

  assert.equal(reused, first);
  assert.equal(first.active, false);
  assert.equal(second.active, true);
  assert.equal(created, 2);
  assert.equal(pool.snapshot().size, 2);
  assert.equal(attached.size, 2);

  pool.clear();
  assert.equal(attached.size, 0);
  assert.equal(targetState.gridLayer, null);
  assert.equal(targetState.sampledGridRetiringLayers.length, 0);
});

test("sampled-grid layer pool replaces only the inactive renderer backend", () => {
  const SampledGridLayerPoolCore = loadPool();
  const attached = new Set();
  const targetMap = {
    hasLayer: (layer) => attached.has(layer),
    removeLayer: (layer) => attached.delete(layer),
  };
  const targetState = { gridLayer: null };
  const effects = { setLayerOpacity: (layer, opacity) => { layer.opacity = opacity; } };
  class WebglLayer { setActive(active) { this.active = Boolean(active); } }
  class CanvasLayer { setActive(active) { this.active = Boolean(active); } }
  class ReplacementLayer { setActive(active) { this.active = Boolean(active); } }
  const pool = new SampledGridLayerPoolCore({
    targetMap,
    targetState,
    layerEffects: effects,
    layerFactory: (LayerClass) => {
      const layer = new LayerClass();
      attached.add(layer);
      return layer;
    },
  });

  const active = pool.acquire(WebglLayer);
  pool.activate(active);
  const inactive = pool.acquire(CanvasLayer);
  const replacement = pool.acquire(ReplacementLayer, { currentLayer: active });

  assert.equal(targetMap.hasLayer(active), true);
  assert.equal(targetMap.hasLayer(inactive), false);
  assert.equal(targetMap.hasLayer(replacement), true);
  assert.equal(pool.snapshot().size, 2);
});

test("land-mask updates rebuild one immutable transaction for the active renderer", () => {
  const SampledGridLayerPoolCore = loadPool();
  const attached = new Set();
  let maskListener = null;
  const landMaskProvider = {
    subscribe(listener) {
      maskListener = listener;
      return () => { maskListener = null; };
    },
  };
  const targetMap = {
    hasLayer: (layer) => attached.has(layer),
    removeLayer: (layer) => attached.delete(layer),
  };
  const targetState = { gridLayer: null };
  class WebglLayer { setActive(active) { this.active = Boolean(active); } }
  const recoveries = [];
  const pool = new SampledGridLayerPoolCore({
    targetMap,
    targetState,
    landMaskProvider,
    recoverActiveLayer(layer, detail) { recoveries.push({ layer, detail }); },
    layerEffects: { setLayerOpacity() {} },
    layerFactory: (LayerClass) => {
      const layer = new LayerClass();
      attached.add(layer);
      return layer;
    },
  });
  const first = pool.acquire(WebglLayer);
  pool.activate(first);
  const second = pool.acquire(WebglLayer);

  maskListener({ ready: false });
  maskListener({ ready: true, revision: 1 });

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].layer, first);
  assert.equal(recoveries[0].detail.reason, "land_mask_ready");
  assert.equal(recoveries[0].detail.snapshot.revision, 1);
  assert.notEqual(recoveries[0].layer, second);
  pool.dispose();
  assert.equal(maskListener, null);
});

test("an active WebGL context loss schedules one cache-only renderer recovery", () => {
  const SampledGridLayerPoolCore = loadPool();
  const attached = new Set();
  let capabilityListener = null;
  let scheduled = null;
  let recoveries = 0;
  const targetMap = {
    hasLayer: (layer) => attached.has(layer),
    removeLayer: (layer) => attached.delete(layer),
  };
  const targetState = { gridLayer: null };
  class WebglLayer {
    constructor() { this._rendererId = "renderer-1"; }
    setActive(active) { this.active = Boolean(active); }
  }
  const pool = new SampledGridLayerPoolCore({
    targetMap,
    targetState,
    layerEffects: { setLayerOpacity() {} },
    layerFactory: (LayerClass) => {
      const layer = new LayerClass();
      attached.add(layer);
      return layer;
    },
    rendererCapabilityState: {
      subscribe(listener) { capabilityListener = listener; return () => { capabilityListener = null; }; },
    },
    renderClock: {
      request(callback) { scheduled = callback; return 1; },
      cancel() { scheduled = null; },
    },
    recoverActiveLayer() { recoveries += 1; },
  });
  const active = pool.acquire(WebglLayer);
  pool.activate(active);

  capabilityListener({}, { reason: "context_lost", detail: { rendererId: "renderer-1" } });
  capabilityListener({}, { reason: "context_lost", detail: { rendererId: "renderer-1" } });
  assert.equal(typeof scheduled, "function");
  scheduled();
  assert.equal(recoveries, 1);

  pool.dispose();
  assert.equal(capabilityListener, null);
});

test("pool rebases a prepared layer before making it active", () => {
  const SampledGridLayerPoolCore = loadPool();
  const attached = new Set();
  const events = [];
  const targetMap = {
    hasLayer: (layer) => attached.has(layer),
    removeLayer: (layer) => attached.delete(layer),
  };
  const targetState = { gridLayer: null };
  class CanvasLayer {
    setActive(active) { events.push(`active:${active}`); this.active = Boolean(active); }
    syncViewport() { events.push("sync"); }
  }
  const pool = new SampledGridLayerPoolCore({
    targetMap,
    targetState,
    layerEffects: { setLayerOpacity() {}, invalidate() { events.push("invalidate"); } },
    layerFactory: (LayerClass) => {
      const item = new LayerClass();
      attached.add(item);
      return item;
    },
  });
  const active = pool.acquire(CanvasLayer);
  events.length = 0;

  pool.activate(active);

  assert.deepEqual(events, ["invalidate", "active:false", "sync", "active:true"]);
});

test("scope invalidation clears every pooled render context and advances the epoch", () => {
  const SampledGridLayerPoolCore = loadPool();
  const attached = new Set();
  const targetMap = {
    hasLayer: (layer) => attached.has(layer),
    removeLayer: (layer) => attached.delete(layer),
  };
  const targetState = { gridLayer: null, renderedSampledGridDate: "2020-01-01" };
  const invalidated = [];
  class CanvasLayer {
    setActive(active) { this.active = Boolean(active); }
    syncViewport() {}
    invalidateRenderContext(reason) { invalidated.push(reason); }
  }
  const pool = new SampledGridLayerPoolCore({
    targetMap,
    targetState,
    layerEffects: {
      setLayerOpacity(layer, opacity) { layer.opacity = opacity; },
      invalidate() {},
    },
    layerFactory: (LayerClass) => {
      const item = new LayerClass();
      attached.add(item);
      return item;
    },
  });
  const active = pool.acquire(CanvasLayer);
  pool.activate(active);
  const inactive = pool.acquire(CanvasLayer);
  const previousEpoch = pool.snapshot().renderEpoch;

  assert.equal(pool.invalidateActiveContext("viewport_scope_changed"), true);
  assert.deepEqual(invalidated, ["viewport_scope_changed", "viewport_scope_changed"]);
  assert.equal(active.opacity, 0);
  assert.equal(inactive.opacity, 0);
  assert.equal(active.active, false);
  assert.equal(inactive.active, false);
  assert.equal(pool.snapshot().renderEpoch, previousEpoch + 1);
  assert.equal(targetState.renderedSampledGridDate, null);
});

test("render epochs reject stale frame and mask transactions", () => {
  const SampledGridLayerPoolCore = loadPool();
  const pool = new SampledGridLayerPoolCore({
    targetMap: { hasLayer: () => false, removeLayer() {} },
    targetState: { gridLayer: null },
    layerEffects: { setLayerOpacity() {}, invalidate() {} },
    layerFactory: () => ({}),
  });

  const first = pool.beginRenderTransaction("first");
  const second = pool.beginRenderTransaction("second");

  assert.equal(pool.isRenderEpochCurrent(first), false);
  assert.equal(pool.isRenderEpochCurrent(second), true);
});

test("land-mask readiness commits only the latest pending frame transaction", async () => {
  const SampledGridLayerPoolCore = loadPool();
  let maskListener = null;
  const committed = [];
  const pool = new SampledGridLayerPoolCore({
    targetMap: { hasLayer: () => false, removeLayer() {} },
    targetState: { gridLayer: null },
    layerEffects: { setLayerOpacity() {}, invalidate() {} },
    layerFactory: () => ({}),
    landMaskProvider: {
      subscribe(listener) { maskListener = listener; return () => { maskListener = null; }; },
    },
    commitPendingRender(pending) {
      committed.push(pending.identity.date);
      return { deferred: false, rowCount: pending.frame.rowCount };
    },
  });
  const first = pool.stagePendingRender({
    frame: { rowCount: 1 },
    requestContext: { date: "2020-01-01" },
    identity: { scopeKey: "scope-a", date: "2020-01-01" },
  });
  const second = pool.stagePendingRender({
    frame: { rowCount: 1 },
    requestContext: { date: "2020-01-02" },
    identity: { scopeKey: "scope-a", date: "2020-01-02" },
  });

  assert.equal((await first.completion).status, "cancelled");
  maskListener({ ready: true, revision: 3 });
  const completed = await second.completion;

  assert.deepEqual(committed, ["2020-01-02"]);
  assert.equal(completed.status, "committed");
  assert.equal(pool.snapshot().pendingIdentity, null);
});

test("scope invalidation cancels a pending masked frame", async () => {
  const SampledGridLayerPoolCore = loadPool();
  const pool = new SampledGridLayerPoolCore({
    targetMap: { hasLayer: () => false, removeLayer() {} },
    targetState: { gridLayer: null },
    layerEffects: { setLayerOpacity() {}, invalidate() {} },
    layerFactory: () => ({}),
  });
  const pending = pool.stagePendingRender({
    frame: { rowCount: 1 },
    requestContext: { date: "2020-01-01" },
    identity: { scopeKey: "scope-a", date: "2020-01-01" },
  });

  pool.invalidateActiveContext("viewport_scope_changed");

  const completion = await pending.completion;
  assert.equal(completion.status, "cancelled");
  assert.equal(completion.reason, "viewport_scope_changed");
  assert.equal(pool.snapshot().pendingIdentity, null);
});

test("a failed mask settles the pending frame instead of leaving it fetching forever", async () => {
  const SampledGridLayerPoolCore = loadPool();
  let maskListener = null;
  const pool = new SampledGridLayerPoolCore({
    targetMap: { hasLayer: () => false, removeLayer() {} },
    targetState: { gridLayer: null },
    layerEffects: { setLayerOpacity() {}, invalidate() {} },
    layerFactory: () => ({}),
    landMaskProvider: {
      subscribe(listener) { maskListener = listener; return () => { maskListener = null; }; },
    },
  });
  const pending = pool.stagePendingRender({
    frame: { rowCount: 1 },
    requestContext: { date: "2020-01-01" },
    identity: { scopeKey: "scope-a", date: "2020-01-01" },
  });

  maskListener({ ready: false, status: "FAILED" });
  const completion = await pending.completion;

  assert.equal(completion.status, "cancelled");
  assert.equal(completion.reason, "land_mask_failed");
});
