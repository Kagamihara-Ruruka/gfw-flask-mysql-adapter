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

test("preheater caps outstanding playback-window work while filling a large watermark", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const identity = api(context, "FrameIdentity");
  const pending = [];
  let demands = 0;
  const preheater = new Preheater({
    store: {
      subscribe: () => () => {},
      inspect: () => ({ status: "missing" }),
    },
    demandService: {
      cancelScope() {},
      demand() {
        demands += 1;
        const task = deferred();
        pending.push(task);
        return task.promise;
      },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: identity,
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({
      highWatermark: 60,
      lowWatermark: 30,
      maxPendingFrames: 12,
      windowBehind: 1,
    }),
  });

  preheater.setScope({ dates: dates(100), requestContext: requestContext(), anchorDate: dates(100)[0] });
  assert.equal(demands, 12);
  assert.equal(preheater.snapshot().inflight, 12);
  assert.equal(preheater.snapshot().maxPendingFrames, 12);

  preheater.stop("test_complete");
  for (const task of pending) task.resolve({ status: "ready" });
});

test("preheater prunes queued window consumers without aborting active work on rate downshift", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const cancellations = [];
  const policyContexts = [];
  const preheater = new Preheater({
    store: {
      subscribe: () => () => {},
      inspect: () => ({ status: "missing" }),
    },
    demandService: {
      cancelScope(scopeId, options) {
        cancellations.push({ scopeId, options });
        return options.includeActive ? 0 : 7;
      },
      demand: () => new Promise(() => {}),
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({ highWatermark: 10, lowWatermark: 5, maxPendingFrames: 12 }),
    watermarkPolicyProvider: (fixedPolicy, nextContext) => {
      policyContexts.push(nextContext);
      return fixedPolicy;
    },
  });

  preheater.setScope({ dates: dates(20), requestContext: requestContext(), anchorDate: dates(20)[0] });
  const activeScope = preheater.snapshot().id;
  preheater.reconcile({
    force: true,
    bypassDecreaseHysteresis: true,
    pruneQueued: true,
  });

  assert.ok(policyContexts.some((contextValue) => contextValue.bypassDecreaseHysteresis === true));
  assert.ok(cancellations.some(({ scopeId, options }) => (
    scopeId === activeScope && options.includeActive === false
  )));
  const pruned = api(context, "LifecycleEventLog").query({ type: "PREHEATER_PENDING_PRUNED" }).at(-1);
  assert.equal(pruned.cancelled_consumers, 7);
  preheater.stop("test_complete");
});

test("startup and resume gates are capped to one preheater work wave", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const preheater = new Preheater({
    store: {
      subscribe: () => () => {},
      inspect: () => ({ status: "missing" }),
    },
    demandService: {
      cancelScope() {},
      demand: () => new Promise(() => {}),
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({
      highWatermark: 10,
      lowWatermark: 5,
      maxPendingFrames: 12,
    }),
    watermarkPolicyProvider: () => ({
      highWatermark: 39,
      lowWatermark: 19,
      startupWatermark: 30,
      resumeWatermark: 29,
    }),
  });

  const options = preheater.options();
  assert.equal(options.candidateStartupWatermark, 30);
  assert.equal(options.startupWatermark, 12);
  assert.equal(options.startupWatermarkCapped, true);
  assert.equal(options.candidateResumeWatermark, 29);
  assert.equal(options.resumeWatermark, 12);
  assert.equal(options.resumeWatermarkCapped, true);
  preheater.dispose();
});

