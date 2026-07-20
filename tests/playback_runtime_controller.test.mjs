import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadRuntimeController() {
  const context = { Map, Math, Number, Object, Promise, String, TypeError };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  for (const file of [
    "static/js/playback/playback-scheduler.js",
    "static/js/playback/playback-runtime-controller.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  return {
    PlaybackRuntimeController: context.PlaybackRuntimeController,
    scheduler: context.PlaybackScheduler,
  };
}

function fixture() {
  const { PlaybackRuntimeController, scheduler } = loadRuntimeController();
  const calls = [];
  const tasks = new Map();
  let nextTaskId = 0;
  let now = 1000;
  let status = "IDLE";
  const clock = {
    cancel(id) {
      if (id != null) tasks.delete(id);
    },
    now: () => now,
    schedule(callback, delayMs) {
      const id = ++nextTaskId;
      tasks.set(id, { callback, delayMs });
      return id;
    },
  };
  const engine = {
    configure(value) {
      calls.push(["configure", value]);
    },
    async start() {
      status = "PLAYING";
      calls.push(["engine-start"]);
      return true;
    },
    stop(reason) {
      calls.push(["engine-stop", reason]);
      status = reason === "ended" ? "ENDED" : "IDLE";
    },
    snapshot: () => ({ status, runId: status === "IDLE" ? "" : "run-1" }),
    frameDecision(value) {
      calls.push(["frame-decision", value]);
      return { state: "ready", canRender: true };
    },
    updatePlaybackRate(value) {
      calls.push(["rate", value]);
    },
  };
  const preheater = {
    reconcile(options) {
      calls.push(["preheater-reconcile", options]);
    },
    stop(reason) {
      calls.push(["preheater-stop", reason]);
    },
  };
  let configuredScope = "";
  const frameIdentity = {
    normalizeRequest(request = {}) {
      return { ...request };
    },
    scopeKey(request = {}) {
      return String(request.bbox || "");
    },
  };
  const originalConfigure = engine.configure;
  engine.configure = (value) => {
    configuredScope = frameIdentity.scopeKey(value?.requestContext);
    originalConfigure(value);
  };
  engine.snapshot = () => ({
    status,
    runId: status === "IDLE" ? "" : "run-1",
    scopeKey: configuredScope,
  });
  const runtime = new PlaybackRuntimeController({ clock, engine, preheater, scheduler, frameIdentity });
  return {
    calls,
    clock,
    engine,
    preheater,
    runtime,
    tasks,
    advance(ms) {
      now += ms;
    },
  };
}

test("PlaybackRuntimeController owns timeline and timer until terminal playback", async () => {
  const target = fixture();
  let terminalReason = "";
  const started = await target.runtime.start({
    configure: { dates: ["2020-01-01", "2020-01-02"] },
    engineOptions: { rate: 1 },
    rate: 1,
    intervalMs: 100,
    stepMode: "sequential",
    currentIndexProvider: () => 0,
    datesLengthProvider: () => 2,
    onFrameDue: async ({ targetIndex }) => {
      assert.equal(targetIndex, 1);
      return { advanced: false, done: true };
    },
    onTerminal: ({ reason }) => { terminalReason = reason; },
  });

  assert.equal(started, true);
  assert.equal(target.runtime.snapshot().hasTimer, true);
  assert.ok(target.runtime.snapshot().timeline);
  const task = [...target.tasks.values()][0];
  await task.callback();
  assert.equal(terminalReason, "ended");
  assert.equal(target.runtime.snapshot().hasTimer, false);
  assert.equal(target.runtime.snapshot().timeline, null);
  assert.deepEqual(target.calls.at(-1), ["engine-stop", "ended"]);
});

test("late sequential callbacks reanchor cadence instead of replaying wall-clock debt", async () => {
  const target = fixture();
  let currentIndex = 0;
  await target.runtime.start({
    configure: { dates: ["2020-01-01", "2020-01-02", "2020-01-03"] },
    engineOptions: {},
    rate: 1,
    intervalMs: 100,
    stepMode: "sequential",
    currentIndexProvider: () => currentIndex,
    datesLengthProvider: () => 3,
    onFrameDue: async () => {
      currentIndex += 1;
      return { advanced: true };
    },
  });

  const firstTask = [...target.tasks.values()][0];
  target.advance(5_000);
  await firstTask.callback();

  const nextTask = [...target.tasks.values()].at(-1);
  assert.equal(currentIndex, 1);
  assert.equal(nextTask.delayMs, 100);
  assert.equal(target.runtime.snapshot().timeline.nextFrameNumber, 2);
});

test("scope shutdown stops the producer before ending the playback run", async () => {
  const target = fixture();
  await target.runtime.start({
    configure: { dates: ["2020-01-01", "2020-01-02"] },
    engineOptions: {},
    rate: 1,
    intervalMs: 100,
    stepMode: "sequential",
    currentIndexProvider: () => 0,
    datesLengthProvider: () => 2,
    onFrameDue: async () => ({ advanced: true }),
  });

  target.runtime.stop({ clearPreheater: true, reason: "dataset_changed" });
  const stopCalls = target.calls.filter(([name]) => name.endsWith("stop"));
  assert.deepEqual(stopCalls, [
    ["preheater-stop", "dataset_changed"],
    ["engine-stop", "dataset_changed"],
  ]);
  assert.equal(target.runtime.snapshot().active, false);
});

test("rate changes rebuild the owned timeline without exposing state mirrors", async () => {
  const target = fixture();
  await target.runtime.start({
    configure: { dates: ["2020-01-01", "2020-01-02"] },
    engineOptions: {},
    rate: 1,
    intervalMs: 100,
    stepMode: "sequential",
    currentIndexProvider: () => 0,
    datesLengthProvider: () => 2,
    onFrameDue: async () => ({ advanced: true }),
  });
  const previousTimeline = target.runtime.snapshot().timeline;

  assert.equal(target.runtime.updateRate({
    consumptionRate: 4,
    intervalMs: 50,
    rate: 2,
    stepMode: "sequential",
  }), true);
  const nextTimeline = target.runtime.snapshot().timeline;
  assert.equal(nextTimeline.intervalMs, 50);
  assert.equal(nextTimeline.rate, 2);
  assert.notEqual(nextTimeline.startedAt, previousTimeline.startedAt);
  assert.deepEqual(JSON.parse(JSON.stringify(target.calls.at(-1))), ["rate", {
    consumption_rate: 4,
    interval_ms: 50,
    rate: 2,
  }]);
});

test("scope replacement invalidates an old callback and reanchors one owned timeline", async () => {
  const target = fixture();
  let currentIndex = 0;
  let releaseOldFrame;
  const oldFrame = new Promise((resolve) => { releaseOldFrame = resolve; });
  await target.runtime.start({
    configure: {
      dates: ["2020-01-01", "2020-01-02", "2020-01-03"],
      requestContext: { bbox: "100,10,110,20" },
      currentDate: "2020-01-01",
    },
    engineOptions: {},
    rate: 1,
    intervalMs: 100,
    stepMode: "sequential",
    currentIndexProvider: () => currentIndex,
    datesLengthProvider: () => 3,
    onFrameDue: async () => {
      await oldFrame;
      currentIndex += 1;
      return { advanced: true };
    },
  });

  const oldGeneration = target.runtime.snapshot().generation;
  const [oldTaskId, oldTask] = [...target.tasks.entries()][0];
  target.tasks.delete(oldTaskId);
  const oldCallback = oldTask.callback();
  target.runtime.configure({
    dates: ["2020-01-01", "2020-01-02", "2020-01-03"],
    requestContext: { bbox: "120,10,130,20" },
    currentDate: "2020-01-01",
  });

  const replaced = target.runtime.snapshot();
  assert.equal(replaced.generation, oldGeneration + 1);
  assert.equal(replaced.hasTimer, true);
  assert.equal(target.tasks.size, 1);
  assert.equal(replaced.timeline.baseDateIndex, 0);
  releaseOldFrame();
  await oldCallback;
  assert.equal(target.tasks.size, 1);
  assert.equal(target.runtime.snapshot().generation, oldGeneration + 1);
});

test("visibility suspension preserves playback intent and reanchors the timeline on resume", async () => {
  const target = fixture();
  let currentIndex = 0;
  await target.runtime.start({
    configure: { dates: ["2020-01-01", "2020-01-02", "2020-01-03"] },
    engineOptions: {},
    rate: 1,
    intervalMs: 100,
    stepMode: "sequential",
    currentIndexProvider: () => currentIndex,
    datesLengthProvider: () => 3,
    onFrameDue: async () => ({ advanced: true }),
  });

  assert.equal(target.runtime.suspend({ reason: "document_hidden" }), true);
  assert.equal(target.runtime.snapshot().active, true);
  assert.equal(target.runtime.snapshot().suspended, true);
  assert.equal(target.runtime.snapshot().hasTimer, false);
  assert.deepEqual(target.calls.filter(([name]) => name.endsWith("stop")), []);

  target.advance(5000);
  currentIndex = 1;
  assert.equal(target.runtime.resume({ reason: "document_hidden" }), true);
  const snapshot = target.runtime.snapshot();
  assert.equal(snapshot.suspended, false);
  assert.equal(snapshot.hasTimer, true);
  assert.equal(snapshot.timeline.baseDateIndex, 1);
  assert.equal(snapshot.timeline.startedAt, 6000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(target.calls.at(-1))),
    ["preheater-reconcile", { force: true }],
  );
});

