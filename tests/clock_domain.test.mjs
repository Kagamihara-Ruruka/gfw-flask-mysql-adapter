import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadClockRuntime() {
  const context = {
    AbortController,
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
    console,
  };
  vm.createContext(context);
  for (const file of [
    "static/js/core/clock-domain.js",
    "static/js/services/lifecycle-event-log.js",
    "static/js/playback/playback-frame-buffer.js",
    "static/js/playback/playback-engine.js",
    "static/js/services/runtime-performance-metrics.js",
    "static/js/playback/playback-time-policy.js",
  ]) {
    vm.runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return context;
}

function fakeClockDomain(createClockDomain) {
  let now = 0;
  let nextHandle = 1;
  const scheduled = new Map();
  const schedule = (callback, delayMs = 0) => {
    const handle = nextHandle;
    nextHandle += 1;
    scheduled.set(handle, { callback, dueAt: now + Number(delayMs || 0) });
    return handle;
  };
  const cancel = (handle) => scheduled.delete(handle);
  const domain = createClockDomain({
    monotonicNow: () => now,
    wallNowIso: () => new Date(Date.UTC(2026, 6, 16) + now).toISOString(),
    schedule,
    cancelSchedule: cancel,
    requestFrame: (callback) => schedule(() => callback(now), 16),
    cancelFrame: cancel,
  });
  return {
    domain,
    advance(ms) {
      now += Number(ms || 0);
    },
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

function identity() {
  return {
    normalizeRequest: (request) => ({ ...request }),
    scopeKey: (request) => `${request.datasetId}|${request.bbox}|${request.resolution}`,
    intentKey: (request) => `${request.datasetId}|${request.date}|${request.bbox}|${request.resolution}`,
  };
}

test("five seconds of buffering stays five wall-clock seconds at every playback speed", async () => {
  const context = loadClockRuntime();
  const createClockDomain = vm.runInContext("createClockDomain", context);
  const LifecycleEventLogCore = vm.runInContext("LifecycleEventLogCore", context);
  const PlaybackEngineCore = vm.runInContext("PlaybackEngineCore", context);
  const createRuntimePerformanceMetrics = vm.runInContext("createRuntimePerformanceMetrics", context);

  for (const speed of [1, 2, 4]) {
    const clock = fakeClockDomain(createClockDomain);
    const eventLog = new LifecycleEventLogCore({
      maxEntriesProvider: () => 2000,
      clock: clock.domain.monotonic,
    });
    const target = deferred();
    const preheater = {
      setScope() {},
      setPlayhead() {},
      readyAhead: () => 4,
      waitForDates: async () => ({ failed: 0 }),
      snapshot: () => ({ status: "FETCHING", readyAhead: 4 }),
    };
    const engine = new PlaybackEngineCore({
      store: {
        inspect: (request) => ({ status: "missing", request }),
        pin: () => true,
        release: () => true,
      },
      demandService: { demand: () => target.promise },
      preheater,
      eventLog,
      frameIdentity: identity(),
      clock: clock.domain.playback,
    });
    engine.configure({
      dates: ["2020-01-01", "2020-01-02"],
      currentDate: "2020-01-01",
      requestContext: {
        datasetId: "ocean",
        date: "2020-01-01",
        bbox: "120,10,130,20",
        resolution: 4,
      },
    });
    const consumptionRate = clock.domain.playback.consumptionRate({
      baseIntervalMs: 1400,
      speed,
    });
    engine.start({ consumption_rate: consumptionRate, speed });
    const pending = engine.requireTarget(1);
    clock.advance(5000);

    const metrics = createRuntimePerformanceMetrics({
      eventLog,
      preheater,
      playbackEngine: engine,
      clock: clock.domain.monotonic,
    }).snapshot();
    assert.equal(engine.bufferWaitMs(), 5000);
    assert.equal(metrics.buffer_wait_ms, 5000);
    assert.equal(metrics.consumption_rate, consumptionRate);

    target.resolve({ frameKey: `frame-${speed}` });
    await pending;
    const resumed = eventLog.query({ type: "BUFFER_RESUMED" }).at(-1);
    assert.equal(resumed.duration_ms, 5000);
    assert.equal(resumed.monotonic_ms, 5000);
    assert.ok(eventLog.query().every((event) => (
      Number.isFinite(event.monotonic_ms) && !("timestamp" in event)
    )));
  }
});

test("PlaybackEngine owns the 30 second monotonic buffer timeout at every playback speed", async () => {
  const context = loadClockRuntime();
  const createClockDomain = vm.runInContext("createClockDomain", context);
  const LifecycleEventLogCore = vm.runInContext("LifecycleEventLogCore", context);
  const PlaybackEngineCore = vm.runInContext("PlaybackEngineCore", context);
  const PlaybackFrameBuffer = vm.runInContext("PlaybackFrameBuffer", context);
  const PlaybackTimePolicy = vm.runInContext("PlaybackTimePolicy", context);

  for (const speed of [1, 2, 4]) {
    const clock = fakeClockDomain(createClockDomain);
    const eventLog = new LifecycleEventLogCore({
      maxEntriesProvider: () => 2000,
      clock: clock.domain.monotonic,
    });
    const target = deferred();
    const engine = new PlaybackEngineCore({
      store: {
        inspect: (request) => ({ status: "missing", request }),
        pin: () => true,
        release: () => true,
      },
      demandService: { demand: () => target.promise, cancelScope: () => 0 },
      preheater: {
        activate() {},
        setScope() {},
        setPlayhead() {},
        readyAhead: () => 1,
        waitForDates: async () => ({ failed: 0 }),
        snapshot: () => ({ status: "FETCHING", readyAhead: 1 }),
      },
      eventLog,
      frameIdentity: identity(),
      clock: clock.domain.playback,
      frameBufferPolicy: PlaybackFrameBuffer,
      bufferTimeoutMs: PlaybackTimePolicy.BUFFER_TIMEOUT_MS,
    });
    engine.configure({
      dates: ["2020-01-01", "2020-01-02"],
      currentDate: "2020-01-01",
      requestContext: {
        datasetId: "ocean",
        date: "2020-01-01",
        bbox: "120,10,130,20",
        resolution: 4,
      },
    });
    await engine.start({ speed });
    const pending = engine.requireTarget(1);
    const cadence = clock.domain.playback.cadenceMs({ baseIntervalMs: 1400, speed });
    assert.equal(cadence, 1400 / speed);
    clock.advance(29_999);
    assert.notEqual(engine.frameDecision({ targetIndex: 1 }).state, PlaybackFrameBuffer.FRAME_STATES.failed);
    clock.advance(1);
    const failed = engine.frameDecision({ targetIndex: 1 });
    assert.equal(failed.state, PlaybackFrameBuffer.FRAME_STATES.failed);
    assert.equal(engine.snapshot().status, "FAILED");
    assert.match(failed.errorMessage, /30s/);
    assert.equal(eventLog.query({ type: "PLAYBACK_TARGET_FAILED" }).at(-1)?.reason, "buffer_timeout");

    target.resolve({ frameKey: `late-frame-${speed}` });
    await pending;
    assert.equal(engine.snapshot().status, "FAILED");
    assert.equal(eventLog.query({ type: "BUFFER_RESUMED" }).length, 0);
    engine.stop("test_complete");
  }
});

test("trusted rates, tail latency and ready-ahead values share one event clock", () => {
  const context = loadClockRuntime();
  const createClockDomain = vm.runInContext("createClockDomain", context);
  const LifecycleEventLogCore = vm.runInContext("LifecycleEventLogCore", context);
  const createRuntimePerformanceMetrics = vm.runInContext("createRuntimePerformanceMetrics", context);
  const clock = fakeClockDomain(createClockDomain);
  const eventLog = new LifecycleEventLogCore({
    maxEntriesProvider: () => 2000,
    clock: clock.domain.monotonic,
  });
  const runId = eventLog.beginRun({
    run_id: "trusted-clock",
    consumption_rate: 2,
    scope_key: "scope|playback",
  });
  for (let index = 0; index < 10; index += 1) {
    clock.advance(100);
    eventLog.record("CACHE_READY", {
      run_id: runId,
      intent_key: `widget-${index}`,
      lane: "widget-auto",
      scope_key: "scope|widget",
    });
  }
  eventLog.record("TASK_QUEUED", {
    run_id: runId,
    intent_key: "one",
    lane: "playback-window",
    scope_key: "scope|playback",
  });
  clock.advance(1000);
  eventLog.record("CACHE_READY", {
    run_id: runId,
    intent_key: "one",
    lane: "playback-window",
    scope_key: "scope|playback",
  });
  eventLog.record("TASK_QUEUED", {
    run_id: runId,
    intent_key: "two",
    lane: "playback-window",
    scope_key: "scope|playback",
  });
  clock.advance(1000);
  eventLog.record("CACHE_READY", {
    run_id: runId,
    intent_key: "two",
    lane: "playback-window",
    scope_key: "scope|playback",
  });

  const metricService = createRuntimePerformanceMetrics({
    eventLog,
    preheater: { snapshot: () => ({ status: "FETCHING", readyAhead: 6, scopeKey: "scope|playback" }) },
    playbackEngine: { snapshot: () => ({ status: "PLAYING", bufferWaitMs: 0 }) },
    clock: clock.domain.monotonic,
  });
  const metrics = metricService.snapshot(runId);

  assert.equal(metrics.consumption_rate, 2);
  assert.equal(metrics.supply_rate, 1);
  assert.equal(metrics.cache_ready_latency_p95, 1000);
  assert.equal(metrics.ready_ahead_slices, 6);
  assert.equal(metrics.ready_ahead_seconds, 3);
  assert.equal(metrics.monotonic_ms, 3000);
  assert.equal(metrics.supply_samples, 2);
  assert.equal(metrics.cache_ready_latency_samples, 2);

  eventLog.record("PLAYBACK_RATE_CHANGED", {
    run_id: runId,
    rate: 1,
    interval_ms: 1400,
    consumption_rate: 1,
  });
  const slowerMetrics = metricService.snapshot(runId);
  assert.equal(slowerMetrics.consumption_rate, 1);
  assert.equal(slowerMetrics.ready_ahead_seconds, 6);
  assert.equal(slowerMetrics.supply_metric_source, "rate_transition_warmup");
  assert.equal(slowerMetrics.supply_samples, 0);
  assert.equal(slowerMetrics.cache_ready_latency_p95, 0);

  for (const intentKey of ["after-rate-one", "after-rate-two"]) {
    eventLog.record("TASK_QUEUED", {
      run_id: runId,
      intent_key: intentKey,
      lane: "playback-window",
      scope_key: "scope|playback",
    });
    clock.advance(500);
    eventLog.record("CACHE_READY", {
      run_id: runId,
      intent_key: intentKey,
      lane: "playback-window",
      scope_key: "scope|playback",
    });
  }
  const settledMetrics = metricService.snapshot(runId);
  assert.equal(settledMetrics.supply_metric_source, "scope_history");
  assert.equal(settledMetrics.supply_samples, 2);
  assert.equal(settledMetrics.cache_ready_latency_p95, 500);

  eventLog.endRun({ run_id: runId });
  const afterRun = metricService.inputs();
  assert.equal(afterRun.run_id, runId);
  assert.equal(afterRun.consumption_rate, 1);
});

test("playback keeps recent scope supply metrics after an actual-resolution fallback", () => {
  const context = loadClockRuntime();
  const createClockDomain = vm.runInContext("createClockDomain", context);
  const LifecycleEventLogCore = vm.runInContext("LifecycleEventLogCore", context);
  const createRuntimePerformanceMetrics = vm.runInContext("createRuntimePerformanceMetrics", context);
  const clock = fakeClockDomain(createClockDomain);
  const eventLog = new LifecycleEventLogCore({
    maxEntriesProvider: () => 2000,
    clock: clock.domain.monotonic,
  });
  const bbox = "120.000000,10.000000,130.000000,20.000000";

  for (let index = 0; index < 2; index += 1) {
    const intentKey = `ocean-${index}`;
    eventLog.record("TASK_QUEUED", {
      intent_key: intentKey,
      lane: "playback-window",
      scope_key: "scope|ocean|requested-4",
      dataset: "ocean",
      bbox,
      requested_resolution_km: 4,
    });
    clock.advance(1000);
    eventLog.record("CACHE_READY", {
      intent_key: intentKey,
      lane: "playback-window",
      scope_key: "scope|ocean|requested-4",
      dataset: "ocean",
      bbox,
      requested_resolution_km: 4,
      effective_query_resolution_km: 4,
      actual_resolution_km: 16,
    });
  }
  for (let index = 0; index < 20; index += 1) {
    eventLog.record("CACHE_READY", {
      intent_key: `widget-${index}`,
      lane: "widget-auto",
      scope_key: "scope|widget",
      dataset: "ocean",
      bbox,
      requested_resolution_km: 4,
      effective_query_resolution_km: 16,
      actual_resolution_km: 16,
    });
  }

  const runId = eventLog.beginRun({
    run_id: "actual-resolution-playback",
    consumption_rate: 2,
    scope_key: "scope|ocean|requested-4",
  });
  const metricService = createRuntimePerformanceMetrics({
    eventLog,
    preheater: { snapshot: () => ({ status: "READY", readyAhead: 10 }) },
    playbackEngine: { snapshot: () => ({ status: "PREPARING", preparationWaitMs: 0 }) },
    clock: clock.domain.monotonic,
  });
  const metrics = metricService.inputs({
    runId,
    scopeKey: "scope|ocean|requested-4",
    datasetId: "ocean",
    bbox,
    resolution: 4,
  });

  assert.equal(metrics.supply_metric_source, "scope_history");
  assert.equal(metrics.supply_samples, 2);
  assert.equal(metrics.supply_rate, 1);
  assert.equal(metrics.cache_ready_latency_p95, 1000);
  assert.equal(metrics.cache_ready_latency_samples, 2);
});

test("runtime performance metrics increment events without rescanning the lifecycle log", () => {
  const context = loadClockRuntime();
  const createClockDomain = vm.runInContext("createClockDomain", context);
  const LifecycleEventLogCore = vm.runInContext("LifecycleEventLogCore", context);
  const createRuntimePerformanceMetrics = vm.runInContext("createRuntimePerformanceMetrics", context);
  const clock = fakeClockDomain(createClockDomain);
  const eventLog = new LifecycleEventLogCore({
    maxEntriesProvider: () => 20_000,
    clock: clock.domain.monotonic,
  });
  const scopeKey = "scope|bounded";
  const runId = eventLog.beginRun({
    run_id: "incremental-metrics",
    consumption_rate: 1,
    scope_key: scopeKey,
  });
  const originalQuery = eventLog.query.bind(eventLog);
  let queryCalls = 0;
  let summaryCalls = 0;
  eventLog.query = (...args) => {
    queryCalls += 1;
    return originalQuery(...args);
  };
  eventLog.summary = () => {
    summaryCalls += 1;
    throw new Error("hot metrics path must not request a full lifecycle summary");
  };
  const metrics = createRuntimePerformanceMetrics({
    eventLog,
    preheater: {
      snapshot: () => ({ status: "FETCHING", readyAhead: 8, scopeKey }),
    },
    playbackEngine: {
      snapshot: () => ({ status: "PLAYING", bufferWaitMs: 0 }),
    },
    clock: clock.domain.monotonic,
  });
  assert.equal(queryCalls, 1, "construction replays the existing bounded log once");

  for (let index = 0; index < 300; index += 1) {
    const intentKey = `bounded-${index}`;
    eventLog.record("TASK_QUEUED", {
      run_id: runId,
      intent_key: intentKey,
      lane: "playback-window",
      scope_key: scopeKey,
    });
    clock.advance(10);
    eventLog.record("CACHE_READY", {
      run_id: runId,
      intent_key: intentKey,
      lane: "playback-window",
      scope_key: scopeKey,
    });
    metrics.inputs({ runId, scopeKey });
  }

  const snapshot = metrics.snapshot({ runId, scopeKey });
  assert.equal(queryCalls, 1);
  assert.equal(summaryCalls, 0);
  assert.equal(snapshot.supply_samples, 240);
  assert.equal(metrics.scopeHistory.get(scopeKey).length, 240);
  metrics.dispose();
});

test("runtime timing owners do not read playback speed outside the playback clock path", () => {
  const auditedFiles = [
    "static/TimingMetrics.js",
    "static/js/services/lifecycle-event-log.js",
    "static/js/services/layer-query-coordinator.js",
    "static/js/services/frame-demand-service.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/runtime-performance-metrics.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/playback-preheater.js",
  ];
  for (const file of auditedFiles) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /playbackRate|playbackSpeed|speedMultiplier/);
    assert.doesNotMatch(source, /Date\.now\(|performance\.now\(/);
  }

  const controls = readFileSync(path.join(root, "static/js/playback/playback-controls.js"), "utf8");
  const metricsWidget = readFileSync(
    path.join(root, "static/js/ui/widgets/capabilities/metrics.js"),
    "utf8",
  );
  const eventViewer = readFileSync(
    path.join(root, "static/js/ui/widgets/capabilities/event-viewer.js"),
    "utf8",
  );
  assert.match(controls, /RuntimePerformanceMetrics\?\.snapshot\?\.\(\)/);
  assert.match(controls, /runtime\.buffer_wait_ms/);
  assert.match(controls, /runtime\.preparation_wait_ms/);
  assert.match(metricsWidget, /runtimeMetricsProvider/);
  assert.match(eventViewer, /runtimeMetricsProvider/);
});
