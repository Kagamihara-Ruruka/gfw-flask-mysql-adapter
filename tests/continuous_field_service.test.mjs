import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadService() {
  const context = vm.createContext({});
  context.globalThis = context;
  for (const file of [
    "static/js/core/runtime-primitives.js",
    "static/js/services/continuous-field-service.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  return context.ContinuousFieldServiceCore;
}

test("continuous field service reconstructs each frame and policy once", () => {
  const ContinuousFieldServiceCore = loadService();
  let calls = 0;
  const service = new ContinuousFieldServiceCore({
    reconstruct: (frame, paintFrame) => ({ frame, paintFrame, call: ++calls }),
    maxEntries: 2,
  });
  const frame = {};
  const context = { continuousFieldSignature: "policy-a", paintFrame: {} };

  const first = service.reconstruct(frame, context);
  const second = service.reconstruct(frame, context);

  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(service.snapshot().entries, 1);
});

test("continuous field service bounds derived fields independently of frame storage", () => {
  const ContinuousFieldServiceCore = loadService();
  const service = new ContinuousFieldServiceCore({
    reconstruct: (_frame, paintFrame) => paintFrame,
    maxEntries: 2,
  });
  const frames = [{}, {}, {}];
  for (const [index, frame] of frames.entries()) {
    service.reconstruct(frame, { continuousFieldSignature: `policy-${index}`, paintFrame: { index } });
  }

  assert.equal(service.snapshot().entries, 2);
  service.dispose();
  assert.equal(service.snapshot().entries, 0);
  assert.throws(
    () => service.reconstruct({}, { continuousFieldSignature: "after-dispose", paintFrame: {} }),
    /disposed/,
  );
});

test("continuous field identity ignores paint alpha and render zoom", () => {
  const ContinuousFieldServiceCore = loadService();
  let calls = 0;
  const service = new ContinuousFieldServiceCore({
    reconstruct: () => ({ call: ++calls }),
  });
  const frame = {};
  const first = service.reconstruct(frame, {
    signature: "alpha-1-z6",
    continuousFieldSignature: "dataset:linear:zero-is-data",
    paintFrame: {},
  });
  const second = service.reconstruct(frame, {
    signature: "alpha-0.4-z9",
    continuousFieldSignature: "dataset:linear:zero-is-data",
    paintFrame: {},
  });

  assert.equal(first, second);
  assert.equal(calls, 1);
});

test("continuous field identity includes the spatial validity mask generation", () => {
  const ContinuousFieldServiceCore = loadService();
  let calls = 0;
  const service = new ContinuousFieldServiceCore({
    reconstruct: (_frame, _paintFrame, validityMask) => ({ call: ++calls, revision: validityMask.revision }),
  });
  const frame = {};
  const renderContext = { continuousFieldSignature: "dataset:linear", paintFrame: {} };
  const first = service.reconstruct(frame, renderContext, {
    ready: true, scopeSignature: "scope-z6", maskVersion: "v1", revision: 1,
  });
  const repeated = service.reconstruct(frame, renderContext, {
    ready: true, scopeSignature: "scope-z6", maskVersion: "v1", revision: 1,
  });
  const second = service.reconstruct(frame, renderContext, {
    ready: true, scopeSignature: "scope-z7", maskVersion: "v1", revision: 2,
  });

  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.equal(calls, 2);
});