test("nested visibility reasons resume only after every owner releases suspension", async () => {
  const target = fixture();
  await target.runtime.start({
    configure: { dates: ["2020-01-01", "2020-01-02"] },
    engineOptions: {},
    rate: 1,
    intervalMs: 100,
    stepMode: "sequential",
    currentIndexProvider: () => 0,
    datesLengthProvider: () => 2,
    onFrameDue: async () => ({ advanced: true }),
  });

  target.runtime.suspend({ reason: "document_hidden" });
  assert.equal(target.runtime.suspend({ reason: "dashboard_hidden" }), false);
  assert.deepEqual(
    [...target.runtime.snapshot().suspensionReasons].sort(),
    ["dashboard_hidden", "document_hidden"],
  );
  assert.equal(target.runtime.resume({ reason: "document_hidden" }), false);
  assert.equal(target.runtime.snapshot().hasTimer, false);
  assert.equal(target.runtime.resume({ reason: "dashboard_hidden" }), true);
  assert.equal(target.runtime.snapshot().hasTimer, true);
});

test("playback controls no longer own timer, generation or timeline state", () => {
  const controls = fs.readFileSync(path.join(root, "static/js/playback/playback-controls.js"), "utf8");
  const state = fs.readFileSync(path.join(root, "static/js/core/state.js"), "utf8");
  const playbackCacheBlock = state.slice(
    state.indexOf("playbackCache:"),
    state.indexOf("playbackDelivery:"),
  );
  assert.doesNotMatch(controls, /state\.playTimer|state\.playbackCache\.(?:generation|timeline)/);
  assert.doesNotMatch(state, /playTimer:\s*/);
  assert.doesNotMatch(playbackCacheBlock, /\b(?:generation|timeline):/);
});

test("PlaybackRuntime is the only UI facade for PlaybackEngine commands", () => {
  const controls = fs.readFileSync(path.join(root, "static/js/playback/playback-controls.js"), "utf8");
  const apiClient = fs.readFileSync(path.join(root, "static/js/services/api-client.js"), "utf8");
  const layerEffects = fs.readFileSync(path.join(root, "static/js/layers/sampled-grid-layer-effects.js"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "static/js/playback/playback-runtime-controller.js"), "utf8");

  for (const source of [controls, apiClient, layerEffects]) {
    assert.doesNotMatch(source, /PlaybackEngine\./);
  }
  for (const method of [
    "lifecycleSnapshot",
    "configure",
    "inspectTarget",
    "requireTarget",
    "frameDecision",
    "bufferGate",
    "bufferWaitMs",
    "markRenderStarted",
    "markFrameVisible",
    "releaseDisplayedFrame",
    "suspend",
    "resume",
  ]) {
    assert.match(runtime, new RegExp(`\\b${method}\\s*\\(`));
  }
});
