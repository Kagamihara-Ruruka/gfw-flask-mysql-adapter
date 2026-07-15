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
      playbackCache: { highWatermark: 10, lowWatermark: 5, windowBehind: 1 },
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
  engine.start();
  await waitFor(() => responses.has(allDates[1]));
  const target = engine.requireTarget(1);
  const queuedOrActive = api(context, "LayerQueryCoordinator").snapshot();
  const targetTask = [...queuedOrActive.active, ...queuedOrActive.queued]
    .find((task) => task.metadata?.date === allDates[1]);
  assert.equal(targetTask?.lane, "playback-target");

  responses.get(allDates[1]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
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
      snapshot() { return { status: "IDLE" }; },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(3);
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  engine.start();
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
  const response = deferred();
  const context = contextFor(async () => response.promise);
  const store = api(context, "DataFrameStore");
  const engine = api(context, "PlaybackEngine");
  const allDates = dates(2);
  store.put(requestContext(), { rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  engine.start();
  const target = engine.requireTarget(1);
  engine.pause("user_pause");
  response.resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  await target;

  assert.equal(engine.snapshot().status, "PAUSED");
  engine.stop("test_complete");
});
