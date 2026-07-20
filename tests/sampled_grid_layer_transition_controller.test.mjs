import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadController() {
  const context = vm.createContext({});
  context.globalThis = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/layers/sampled-grid-layer-effects.js"), "utf8"),
    context,
  );
  return context.SampledGridLayerTransitionControllerCore;
}

function fakeClock() {
  let serial = 0;
  const frames = new Map();
  const timers = new Map();
  return {
    frames,
    timers,
    now: () => 0,
    request(callback) {
      const handle = ++serial;
      frames.set(handle, callback);
      return handle;
    },
    cancel(handle) { frames.delete(handle); },
    schedule(callback) {
      const handle = ++serial;
      timers.set(handle, callback);
      return handle;
    },
    cancelSchedule(handle) { timers.delete(handle); },
    flushFrames() {
      while (frames.size) {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback();
      }
    },
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function layer(name) {
  return { name, _canvas: { style: {} } };
}

test("a superseded crossfade cannot mutate a reused layer", () => {
  const Controller = loadController();
  const clock = fakeClock();
  const pane = { style: {} };
  const first = layer("first");
  const second = layer("second");
  const attached = new Set([first, second]);
  const targetState = {
    gridLayer: second,
    sampledGridTransitionMs: 180,
    sampledGridZoomBlurPx: 2,
    sampledGridRetiringLayers: [],
  };
  const controller = new Controller({
    targetMap: {
      getPane: () => pane,
      hasLayer: (candidate) => attached.has(candidate),
      removeLayer: (candidate) => attached.delete(candidate),
    },
    targetState,
    renderClock: clock,
  });

  controller.crossfade({ previousLayer: first, nextLayer: second, retainPrevious: true });
  const staleFrames = [...clock.frames.values()];
  const staleTimers = [...clock.timers.values()];

  targetState.gridLayer = first;
  controller.crossfade({ previousLayer: second, nextLayer: first, retainPrevious: true });
  for (const callback of [...staleFrames, ...staleTimers]) callback();
  clock.flushFrames();
  clock.flushTimers();

  assert.equal(first._canvas.style.opacity, "1");
  assert.equal(second._canvas.style.opacity, "0");
  assert.equal(controller.frameHandles.size, 0);
  assert.equal(controller.timerHandles.size, 0);
});

test("transition invalidation cancels every owned render callback", () => {
  const Controller = loadController();
  const clock = fakeClock();
  const active = layer("active");
  const targetState = { gridLayer: active, sampledGridTransitionMs: 100 };
  const controller = new Controller({
    targetMap: {
      getPane: () => ({ style: {} }),
      hasLayer: () => true,
      removeLayer() {},
    },
    targetState,
    renderClock: clock,
  });
  controller.crossfade({ previousLayer: layer("old"), nextLayer: active });
  assert.ok(clock.frames.size > 0);
  assert.ok(clock.timers.size > 0);

  controller.invalidate("scope_changed");

  assert.equal(clock.frames.size, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(active._canvas.style.opacity, "1");
});
