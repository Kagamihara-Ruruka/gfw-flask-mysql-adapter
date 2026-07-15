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

test("the 30 second buffer timeout uses monotonic time instead of playback cadence", () => {
  const context = loadClockRuntime();
  const createClockDomain = vm.runInContext("createClockDomain", context);
  const PlaybackTimePolicy = vm.runInContext("PlaybackTimePolicy", context);

  for (const speed of [1, 2, 4]) {
    const clock = fakeClockDomain(createClockDomain);
    const enteredAt = clock.domain.monotonic.now();
    const cadence = clock.domain.playback.cadenceMs({ baseIntervalMs: 1400, speed });
    assert.equal(cadence, 1400 / speed);
    clock.advance(29_999);
    assert.equal(
      PlaybackTimePolicy.bufferTimedOut(clock.domain.monotonic.now() - enteredAt),
      false,
    );
    clock.advance(1);
    assert.equal(
      PlaybackTimePolicy.bufferTimedOut(clock.domain.monotonic.now() - enteredAt),
      true,
    );
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
  const runId = eventLog.beginRun({ run_id: "trusted-clock", consumption_rate: 2 });
  eventLog.record("TASK_QUEUED", { run_id: runId, intent_key: "one" });
  clock.advance(1000);
  eventLog.record("CACHE_READY", { run_id: runId, intent_key: "one" });
  clock.advance(500);
  eventLog.record("TASK_QUEUED", { run_id: runId, intent_key: "two" });
  clock.advance(1500);
  eventLog.record("CACHE_READY", { run_id: runId, intent_key: "two" });

  const metrics = createRuntimePerformanceMetrics({
    eventLog,
    preheater: { snapshot: () => ({ status: "FETCHING", readyAhead: 6 }) },
    playbackEngine: { snapshot: () => ({ status: "PLAYING", bufferWaitMs: 0 }) },
    clock: clock.domain.monotonic,
  }).snapshot(runId);

  assert.equal(metrics.consumption_rate, 2);
  assert.equal(metrics.supply_rate, 0.5);
  assert.equal(metrics.cache_ready_latency_p95, 1500);
  assert.equal(metrics.ready_ahead_slices, 6);
  assert.equal(metrics.ready_ahead_seconds, 3);
  assert.equal(metrics.monotonic_ms, 3000);
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
  assert.match(controls, /RuntimePerformanceMetrics\?\.snapshot\?\.\(\)\.buffer_wait_ms/);
  assert.match(metricsWidget, /runtimeMetricsProvider/);
  assert.match(eventViewer, /runtimeMetricsProvider/);
});
