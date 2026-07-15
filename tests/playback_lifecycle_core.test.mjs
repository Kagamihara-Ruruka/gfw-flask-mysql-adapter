import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function contextFor(fetchJson) {
  const context = {
    AbortController,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    performance,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    fetchJson,
    state: {
      datasets: { ocean: { backend: "endpoint", sampled_grid: { mapping_version: "v1" } } },
      queryPolicy: { network_concurrency: 3 },
      dataFrameStore: { maxEntries: 0, maxBytes: 128 * 1024 * 1024, stats: {} },
      playbackCache: {
        watermarkStrategy: "fixed",
        highWatermark: 10,
        lowWatermark: 5,
        startupWatermark: 1,
        resumeWatermark: 2,
        windowBehind: 1,
      },
      lifecycleEvents: { maxEntries: 5000 },
    },
    SampledGridContract: { recordResolvedResolution() {} },
    document: { getElementById: () => null },
  };
  context.window = { dispatchEvent() {} };
  vm.createContext(context);
  for (const file of [
    "static/js/core/clock-domain.js",
    "static/TimingMetrics.js",
    "static/js/services/lifecycle-event-log.js",
    "static/js/services/frame-identity.js",
    "static/js/services/layer-query-coordinator.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/frame-demand-service.js",
    "static/js/playback/playback-preheater.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/adaptive-watermark-controller.js",
    "static/js/playback/playback-renderer.js",
    "static/js/services/runtime-performance-metrics.js",
    "static/js/runtime/runtime-composition-root.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  return context;
}

function api(context, name) {
  return vm.runInContext(name, context);
}

function dates(count = 15) {
  return Array.from({ length: count }, (_, index) => `2020-01-${String(index + 1).padStart(2, "0")}`);
}

function requestContext() {
  return {
    datasetId: "ocean",
    layerId: "ocean.layer",
    date: "2020-01-01",
    bbox: "120,10,130,20",
    limit: "max",
    columns: "render",
    resolution: 4,
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("preheater replenishes individual frames to the high watermark without a batch gate", async () => {
  let requestCount = 0;
  const context = contextFor(async (url) => {
    requestCount += 1;
    const date = new URL(`http://local${url}`).searchParams.get("date");
    return { rows: [{ cell_id: date, value: 1 }], row_count: 1, grid: { actual_resolution_km: 4 } };
  });
  const store = api(context, "DataFrameStore");
  const preheater = api(context, "PlaybackPreheater");
  const allDates = dates();
  store.put(requestContext(), { rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  preheater.setScope({ dates: allDates, requestContext: requestContext(), anchorDate: allDates[0] });

  await waitFor(() => preheater.snapshot().readyAhead >= 10);
  assert.equal(preheater.snapshot().readyAhead, 10);
  assert.equal(requestCount, 10);
  assert.equal(api(context, "LayerQueryCoordinator").snapshot().queued.length, 0);
});

test("watermark policy status cannot overwrite the preheater lifecycle status", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const preheater = new Preheater({
    store: { subscribe: () => () => {}, inspect: () => ({ status: "missing" }) },
    demandService: { demand: () => new Promise(() => {}), cancelScope() {} },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({ lowWatermark: 5, highWatermark: 10, windowBehind: 1 }),
    watermarkPolicyProvider: (fixedPolicy) => ({
      ...fixedPolicy,
      strategy: "adaptive",
      status: "WARMING",
    }),
  });

  preheater.setScope({ dates: dates(2), requestContext: requestContext(), anchorDate: dates(2)[0] });
  assert.equal(preheater.snapshot().status, "FETCHING");
  assert.equal(preheater.snapshot().policyStatus, "WARMING");
  preheater.stop("test_complete");
});

test("cold playback remains PREPARING until the startup watermark and does not record a stall", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const startup = deferred();
  let ready = 0;
  const engine = new Engine({
    store: {
      inspect(request) { return { status: "missing", request }; },
      pin() { return true; },
      release() { return true; },
    },
    demandService: { cancelScope() {}, demand: async () => ({ frameKey: "unused" }) },
    preheater: {
      setScope() {},
      setPlayhead() {},
      readyAhead() { return ready; },
      waitForDates: async () => {
        await startup.promise;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          startupWatermark: 3,
          resumeWatermark: 2,
          policyReason: "configured",
          degradationReason: "",
        };
      },
    },
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(5);
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  const pending = engine.start({ consumption_rate: 1 });

  assert.equal(engine.snapshot().status, "PREPARING");
  assert.equal(engine.snapshot().preparationRequired, 3);
  assert.equal(log.query({ type: "PREPARE_STARTED" }).length, 1);
  assert.equal(log.query({ type: "BUFFER_ENTERED" }).length, 0);

  ready = 3;
  startup.resolve();
  assert.equal(await pending, true);
  assert.equal(engine.snapshot().status, "PLAYING");
  assert.equal(log.query({ type: "PREPARE_READY" }).length, 1);
  assert.equal(log.summary(engine.snapshot().runId).stallCount, 0);
  engine.stop("test_complete");
});

test("buffer recovery waits for the resume watermark instead of one frame", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const targetResponse = deferred();
  const resumeWindow = deferred();
  let ready = 5;
  const engine = new Engine({
    store: {
      inspect(request) { return { status: "missing", request }; },
      pin() { return true; },
      release() { return true; },
    },
    demandService: {
      cancelScope() {},
      demand: () => targetResponse.promise,
    },
    preheater: {
      setScope() {},
      setPlayhead() {},
      readyAhead() { return ready; },
      waitForDates: async () => {
        await resumeWindow.promise;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          startupWatermark: 1,
          resumeWatermark: 3,
          policyReason: "configured",
          degradationReason: "",
        };
      },
    },
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(6);
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  await engine.start({ consumption_rate: 1 });
  ready = 0;
  const target = engine.requireTarget(1);
  targetResponse.resolve({ frameKey: "target-frame" });
  await Promise.resolve();
  ready = 1;
  assert.equal(engine.bufferGate().required, 3);
  assert.equal(engine.bufferGate().ready, false);
  assert.equal(engine.snapshot().status, "BUFFERING");

  ready = 3;
  resumeWindow.resolve();
  await target;
  assert.equal(engine.snapshot().status, "PLAYING");
  const resumed = log.query({ type: "BUFFER_RESUMED" }).at(-1);
  assert.equal(resumed.required_slices, 3);
  assert.equal(resumed.ready_slices, 3);
  engine.stop("test_complete");
});

test("playback target promotes an existing preheat request and resumes from the same result", async () => {
  const responses = new Map();
  let requests = 0;
  const context = contextFor(async (url) => {
    requests += 1;
    const date = new URL(`http://local${url}`).searchParams.get("date");
    if (!responses.has(date)) responses.set(date, deferred());
    return responses.get(date).promise;
  });
  const store = api(context, "DataFrameStore");
  const engine = api(context, "PlaybackEngine");
  const log = api(context, "LifecycleEventLog");
  const allDates = dates(4);
  store.put(requestContext(), { rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  await waitFor(() => responses.has(allDates[1]));
  const starting = engine.start();
  responses.get(allDates[1]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  await starting;
  const target = engine.requireTarget(2);
  const queuedOrActive = api(context, "LayerQueryCoordinator").snapshot();
  const targetTask = [...queuedOrActive.active, ...queuedOrActive.queued]
    .find((task) => task.metadata?.date === allDates[2]);
  assert.equal(targetTask?.lane, "playback-target");

  responses.get(allDates[2]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  responses.get(allDates[3]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  const result = await target;
  assert.equal(result.status, "ready");
  assert.equal(requests >= 1, true);
  assert.equal(log.query({ type: "TASK_PROMOTED" }).length >= 1, true);
  assert.equal(log.query({ type: "BUFFER_ENTERED" }).length, 1);
  assert.equal(log.query({ type: "BUFFER_RESUMED" }).length, 1);

  for (const response of responses.values()) response.resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  engine.stop("test_complete");
});

test("preheater rejects late callbacks when a previous signature becomes active again", async () => {
  const responses = new Map();
  const context = contextFor(async (url) => {
    const parsed = new URL(`http://local${url}`);
    const key = `${parsed.searchParams.get("bbox")}:${parsed.searchParams.get("date")}`;
    if (!responses.has(key)) responses.set(key, []);
    const run = deferred();
    responses.get(key).push(run);
    return run.promise;
  });
  const preheater = api(context, "PlaybackPreheater");
  const first = requestContext();
  const second = { ...requestContext(), bbox: "140,10,150,20" };
  const allDates = dates(3);

  preheater.setScope({ dates: allDates, requestContext: first, anchorDate: allDates[0] });
  const firstScopeId = preheater.snapshot().id;
  await waitFor(() => [...responses.keys()].some((key) => key.startsWith("120")));
  preheater.setScope({ dates: allDates, requestContext: second, anchorDate: allDates[0] });
  preheater.setScope({ dates: allDates, requestContext: first, anchorDate: allDates[0] });
  const currentScopeId = preheater.snapshot().id;

  assert.notEqual(firstScopeId, currentScopeId);
  for (const [key, runs] of responses) {
    if (!key.startsWith("120") || runs.length !== 1) continue;
    runs[0].resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(preheater.snapshot().id, currentScopeId);

  for (const runs of responses.values()) {
    for (const run of runs) run.resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  }
  preheater.stop("test_complete");
});

test("playback scope changes cancel stale targets and keep engine and preheater aligned", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const target = deferred();
  let aborted = 0;
  const preheaterScopes = [];
  const engine = new Engine({
    store: {
      inspect(request) { return { status: "missing", request, intentKey: identity.intentKey(request), frameKey: "" }; },
      pin() { return true; },
      release() { return true; },
    },
    demandService: {
      demand(_request, { signal }) {
        signal.addEventListener("abort", () => {
          aborted += 1;
          const error = new Error("cancelled");
          error.name = "AbortError";
          target.reject(error);
        }, { once: true });
        return target.promise;
      },
    },
    preheater: {
      setScope(scope) { preheaterScopes.push(scope); },
      setPlayhead() {},
      readyAhead() { return 2; },
      waitForDates: async () => ({ failed: 0 }),
      snapshot() {
        return {
          status: "READY",
          startupWatermark: 1,
          resumeWatermark: 2,
          policyReason: "configured",
        };
      },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(3);
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  await engine.start();
  const oldTarget = engine.requireTarget(1);
  engine.configure({
    dates: allDates,
    requestContext: { ...requestContext(), bbox: "140,10,150,20" },
    currentDate: allDates[0],
  });

  await assert.rejects(oldTarget, (error) => error?.name === "AbortError");
  assert.equal(aborted, 1);
  assert.equal(engine.inspectTarget(1).request.bbox, "140.000000,10.000000,150.000000,20.000000");
  assert.equal(preheaterScopes.at(-1).requestContext.bbox, "140.000000,10.000000,150.000000,20.000000");
  assert.equal(engine.snapshot().status, "PLAYING");
  assert.equal(api(context, "LifecycleEventLog").query({ type: "PLAYBACK_SCOPE_CHANGED" }).length, 1);
  assert.equal(api(context, "LifecycleEventLog").query({ type: "BUFFER_CANCELLED" }).length, 1);
  assert.equal(api(context, "LifecycleEventLog").summary(engine.snapshot().runId).activeStallCount, 0);
  engine.stop("test_complete");
});

test("a target that becomes ready while paused does not restart playback", async () => {
  const responses = new Map();
  const context = contextFor(async (url) => {
    const date = new URL(`http://local${url}`).searchParams.get("date");
    if (!responses.has(date)) responses.set(date, deferred());
    return responses.get(date).promise;
  });
  const store = api(context, "DataFrameStore");
  const engine = api(context, "PlaybackEngine");
  const allDates = dates(3);
  store.put(requestContext(), { rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  await waitFor(() => responses.has(allDates[1]));
  const starting = engine.start();
  responses.get(allDates[1]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  await starting;
  const target = engine.requireTarget(2);
  engine.pause("user_pause");
  responses.get(allDates[2]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  await target;

  assert.equal(engine.snapshot().status, "PAUSED");
  engine.stop("test_complete");
});