test("preheater updates a resolved query route without cancelling or changing scope", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const pending = [];
  const requests = [];
  const queryScopes = [];
  const cancelledScopes = [];
  const preheater = new Preheater({
    store: {
      subscribe: () => () => {},
      inspect: () => ({ status: "missing" }),
    },
    demandService: {
      cancelScope(scopeId) { cancelledScopes.push(scopeId); },
      demand(request, { scopeId }) {
        requests.push(request);
        queryScopes.push(scopeId);
        const task = deferred();
        pending.push(task);
        return task.promise;
      },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({
      highWatermark: 2,
      lowWatermark: 1,
      maxPendingFrames: 1,
      scopeSettleMs: 0,
    }),
  });
  const allDates = dates(4);
  preheater.setScope({ dates: allDates, requestContext: requestContext(), anchorDate: allDates[0] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].resolution, 4);
  const originalScopeId = preheater.snapshot().id;

  preheater.adoptRequestContext({ ...requestContext(), queryResolution: 16 }, { reason: "test_fallback" });
  assert.equal(preheater.snapshot().resolution, 4);
  assert.equal(preheater.snapshot().queryResolution, 16);
  assert.equal(preheater.snapshot().id, originalScopeId);
  assert.equal(cancelledScopes.length, 0);

  pending[0].resolve({ status: "ready" });
  await waitFor(() => requests.length === 2);
  assert.equal(requests[1].resolution, 4);
  assert.equal(requests[1].queryResolution, 16);
  preheater.setScope({
    dates: allDates,
    requestContext: { ...requestContext(), queryResolution: 16 },
    anchorDate: allDates[0],
  });
  assert.equal(preheater.snapshot().id, originalScopeId);
  assert.equal(cancelledScopes.length, 0);
  assert.equal(api(context, "LifecycleEventLog").query({ type: "PREHEATER_QUERY_ROUTE_UPDATED" }).length, 1);
  assert.equal(api(context, "LifecycleEventLog").query({ type: "PREHEATER_SCOPE_MIGRATED" }).length, 0);

  preheater.stop("test_complete");
  assert.deepEqual(new Set(cancelledScopes), new Set(queryScopes));
  pending[1].resolve({ status: "ready" });
});

test("rapid scope changes settle into one playback-window scope", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const pending = [];
  const requestedBboxes = [];
  const preheater = new Preheater({
    store: {
      subscribe: () => () => {},
      inspect: () => ({ status: "missing" }),
    },
    demandService: {
      cancelScope() {},
      demand(request) {
        requestedBboxes.push(request.bbox);
        const task = deferred();
        pending.push(task);
        return task.promise;
      },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({
      highWatermark: 3,
      lowWatermark: 1,
      maxPendingFrames: 3,
      scopeSettleMs: 25,
    }),
  });
  const allDates = dates(3);
  preheater.setScope({
    dates: allDates,
    requestContext: { ...requestContext(), bbox: "100,10,110,20" },
    anchorDate: allDates[0],
  });
  preheater.setScope({
    dates: allDates,
    requestContext: { ...requestContext(), bbox: "110,10,120,20" },
    anchorDate: allDates[0],
  });
  preheater.setScope({
    dates: allDates,
    requestContext: { ...requestContext(), bbox: "120,10,130,20" },
    anchorDate: allDates[0],
  });

  assert.equal(requestedBboxes.length, 0);
  assert.equal(preheater.snapshot().scopeSettlePending, true);
  await waitFor(() => requestedBboxes.length > 0);
  assert.deepEqual([...new Set(requestedBboxes)], ["120.000000,10.000000,130.000000,20.000000"]);
  assert.equal(preheater.snapshot().scopeSettlePending, false);

  preheater.stop("test_complete");
  for (const task of pending) task.resolve({ status: "ready" });
});

test("playback activation bypasses scope settling without reviving stale scopes", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const requestedBboxes = [];
  const preheater = new Preheater({
    store: {
      subscribe: () => () => {},
      inspect: () => ({ status: "missing" }),
    },
    demandService: {
      cancelScope() {},
      demand(request) {
        requestedBboxes.push(request.bbox);
        return new Promise(() => {});
      },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({
      highWatermark: 3,
      lowWatermark: 1,
      maxPendingFrames: 3,
      scopeSettleMs: 1000,
    }),
  });
  const allDates = dates(3);
  preheater.setScope({
    dates: allDates,
    requestContext: { ...requestContext(), bbox: "100,10,110,20" },
    anchorDate: allDates[0],
  });
  preheater.setScope({
    dates: allDates,
    requestContext: { ...requestContext(), bbox: "120,10,130,20" },
    anchorDate: allDates[0],
  });

  preheater.activate();
  assert.deepEqual([...new Set(requestedBboxes)], ["120.000000,10.000000,130.000000,20.000000"]);
  assert.equal(preheater.snapshot().scopeSettlePending, false);
  preheater.stop("test_complete");
});

