import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadOwner() {
  const context = vm.createContext({});
  context.globalThis = context;
  context.CustomEvent = class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  };
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/services/renderer-capability-state.js"), "utf8"),
    context,
  );
  return context.RendererCapabilityStateCore;
}

test("renderer capability owner tracks probe, policy and WebGL context lifecycle", () => {
  const RendererCapabilityStateCore = loadOwner();
  const listeners = new Map();
  const state = {};
  let now = 100;
  const events = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
  };
  const owner = new RendererCapabilityStateCore({
    targetState: state,
    eventTarget: events,
    clock: { now: () => now },
  }).mount();
  owner.install({
    server: { status: "ready", policy: { hardware_acceleration: "auto", allow_webgl: true } },
    browser: { webgl: { available: true, context: "webgl2" }, webgpu: { available: false } },
  });

  assert.equal(owner.snapshot().runtime.webgl.available, true);
  now = 150;
  events.dispatchEvent({
    type: "rrkal:sampled-grid-webgl-context-changed",
    detail: { status: "lost", rendererId: "renderer-1", layerId: "temperature", active: true },
  });
  assert.equal(owner.snapshot().runtime.webgl.status, "lost");
  assert.equal(state.renderCapability.runtime.webgl.available, false);

  owner.setHardwareMode("off");
  assert.equal(owner.snapshot().policy.force_cpu, true);
  events.dispatchEvent({
    type: "rrkal:sampled-grid-webgl-context-changed",
    detail: { status: "disposed", rendererId: "renderer-1" },
  });
  assert.equal(owner.snapshot().runtime.webgl.status, "available");

  owner.dispose();
  assert.equal(listeners.has("rrkal:sampled-grid-webgl-context-changed"), false);
});
