import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function canonicalTransport(rows = []) {
  const values = Array.isArray(rows) ? rows : [];
  const rowFields = [...new Set(values.flatMap((row) => Object.keys(row || {}).filter((field) => (
    field !== "bounds" && field !== "date" && field !== "resolution_km"
  ))))];
  const frameFields = {};
  for (const field of ["date", "resolution_km"]) {
    if (values.length && values.every((row) => Object.hasOwn(row || {}, field) && row[field] === values[0][field])) {
      frameFields[field] = values[0][field];
    }
  }
  return {
    schema: "rrkal.canonical_grid_frame.v1",
    row_fields: rowFields,
    frame_fields: frameFields,
    columns: rowFields.map((field) => values.map((row) => row?.[field] ?? null)),
    row_count: values.length,
  };
}

function internalPacket(packet = {}) {
  const normalized = {
    ...packet,
    row_contract_version: "rrkal.sampled_grid.v1",
    canonical_frame: packet.canonical_frame || canonicalTransport(packet.rows),
    row_count: Array.isArray(packet.rows) ? packet.rows.length : Number(packet.row_count || 0),
  };
  delete normalized.rows;
  return normalized;
}

function framePacket(context, rows = [], patch = {}) {
  return {
    ...patch,
    frame: new context.CanonicalGridFrame(canonicalTransport(rows)),
    row_count: rows.length,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function batchFetch(sourceFetchJson) {
  return async (url, options = {}) => {
    assert.equal(url, "/api/query/batch");
    const envelope = JSON.parse(options.body);
    const encoder = new TextEncoder();
    const requestController = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        const enqueue = (event) => {
          if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        const abort = () => {
          cancelled = true;
          requestController.abort();
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        queueMicrotask(async () => {
          try {
            enqueue({ type: "batch.started", batch_id: envelope.batch_id });
            for (const operation of envelope.operations) {
              if (cancelled) break;
              const params = new URLSearchParams();
              for (const [key, value] of Object.entries(operation.params || {})) {
                if (value != null) params.set(key, String(value));
              }
              try {
                const packet = await sourceFetchJson(
                  `/api/datasets/${operation.dataset_id}/records?${params}`,
                  { signal: requestController.signal },
                );
                enqueue({
                  type: "batch.result",
                  batch_id: envelope.batch_id,
                  operation_id: operation.operation_id,
                  status: "ok",
                  packet: internalPacket(packet),
                });
              } catch (error) {
                if (error?.name === "AbortError") break;
                enqueue({
                  type: "batch.result",
                  batch_id: envelope.batch_id,
                  operation_id: operation.operation_id,
                  status: "error",
                  error: error?.message || String(error),
                });
              }
            }
            if (!cancelled) {
              enqueue({ type: "batch.completed", batch_id: envelope.batch_id });
              controller.close();
            }
          } finally {
            options.signal?.removeEventListener("abort", abort);
          }
        });
      },
      cancel() {
        cancelled = true;
        requestController.abort();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
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
    TextDecoder,
    URLSearchParams,
    console,
    performance,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    fetch: batchFetch(fetchJson),
    fetchJson,
    state: {
      datasets: { ocean: { backend: "endpoint", sampled_grid: { mapping_version: "v1" } } },
      queryPolicy: { network_concurrency: 3 },
      dataFrameStore: { maxEntries: 0, maxBytes: 128 * 1024 * 1024, stats: {} },
      playbackCache: {
        watermarkStrategy: "fixed",
        highWatermark: 15,
        lowWatermark: 10,
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
    "static/js/core/canonical-grid-frame.js",
    "static/js/services/layer-query-coordinator.js",
    "static/js/services/query-broker.js",
    "static/js/services/query-policy-controller.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/frame-demand-service.js",
    "static/js/services/frame-demand-decorators.js",
    "static/js/playback/playback-preheater.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/adaptive-watermark-controller.js",
    "static/js/playback/playback-renderer.js",
    "static/js/playback/playback-scheduler.js",
    "static/js/playback/playback-runtime-controller.js",
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

test("preheater refills from low 10 to high 15 without becoming a playback gate", async () => {
  let requestCount = 0;
  const context = contextFor(async (url) => {
    requestCount += 1;
    const date = new URL(`http://local${url}`).searchParams.get("date");
    return { rows: [{ cell_id: date, value: 1 }], row_count: 1, grid: { actual_resolution_km: 4 } };
  });
  const store = api(context, "DataFrameStore");
  const preheater = api(context, "PlaybackPreheater");
  const allDates = dates(25);
  store.put(requestContext(), framePacket(context, [], { grid: { actual_resolution_km: 4 } }));
  preheater.setScope({ dates: allDates, requestContext: requestContext(), anchorDate: allDates[0] });

  await waitFor(() => preheater.snapshot().readyAhead >= 15);
  assert.equal(preheater.snapshot().readyAhead, 15);
  assert.equal(requestCount, 15);
  assert.equal(api(context, "LayerQueryCoordinator").snapshot().queued.length, 0);

  preheater.setPlayhead({ date: allDates[6], index: 6 });
  await waitFor(() => preheater.snapshot().readyAhead >= 15);
  assert.equal(preheater.snapshot().readyAhead, 15);
  assert.equal(requestCount, 21);
  assert.equal(preheater.snapshot().status, "READY");
});

test("preheater caps outstanding playback-window work while filling a large watermark", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const identity = api(context, "FrameIdentity");
  const pending = [];
  let demands = 0;
  const preheater = new Preheater({
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
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
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
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

test("preheater watermarks govern replenishment and never expose playback readiness gates", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const preheater = new Preheater({
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
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
      targetWatermark: 39,
    }),
  });

  const options = preheater.options();
  assert.equal(options.highWatermark, 39);
  assert.equal(options.lowWatermark, 19);
  assert.equal(options.targetWatermark, 39);
  assert.equal(options.maxPendingFrames, 12);
  assert.equal(Object.hasOwn(options, "startupWatermark"), false);
  assert.equal(Object.hasOwn(options, "resumeWatermark"), false);
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
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
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
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
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
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
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
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
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

test("cold playback waits for only the next frame and does not record a stall", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const nextFrame = deferred();
  let ready = 0;
  const requestedWindows = [];
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
      waitForDates: async (requestedDates) => {
        requestedWindows.push([...requestedDates]);
        await nextFrame.promise;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          highWatermark: 30,
          lowWatermark: 15,
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
  assert.equal(engine.snapshot().preparationRequired, 1);
  assert.deepEqual(requestedWindows, [[allDates[1]]]);
  assert.equal(log.query({ type: "PREPARE_STARTED" }).length, 1);
  assert.equal(log.query({ type: "BUFFER_ENTERED" }).length, 0);

  ready = 1;
  nextFrame.resolve();
  assert.equal(await pending, true);
  assert.equal(engine.snapshot().status, "PLAYING");
  assert.equal(log.query({ type: "PREPARE_READY" }).length, 1);
  assert.equal(log.summary(engine.snapshot().runId).stallCount, 0);
  engine.stop("test_complete");
});

test("playback speed changes do not restart the one-frame preparation gate", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const nextFrame = deferred();
  let ready = 0;
  let waitCount = 0;
  const reconcileCalls = [];
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
      reconcile(options) { reconcileCalls.push(options); },
      readyAhead() { return ready; },
      async waitForDates() {
        waitCount += 1;
        await nextFrame.promise;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          highWatermark: 30,
          lowWatermark: 15,
          policyReason: "trusted_metrics",
          degradationReason: "supply_below_consumption",
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

  engine.updatePlaybackRate({ rate: 1, interval_ms: 1400, consumption_rate: 1 / 1.4 });
  assert.equal(waitCount, 1);
  assert.equal(engine.snapshot().status, "PREPARING");
  assert.equal(engine.snapshot().preparationRequired, 1);
  assert.equal(reconcileCalls.at(-1).bypassDecreaseHysteresis, true);
  assert.equal(reconcileCalls.at(-1).pruneQueued, true);
  assert.equal(log.query({ type: "PLAYBACK_RATE_CHANGED" }).length, 1);
  assert.equal(log.query({ type: "PLAYBACK_GATE_UPDATED" }).length, 0);

  ready = 1;
  nextFrame.resolve();
  assert.equal(await pending, true);
  assert.equal(engine.snapshot().status, "PLAYING");
  engine.stop("test_complete");
});

test("cold startup never probes extra frames for watermark metrics", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const allDates = dates(40);
  const waits = [];
  let ready = 0;
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
        ready = 1;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          policyStatus: "WARMING",
          policyReason: "insufficient_metrics",
          highWatermark: 30,
          lowWatermark: 15,
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
  assert.deepEqual(waits[0], [allDates[1]]);
  assert.equal(waits.length, 1);
  assert.equal(engine.snapshot().preparationRequired, 1);
  assert.equal(log.query({ type: "PREPARE_PROBE_STARTED" }).length, 0);
  assert.equal(log.query({ type: "PREPARE_PROBE_READY" }).length, 0);
  engine.stop("test_complete");
});

test("buffer recovery resumes when the target frame becomes ready", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const log = api(context, "LifecycleEventLog");
  const targetResponse = deferred();
  let ready = 1;
  let waitCount = 0;
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
        waitCount += 1;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          highWatermark: 30,
          lowWatermark: 15,
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
  assert.equal(engine.bufferGate().required, 1);
  assert.equal(engine.bufferGate().ready, false);
  assert.equal(engine.snapshot().status, "BUFFERING");

  ready = 1;
  targetResponse.resolve({ frameKey: "target-frame" });
  await target;
  assert.equal(engine.snapshot().status, "PLAYING");
  const resumed = log.query({ type: "BUFFER_RESUMED" }).at(-1);
  assert.equal(resumed.required_slices, 1);
  assert.equal(resumed.ready_slices, 1);
  assert.equal(waitCount, 0);
  engine.stop("test_complete");
});

test("playback speed changes do not restart one-frame buffer recovery", async () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Engine = api(context, "PlaybackEngineCore");
  const identity = api(context, "FrameIdentity");
  const targetResponse = deferred();
  const resumeFrame = deferred();
  let ready = 1;
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
      async waitForDates() {
        waitCount += 1;
        await resumeFrame.promise;
        return { failed: 0 };
      },
      snapshot() {
        return {
          status: "FETCHING",
          highWatermark: 30,
          lowWatermark: 15,
          policyReason: "trusted_metrics",
          degradationReason: "supply_below_consumption",
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

  engine.updatePlaybackRate({ rate: 2, interval_ms: 700, consumption_rate: 2 / 1.4 });
  assert.equal(engine.bufferGate().required, 1);
  assert.equal(waitCount, 1);

  ready = 1;
  engine.updatePlaybackRate({ rate: 1, interval_ms: 1400, consumption_rate: 1 / 1.4 });

  assert.equal(reconcileCalls.at(-1).bypassDecreaseHysteresis, true);
  assert.equal(reconcileCalls.at(-1).pruneQueued, true);
  assert.equal(waitCount, 1);

  resumeFrame.resolve();
  await target;
  assert.equal(engine.snapshot().status, "PLAYING");
  assert.equal(engine.bufferGate().active, false);
  engine.stop("test_complete");
});

test("adaptive policy exposes replenishment watermarks but no playback readiness gates", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const policy = vm.runInContext(`calculateAdaptiveWatermarkPolicy({
    fixedPolicy: { highWatermark: 10, lowWatermark: 5 },
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

  assert.ok(policy.highWatermark > policy.lowWatermark);
  assert.equal(policy.targetWatermark, policy.highWatermark);
  assert.equal(Object.hasOwn(policy, "startupWatermark"), false);
  assert.equal(Object.hasOwn(policy, "resumeWatermark"), false);
});

test("replenishment policy is repeatable across refill completion and a later deficit", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const evaluate = api(context, "evaluatePlaybackReplenishment");

  const belowLow = evaluate({
    readyAhead: 9,
    lowWatermark: 10,
    targetWatermark: 15,
  });
  assert.deepEqual({ ...belowLow }, { replenishing: true, trigger: "low_watermark" });

  const filling = evaluate({
    readyAhead: 12,
    lowWatermark: 10,
    targetWatermark: 15,
    wasReplenishing: belowLow.replenishing,
    previousTrigger: belowLow.trigger,
  });
  assert.deepEqual({ ...filling }, { replenishing: true, trigger: "low_watermark" });

  const full = evaluate({
    readyAhead: 15,
    lowWatermark: 10,
    targetWatermark: 15,
    wasReplenishing: filling.replenishing,
    previousTrigger: filling.trigger,
  });
  assert.deepEqual({ ...full }, { replenishing: false, trigger: "" });

  const laterDeficit = evaluate({
    readyAhead: 10,
    lowWatermark: 10,
    targetWatermark: 15,
    wasReplenishing: full.replenishing,
  });
  assert.deepEqual({ ...laterDeficit }, { replenishing: true, trigger: "low_watermark" });
});

test("an LRU eviction below the low watermark re-enters the same replenishment lifecycle", () => {
  const context = contextFor(async () => ({ rows: [], row_count: 0 }));
  const Preheater = api(context, "PlaybackPreheaterController");
  const allDates = dates(3);
  const readyDates = new Set(allDates);
  const demands = [];
  let storeListener = null;
  const preheater = new Preheater({
    fixedPolicyNormalizer: api(context, "normalizedFixedWatermarkPolicy"),
    store: {
      subscribe(listener) {
        storeListener = listener;
        return () => { storeListener = null; };
      },
      inspect(request) {
        return { status: readyDates.has(request.date) ? "ready" : "missing" };
      },
    },
    demandService: {
      cancelScope() {},
      demand(request) {
        demands.push(request.date);
        return new Promise(() => {});
      },
    },
    eventLog: api(context, "LifecycleEventLog"),
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({
      highWatermark: 2,
      lowWatermark: 1,
      maxPendingFrames: 2,
      windowBehind: 0,
    }),
  });

  preheater.setScope({ dates: allDates, requestContext: requestContext(), anchorDate: allDates[0] });
  assert.equal(preheater.snapshot().readyAhead, 2);
  assert.equal(preheater.snapshot().replenishing, false);
  assert.deepEqual(demands, []);

  readyDates.delete(allDates[1]);
  storeListener({ type: "evicted", datasetId: "ocean", date: allDates[1] });

  assert.equal(preheater.snapshot().readyAhead, 0);
  assert.equal(preheater.snapshot().replenishing, true);
  assert.deepEqual(demands, [allDates[1]]);
  preheater.stop("test_complete");
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
  store.put(requestContext(), framePacket(context, [], { grid: { actual_resolution_km: 4 } }));
  engine.configure({ dates: allDates, requestContext: requestContext(), currentDate: allDates[0] });
  await waitFor(() => responses.has(allDates[1]));
  const starting = engine.start();
  responses.get(allDates[1]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  await starting;
  const target = engine.requireTarget(2);
  const promoted = log.query({ type: "TASK_PROMOTED" })
    .find((event) => event.date === allDates[2]);
  assert.equal(promoted?.previous_lane, "playback-window");
  assert.equal(promoted?.requested_lane, "playback-target");
  assert.notEqual(
    api(context, "AppRuntime.services().QueryBroker").operationStatus(promoted.intent_key),
    "missing",
  );

  responses.get(allDates[2]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  const result = await target;
  assert.equal(result.status, "ready");
  assert.equal(requests >= 1, true);
  assert.equal(log.query({ type: "TASK_PROMOTED" }).length >= 1, true);
  assert.equal(log.query({ type: "BUFFER_ENTERED" }).length, 1);
  assert.equal(log.query({ type: "BUFFER_RESUMED" }).length, 1);

  await waitFor(() => responses.has(allDates[3]));
  responses.get(allDates[3]).resolve({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
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
          highWatermark: 15,
          lowWatermark: 10,
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
  store.put(requestContext(), framePacket(context, [], { grid: { actual_resolution_km: 4 } }));
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