test("playback run start cancels pre-existing widget-auto work", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const coordinator = api(context, "LayerQueryCoordinator");
  const log = api(context, "LifecycleEventLog");
  const release = deferred();
  const widget = coordinator.schedule({
    key: "widget-before-playback",
    lane: "widget-auto",
    execute: () => release.promise,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  log.beginRun({ kind: "playback", dataset: "ocean" });
  await assert.rejects(widget, (error) => error?.name === "AbortError");
  assert.equal(log.query({ type: "QUERY_TASKS_CANCELLED" }).at(-1)?.reason, "playback_started");

  release.resolve({ rows: [] });
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

test("an active startup gate follows a lower policy after playback speed changes", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  let ready = 0;
  let startupWatermark = 5;
  let waitCount = 0;
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
      reconcile() {},
      readyAhead() { return ready; },
      waitForDates(_dates, { signal }) {
        waitCount += 1;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("gate changed");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
      snapshot() {
        return {
          status: "FETCHING",
          startupWatermark,
          resumeWatermark: 2,
          policyReason: "trusted_metrics",
          degradationReason: startupWatermark > 2 ? "supply_below_consumption" : "",
        };
      },
    },
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(7);
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  const pending = engine.start({ consumption_rate: 2 });
  await waitFor(() => waitCount === 1);

  ready = 2;
  startupWatermark = 2;
  engine.updatePlaybackRate({ rate: 1, interval_ms: 1400, consumption_rate: 1 / 1.4 });

  assert.equal(await pending, true);
  assert.equal(engine.snapshot().status, "PLAYING");
  assert.equal(engine.snapshot().preparationRequired, 2);
  assert.equal(engine.snapshot().preparationDegradationReason, "");
  assert.equal(log.query({ type: "PLAYBACK_RATE_CHANGED" }).length, 1);
  engine.stop("test_complete");
});

test("an active startup gate never chases a higher adaptive policy", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const startup = deferred();
  let ready = 0;
  let startupWatermark = 2;
  let waitCount = 0;
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
        waitCount += 1;
        await startup.promise;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          startupWatermark,
          resumeWatermark: 2,
          policyReason: "trusted_metrics",
          degradationReason: startupWatermark > 2 ? "supply_below_consumption" : "",
        };
      },
    },
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(8);
  const request = requestContext();
  engine.configure({ dates: allDates, requestContext: request, currentDate: allDates[0] });
  const pending = engine.start({ consumption_rate: 1 });
  await waitFor(() => waitCount === 1);

  startupWatermark = 6;
  log.record("CACHE_READY", {
    scope_key: identity.scopeKey(request),
    dataset: request.datasetId,
    date: allDates[1],
  });

  assert.equal(engine.snapshot().preparationRequired, 2);
  assert.equal(waitCount, 1);
  ready = 2;
  startup.resolve();
  assert.equal(await pending, true);
  assert.equal(engine.snapshot().preparationRequired, 2);
  assert.equal(engine.snapshot().status, "PLAYING");
  assert.equal(log.query({ type: "PLAYBACK_GATE_UPDATED" }).length, 0);
  engine.stop("test_complete");
});

