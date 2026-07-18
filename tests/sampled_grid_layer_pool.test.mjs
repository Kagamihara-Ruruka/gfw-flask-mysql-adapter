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
  class WebglLayer {}
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
  targetState.gridLayer = first;
  const second = pool.acquire(WebglLayer);
  targetState.gridLayer = second;
  const reused = pool.acquire(WebglLayer);

  assert.equal(reused, first);
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
  class WebglLayer {}
  class CanvasLayer {}
  class ReplacementLayer {}
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
  targetState.gridLayer = active;
  const inactive = pool.acquire(CanvasLayer);
  const replacement = pool.acquire(ReplacementLayer, { currentLayer: active });

  assert.equal(targetMap.hasLayer(active), true);
  assert.equal(targetMap.hasLayer(inactive), false);
  assert.equal(targetMap.hasLayer(replacement), true);
  assert.equal(pool.snapshot().size, 2);
});