test("cache-ready telemetry releases an obsolete startup gate", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  let ready = 0;
  let startupWatermark = 6;
  let waitCount = 0;
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
      waitForDates(_dates, { signal }) {
        waitCount += 1;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("gate changed");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
      snapshot() {
        return {
          status: "FETCHING",
          startupWatermark,
          resumeWatermark: 2,
          policyReason: "trusted_metrics",
          degradationReason: startupWatermark > 2 ? "supply_below_consumption" : "",
        };
      },
    },
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(8);
  const request = requestContext();
  engine.configure({ dates: allDates, requestContext: request, currentDate: allDates[0] });
  const pending = engine.start({ consumption_rate: 1 });
  await waitFor(() => waitCount === 1);

  ready = 2;
  startupWatermark = 2;
  log.record("CACHE_READY", {
    scope_key: identity.scopeKey(request),
    dataset: request.datasetId,
    date: allDates[2],
  });

  assert.equal(await pending, true);
  assert.equal(engine.snapshot().preparationRequired, 2);
  assert.equal(engine.snapshot().status, "PLAYING");
  const update = log.query({ type: "PLAYBACK_GATE_UPDATED" }).at(-1);
  assert.equal(update?.previous_required_slices, 6);
  assert.equal(update?.required_slices, 2);
  assert.equal(update?.reason, "cache_ready");
  engine.stop("test_complete");
});

test("cold startup probes unknown supply without raising its active fallback gate", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const allDates = dates(40);
  const waits = [];
  let ready = 10;
  let probed = false;
  const engine = new Engine({
    store: {
      inspect(request) { return { status: "missing", request }; },
      pin() { return true; },
      release() { return true; },
    },
    demandService: { cancelScope() {}, demand: async () => ({}) },
    preheater: {
      setScope() {},
      setPlayhead() {},
      readyAhead() { return ready; },
      async waitForDates(requestedDates) {
        waits.push([...requestedDates]);
        if (!probed) {
          probed = true;
          ready = 12;
        } else {
          ready = 30;
        }
        return { failed: 0 };
      },
      snapshot() {
        return probed
          ? {
            status: "FETCHING",
            policyStatus: "ADAPTIVE",
            policyReason: "trusted_metrics",
            startupWatermark: 30,
            resumeWatermark: 15,
            supplySamples: 2,
          }
          : {
            status: "FETCHING",
            policyStatus: "WARMING",
            policyReason: "insufficient_metrics",
            startupWatermark: 10,
            resumeWatermark: 5,
            supplySamples: 0,
          };
      },
    },
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });

  assert.equal(await engine.start({ consumption_rate: 1 }), true);
  assert.deepEqual(waits[0], [allDates[11], allDates[12]]);
  assert.equal(waits.length, 1);
  assert.equal(engine.snapshot().preparationRequired, 10);
  assert.equal(log.query({ type: "PREPARE_PROBE_STARTED" }).length, 1);
  assert.equal(log.query({ type: "PREPARE_PROBE_READY" }).length, 1);
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

test("an active resume gate is released when a slower rate lowers the current policy", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const targetResponse = deferred();
  let ready = 5;
  let resumeWatermark = 5;
  let waitCount = 0;
  const reconcileCalls = [];
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
      reconcile(options) { reconcileCalls.push(options); },
      readyAhead() { return ready; },
      waitForDates(_dates, { signal }) {
        waitCount += 1;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("gate changed");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
      snapshot() {
        return {
          status: "FETCHING",
          startupWatermark: 1,
          resumeWatermark,
          policyReason: "trusted_metrics",
          degradationReason: resumeWatermark > 2 ? "supply_below_consumption" : "",
        };
      },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(7);
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  await engine.start({ consumption_rate: 2 });
  ready = 0;
  const target = engine.requireTarget(1);
  targetResponse.resolve({ frameKey: "target-frame" });
  await waitFor(() => waitCount === 1);

  resumeWatermark = 8;
  engine.updatePlaybackRate({ rate: 2, interval_ms: 700, consumption_rate: 2 / 1.4 });
  assert.equal(engine.bufferGate().required, 5);

  ready = 2;
  resumeWatermark = 2;
  engine.updatePlaybackRate({ rate: 1, interval_ms: 1400, consumption_rate: 1 / 1.4 });

  assert.equal(reconcileCalls.at(-1).bypassDecreaseHysteresis, true);
  assert.equal(reconcileCalls.at(-1).pruneQueued, true);

  await target;
  assert.equal(engine.snapshot().status, "PLAYING");
  assert.equal(engine.bufferGate().active, false);
  engine.stop("test_complete");
});

test("adaptive resume watermarks use tail risk instead of the replenishment low watermark", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const policy = vm.runInContext(`calculateAdaptiveWatermarkPolicy({
    fixedPolicy: { highWatermark: 10, lowWatermark: 5, startupWatermark: 5, resumeWatermark: 5 },
    metrics: {
      consumption_rate: 1,
      supply_rate: 0.2,
      cache_ready_latency_p95: 8000,
      supply_samples: 5,
      cache_ready_latency_samples: 5,
    },
    cacheSnapshot: { maxBytes: 2 * 1024 * 1024 * 1024, estimatedFrameBytes: 4 * 1024 * 1024 },
    config: { adaptiveWatermark: { maxHighWatermark: 60 } },
    remainingSlices: 100,
  })`, context);

  assert.equal(policy.highWatermark, 60);
  assert.equal(policy.lowWatermark, 30);
  assert.equal(policy.resumeWatermark, 24);
  assert.ok(policy.resumeWatermark < policy.lowWatermark);
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

test("playback adopts an effective query resolution without rewriting requested scope", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const adopted = [];
  const preheater = {
    setScope() {},
    adoptRequestContext(request, options) { adopted.push({ request, options }); },
    readyAhead() { return 0; },
    snapshot() { return { status: "IDLE", readyAhead: 0, inflight: 0 }; },
  };
  const engine = new Engine({
    store: {
      inspect(request) { return { status: "missing", request, intentKey: identity.intentKey(request), frameKey: "" }; },
      pin() { return true; },
      release() { return true; },
    },
    demandService: { cancelScope() {}, demand: async () => ({ status: "ready" }) },
    preheater,
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  const allDates = dates(4);
  const requested = requestContext();
  engine.configure({ dates: allDates, requestContext: requested, currentDate: allDates[0] });

  log.record("CACHE_READY", {
    scope_key: identity.scopeKey(requested),
    dataset: requested.datasetId,
    date: allDates[1],
    requested_resolution_km: 4,
    actual_resolution_km: 16,
  });

  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].request.resolution, 4);
  assert.equal(adopted[0].request.queryResolution, 16);
  assert.equal(engine.snapshot().scopeKey, identity.scopeKey(requested));
  assert.equal(log.query({ type: "PLAYBACK_SCOPE_CHANGED" }).length, 0);
  const migration = log.query({ type: "PLAYBACK_QUERY_RESOLUTION_ADOPTED" }).at(-1);
  assert.equal(migration?.requested_resolution_km, 4);
  assert.equal(migration?.effective_query_resolution_km, 16);
  assert.equal(migration?.previous_scope, migration?.scope_id);
  engine.dispose();
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

test("a visible-frame callback cannot advance the playhead while buffering", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const allDates = dates(3);
  const engine = new Engine({
    store: {
      inspect(request) {
        return {
          status: "ready",
          request,
          intentKey: identity.intentKey(request),
          frameKey: identity.frameKey(request, { grid: { actual_resolution_km: 4 } }),
          packet: { rows: [], grid: { actual_resolution_km: 4 } },
        };
      },
      pin() { return true; },
      release() { return true; },
    },
    demandService: { cancelScope() {}, demand: async () => ({}) },
    preheater: {
      setScope() {},
      setPlayhead() {},
      readyAhead() { return 0; },
      snapshot() { return { status: "FETCHING", lowWatermark: 2 }; },
    },
    eventLog: log,
    frameIdentity: identity,
    clock: api(context, "ClockDomain").playback,
  });
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  engine.status = "BUFFERING";

  assert.equal(engine.markFrameVisible(1), false);
  assert.equal(engine.snapshot().currentIndex, 0);
  assert.equal(engine.snapshot().status, "BUFFERING");
  assert.equal(log.query({ type: "FRAME_VISIBLE" }).length, 0);
});
