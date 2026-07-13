import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadBrowserScripts(files, globals = {}) {
  const sandbox = {
    console,
    window: {},
    ...globals,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  const context = vm.createContext(sandbox);
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return { context, window: context.window };
}

function loadPlaybackCore(globals = {}) {
  return loadBrowserScripts([
    "static/js/playback/playback-scheduler.js",
    "static/js/playback/playback-frame-buffer.js",
    "static/js/playback/playback-telemetry.js",
  ], globals).window;
}

function cacheService({ readyDates = [], failedDates = [], mode = "progressive" } = {}) {
  const ready = new Set(readyDates);
  const failed = new Map(failedDates.map((date) => [date, { message: `failed ${date}` }]));
  const service = {
    bufferState: null,
    hasDate(date) {
      return ready.has(date);
    },
    countReadyPrefix(dates, startIndex) {
      let count = 0;
      for (let index = startIndex; index < dates.length; index += 1) {
        if (!ready.has(dates[index])) break;
        count += 1;
      }
      return count;
    },
    options() {
      return { mode };
    },
    failureForDate(date) {
      return failed.get(date) || null;
    },
    setBufferState(nextState) {
      service.bufferState = nextState;
    },
  };
  return service;
}

function loadPlaybackCacheService({ prefetchRequests, hasPacket = () => false, cancelPrefetch = () => {} } = {}) {
  const state = {
    dataLayer: "sampled-grid-test",
    playbackRate: 1,
    playIntervalMs: 1400,
    sampledGridRecordCache: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      stats: {},
    },
    playbackCache: {
      mode: "progressive",
      concurrency: "auto",
      maxDates: 0,
      windowBehind: 1,
      windowAhead: 8,
      isPreheating: false,
      isBackgroundPreloading: false,
      buffering: false,
      bufferStatus: "idle",
      bufferReady: 0,
      bufferRequired: 0,
      bufferResume: 0,
      bufferCurrentDate: "",
      bufferTargetIndex: -1,
      bufferWaitStartedAt: 0,
      bufferAttempts: 0,
      bufferStateName: "",
      bufferErrorMessage: "",
      stats: {},
    },
  };
  const statuses = [];
  const globals = {
    state,
    PlaybackWorkerPolicy: {
      resolve() {
        return 1;
      },
      label() {
        return "1 worker";
      },
    },
    SampledGridRecordCache: {
      hasPacket,
      prefetchRequests,
      cancelPrefetch,
    },
    isSampledGridLayer(layerId) {
      return layerId === state.dataLayer;
    },
    setStatus(message, error = false) {
      statuses.push({ message, error });
    },
  };
  const { context } = loadBrowserScripts([
    "static/js/playback/playback-cache-service.js",
  ], globals);
  return { PlaybackCacheService: vm.runInContext("PlaybackCacheService", context), state, statuses };
}

function loadSampledGridRecordCache({ fetchJson, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const state = {
    dataLayer: "sampled-grid-test",
    isPlaying: false,
    playbackCache: {
      isPreheating: false,
      isBackgroundPreloading: false,
    },
    sampledGridRecordCache: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxEntries: 0,
      prewarmConcurrency: 1,
      prewarmDateAhead: 0,
      prewarmDateBehind: 0,
      stats: {},
    },
  };
  const globals = {
    state,
    fetchJson,
    URLSearchParams,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    PlaybackWorkerPolicy: {
      resolve() {
        return 1;
      },
    },
    isSampledGridLayer(layerId) {
      return layerId === state.dataLayer;
    },
  };
  const { context } = loadBrowserScripts([
    "static/js/services/gfw-record-cache.js",
  ], globals);
  return {
    SampledGridRecordCache: vm.runInContext("SampledGridRecordCache", context),
    state,
  };
}

const dates = [
  "2024-01-01",
  "2024-01-02",
  "2024-01-03",
  "2024-01-04",
  "2024-01-05",
];

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("analysis/sequential cadence never skips selected snapshots", () => {
  const { PlaybackScheduler } = loadPlaybackCore();
  const timeline = PlaybackScheduler.start({
    generation: 1,
    nowMs: 1_000,
    intervalMs: 350,
    rate: 4,
    stepMode: "sequential",
    baseDateIndex: 0,
  });

  const lateFrame = PlaybackScheduler.dueFrameNumber(timeline, {
    nowMs: 1_000 + 350 * 8,
    fallbackIntervalMs: 350,
  });

  assert.ok(lateFrame >= 8);
  assert.equal(
    PlaybackScheduler.targetDateIndex(timeline, {
      datesLength: dates.length,
      currentIndex: 0,
      frameNumber: lateFrame,
    }),
    1,
  );

  PlaybackScheduler.markFrameShown(timeline, { frameNumber: lateFrame });
  assert.equal(timeline.nextFrameNumber, 2);
  assert.equal(
    PlaybackScheduler.targetDateIndex(timeline, {
      datesLength: dates.length,
      currentIndex: 1,
      frameNumber: 999,
    }),
    2,
  );
});

test("buffering shifts the clock without changing the next analysis target", () => {
  const { PlaybackScheduler } = loadPlaybackCore();
  const timeline = PlaybackScheduler.start({
    generation: 2,
    nowMs: 5_000,
    intervalMs: 350,
    rate: 4,
    stepMode: "sequential",
    baseDateIndex: 0,
  });
  const nowMs = 4_900;
  const beforeDelay = PlaybackScheduler.delayUntilNextFrame(timeline, {
    nowMs,
    fallbackIntervalMs: 350,
  });
  const beforeStartedAt = timeline.startedAt;

  PlaybackScheduler.shift(timeline, 120);

  assert.equal(timeline.startedAt, beforeStartedAt + 120);
  assert.equal(
    PlaybackScheduler.delayUntilNextFrame(timeline, {
      nowMs,
      fallbackIntervalMs: 350,
    }),
    beforeDelay + 120,
  );
  assert.equal(
    PlaybackScheduler.targetDateIndex(timeline, {
      datesLength: dates.length,
      currentIndex: 0,
      frameNumber: 20,
    }),
    1,
  );
});

test("fluid mode remains the only mode allowed to map time to future dates", () => {
  const { PlaybackScheduler } = loadPlaybackCore();
  const timeline = PlaybackScheduler.start({
    generation: 3,
    nowMs: 1_000,
    intervalMs: 1_400,
    rate: 4,
    stepMode: "fluid",
    baseDateIndex: 0,
  });

  assert.equal(
    PlaybackScheduler.targetDateIndex(timeline, {
      datesLength: dates.length,
      currentIndex: 0,
      frameNumber: 2,
    }),
    4,
  );
});

test("progressive cold cache produces a target-frame fetching decision", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  const service = cacheService();
  const decision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex: 1,
    mode: "progressive",
    hasCacheLayer: true,
    requestContext: { dataset: "gfw_full" },
    cacheService: service,
  });

  assert.equal(decision.state, PlaybackFrameBuffer.FRAME_STATES.fetching);
  assert.equal(decision.targetDate, "2024-01-02");
  assert.equal(decision.renderIndex, -1);
  assert.equal(decision.readyCount, 0);
  assert.equal(decision.requiredCount, 1);
  assert.equal(decision.resumeCount, 1);
  assert.equal(decision.canRender, false);

  PlaybackFrameBuffer.markWaiting({
    decision,
    dates,
    targetIndex: 1,
    cacheService: service,
    waitStartedAt: 123,
    attempts: 2,
  });

  assert.deepEqual(plain(service.bufferState), {
    buffering: true,
    status: "waiting",
    ready: 0,
    required: 1,
    resume: 1,
    currentDate: "2024-01-02",
    targetIndex: 1,
    waitStartedAt: 123,
    attempts: 2,
    stateName: "fetching",
    errorMessage: "",
  });
});

test("progressive ready target renders the target frame with a 1-frame gate", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  const service = cacheService({
    readyDates: ["2024-01-02", "2024-01-03"],
  });

  const decision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex: 1,
    mode: "progressive",
    hasCacheLayer: true,
    requestContext: { dataset: "gfw_full" },
    cacheService: service,
  });

  assert.equal(decision.state, PlaybackFrameBuffer.FRAME_STATES.ready);
  assert.equal(decision.renderIndex, 1);
  assert.equal(decision.renderDate, "2024-01-02");
  assert.equal(decision.readyCount, 2);
  assert.equal(decision.requiredCount, 1);
  assert.equal(decision.resumeCount, 1);
  assert.equal(decision.canRender, true);
  assert.equal(decision.isFallback, false);
});

test("progressive target failure becomes an explicit failed frame-buffer state", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  const service = cacheService({
    failedDates: ["2024-01-02"],
  });

  const decision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex: 1,
    mode: "progressive",
    hasCacheLayer: true,
    requestContext: { dataset: "gfw_full" },
    cacheService: service,
  });

  assert.equal(decision.state, PlaybackFrameBuffer.FRAME_STATES.failed);
  assert.equal(decision.targetDate, "2024-01-02");
  assert.equal(decision.renderIndex, -1);
  assert.equal(decision.canRender, false);
  assert.equal(decision.errorMessage, "failed 2024-01-02");

  PlaybackFrameBuffer.markFailed({
    decision,
    dates,
    targetIndex: 1,
    cacheService: service,
    waitStartedAt: 456,
    attempts: 9,
    errorMessage: decision.errorMessage,
  });

  assert.deepEqual(plain(service.bufferState), {
    buffering: false,
    status: "failed",
    ready: 0,
    required: 1,
    resume: 1,
    currentDate: "2024-01-02",
    targetIndex: 1,
    waitStartedAt: 456,
    attempts: 9,
    stateName: "failed",
    errorMessage: "failed 2024-01-02",
  });
});

test("complete-range preheat is not frame-buffer gated", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  const mode = "before_play";
  const decision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex: 1,
    mode,
    hasCacheLayer: true,
    requestContext: { dataset: "gfw_full" },
    cacheService: cacheService({ mode }),
  });

  assert.equal(decision.state, PlaybackFrameBuffer.FRAME_STATES.ready);
  assert.equal(decision.renderIndex, 1);
  assert.equal(decision.readyCount, 1);
  assert.equal(decision.requiredCount, 1);
});

test("analysis playback event contract is buffering, resumed, then shown", () => {
  const playbackEvents = [];
  const { PlaybackFrameBuffer, PlaybackScheduler, PlaybackTelemetry } = loadPlaybackCore({
    TimingMetrics: {
      recordPlaybackEvent(event) {
        playbackEvents.push(event);
      },
    },
  });
  const timeline = PlaybackScheduler.start({
    generation: 4,
    nowMs: 0,
    intervalMs: 350,
    rate: 4,
    stepMode: "sequential",
    baseDateIndex: 0,
  });

  PlaybackTelemetry.recordTimelineStart({
    rate: 4,
    stepMode: "sequential",
    intervalMs: 350,
    deliveryPolicy: "analysis",
    interpolationMode: "Layer crossfade",
  });

  const targetIndex = PlaybackScheduler.targetDateIndex(timeline, {
    datesLength: dates.length,
    currentIndex: 0,
    frameNumber: 8,
  });
  const coldService = cacheService();
  const waitingDecision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex,
    mode: "progressive",
    hasCacheLayer: true,
    requestContext: { dataset: "gfw_full" },
    cacheService: coldService,
  });
  PlaybackTelemetry.recordBuffering({
    date: waitingDecision.targetDate,
    state: PlaybackFrameBuffer.frameStateLabel(waitingDecision.state),
    ready: waitingDecision.readyCount,
    required: waitingDecision.requiredCount,
    attempts: 1,
  });

  const warmService = cacheService({ readyDates: ["2024-01-02"] });
  const readyDecision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex,
    mode: "progressive",
    hasCacheLayer: true,
    requestContext: { dataset: "gfw_full" },
    cacheService: warmService,
  });
  PlaybackTelemetry.recordBufferResumed({
    date: readyDecision.renderDate,
    waitMs: 381,
    ready: readyDecision.requiredCount,
    required: readyDecision.requiredCount,
  });
  PlaybackTelemetry.recordFrameShown({ date: readyDecision.renderDate });

  assert.deepEqual(
    playbackEvents.map((event) => event.source),
    ["start", "buffer", "resume", "renderer"],
  );
  assert.match(playbackEvents[1].text, /buffering 2024-01-02 .* 0 \/ 1/);
  assert.match(playbackEvents[2].text, /resumed 2024-01-02 .* 1 \/ 1/);
  assert.deepEqual(plain(playbackEvents[3]), {
    label: "顯示 snapshot",
    text: "2024-01-02",
    status: "ok",
    source: "renderer",
  });
  assert.ok(!playbackEvents.some((event) => event.source === "nearest-ready"));
});

test("frame-buffer failure emits an error telemetry event", () => {
  const playbackEvents = [];
  const { PlaybackTelemetry } = loadPlaybackCore({
    TimingMetrics: {
      recordPlaybackEvent(event) {
        playbackEvents.push(event);
      },
    },
  });

  PlaybackTelemetry.recordBufferFailed({
    date: "2024-01-02",
    state: "failed · request failed",
  });

  assert.deepEqual(plain(playbackEvents), [{
    label: "Frame buffer",
    text: "failed 2024-01-02 · failed · request failed",
    status: "error",
    source: "buffer",
  }]);
});

test("progressive startup waits only for the first renderable frame while preserving watermarks", async () => {
  let resolvePrefetch = null;
  let requestedDates = [];
  let settled = false;
  const run = new Promise((resolve) => {
    resolvePrefetch = resolve;
  });
  const { PlaybackCacheService, state } = loadPlaybackCacheService({
    prefetchRequests(requests) {
      requestedDates = requests.map((request) => request.date);
      return run;
    },
  });
  state.playbackRate = 2;
  const range = Array.from({ length: 12 }, (_, index) => `2024-01-${String(index + 1).padStart(2, "0")}`);

  const preheat = PlaybackCacheService.preheat({
    dates: range,
    anchorDate: range[0],
    bbox: "0,0,1,1",
    datasetId: "sampled-grid-test",
    limit: "max",
    blocking: true,
  }).then(() => {
    settled = true;
  });

  await Promise.resolve();
  const plan = PlaybackCacheService.startupBufferPlan(range, { anchorDate: range[0] });
  assert.equal(plan.resume, 8);
  assert.equal(plan.lowWatermark, 3);
  assert.equal(plan.startupRequired, 1);
  assert.deepEqual(requestedDates, range.slice(0, 2));
  assert.equal(state.playbackCache.isPreheating, true);
  assert.equal(state.playbackCache.isBackgroundPreloading, false);
  assert.equal(settled, false);

  resolvePrefetch({ total: requestedDates.length, fetched: requestedDates.length, cacheHits: 0, failed: 0 });
  await preheat;
  assert.equal(settled, true);
  assert.equal(state.playbackCache.isPreheating, false);
});

test("progressive refill starts at low-water and targets the high-water window", () => {
  const cacheService = {
    bufferPolicy() {
      return { lowWatermark: 3, resume: 8 };
    },
    countReadyPrefix() {
      return 4;
    },
  };
  const { context } = loadBrowserScripts([
    "static/js/playback/playback-prefetch-controller.js",
  ]);
  const PlaybackPrefetchController = vm.runInContext("PlaybackPrefetchController", context);
  const decisionAboveLowWater = PlaybackPrefetchController.shouldQueue({
    options: { mode: "progressive" },
    dates,
    currentDate: dates[0],
    requestContext: {},
    cacheService,
  });
  assert.equal(decisionAboveLowWater.shouldQueue, false);

  cacheService.countReadyPrefix = () => 3;
  const decisionAtLowWater = PlaybackPrefetchController.shouldQueue({
    options: { mode: "progressive" },
    dates,
    currentDate: dates[0],
    requestContext: {},
    cacheService,
  });
  assert.equal(decisionAtLowWater.shouldQueue, true);
  assert.equal(decisionAtLowWater.policy.resume, 8);
});

test("progressive playback does not block startup on cache preheat", () => {
  const source = readFileSync(
    path.join(repoRoot, "static/js/playback/playback-controls.js"),
    "utf8",
  );
  const start = source.indexOf("async function setPlayback(active)");
  const end = source.indexOf("async function normalizeDateInputs", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(body, /await\s+awaitProgressiveStartupBuffer/);
  assert.match(body, /if \(options\.mode === "before_play"\)[\s\S]*await preheatPlaybackCache\(\{ blocking: true \}\)/);
  assert.match(body, /state\.isPlaying = true;[\s\S]*schedulePlaybackTick\(generation\);[\s\S]*if \(options\.mode === "progressive"\)[\s\S]*preheatPlaybackCache\(\{ blocking: false/);
});

test("idle prewarm delay is state-owned instead of a scheduler magic number", () => {
  const source = readFileSync(
    path.join(repoRoot, "static/js/services/gfw-record-cache.js"),
    "utf8",
  );
  const start = source.indexOf("function schedulePrewarm(context)");
  const end = source.indexOf("function cancelPrewarm()", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /options\(\)\.prewarmIdleDelayMs/);
  assert.doesNotMatch(body, /},\s*700\s*\)/);
});

test("legacy per-frame query mode normalizes to adaptive progressive preheat", () => {
  const { PlaybackCacheService, state } = loadPlaybackCacheService({
    prefetchRequests: async () => ({ total: 0, fetched: 0, cacheHits: 0, failed: 0 }),
  });
  state.playbackCache.mode = "off";

  assert.equal(PlaybackCacheService.options().mode, "progressive");
  assert.equal(state.playbackCache.mode, "progressive");
});

test("progressive rolling windows serialize and coalesce to the latest pending anchor", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const { PlaybackCacheService } = loadPlaybackCacheService({
    prefetchRequests(requests) {
      let resolveRun = null;
      const deferred = new Promise((resolve) => {
        resolveRun = resolve;
      });
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({
        dates: requests.map((request) => request.date),
        resolve() {
          active -= 1;
          resolveRun({ total: requests.length, fetched: requests.length, cacheHits: 0, failed: 0 });
        },
      });
      return deferred;
    },
  });
  const range = Array.from({ length: 16 }, (_, index) => `2024-01-${String(index + 1).padStart(2, "0")}`);
  const request = {
    dates: range,
    bbox: "0,0,1,1",
    datasetId: "sampled-grid-test",
    limit: "max",
    blocking: false,
  };

  await PlaybackCacheService.preheat({ ...request, anchorDate: range[0] });
  await PlaybackCacheService.preheat({ ...request, anchorDate: range[2] });
  await PlaybackCacheService.preheat({ ...request, anchorDate: range[4] });
  assert.equal(calls.length, 1);

  calls[0].resolve();
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].dates[0], range[3]);
  assert.equal(maxActive, 1);

  calls[1].resolve();
  for (let index = 0; index < 3; index += 1) await Promise.resolve();
  PlaybackCacheService.cancelBackground();
});

test("interactive prewarm cancellation does not cancel playback prefetch", async () => {
  let resolveFirst = null;
  const urls = [];
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const { SampledGridRecordCache } = loadSampledGridRecordCache({
    fetchJson(url) {
      urls.push(url);
      if (urls.length === 1) return first;
      return Promise.resolve({ rows: [], timing: {} });
    },
  });
  const requests = ["2024-01-01", "2024-01-02"].map((date) => ({
    datasetId: "sampled-grid-test",
    date,
    bbox: "0,0,1,1",
    limit: "max",
    columns: "render",
  }));

  const prefetch = SampledGridRecordCache.prefetchRequests(requests, { concurrency: 1 });
  await Promise.resolve();
  assert.equal(urls.length, 1);
  SampledGridRecordCache.cancelPrewarm();
  resolveFirst({ rows: [], timing: {} });
  await prefetch;

  assert.equal(urls.length, 2);
});

test("explicit playback-prefetch cancellation stops queued requests", async () => {
  let resolveFirst = null;
  const urls = [];
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const { SampledGridRecordCache } = loadSampledGridRecordCache({
    fetchJson(url) {
      urls.push(url);
      if (urls.length === 1) return first;
      return Promise.resolve({ rows: [], timing: {} });
    },
  });
  const requests = ["2024-01-01", "2024-01-02"].map((date) => ({
    datasetId: "sampled-grid-test",
    date,
    bbox: "0,0,1,1",
    limit: "max",
    columns: "render",
  }));

  const prefetch = SampledGridRecordCache.prefetchRequests(requests, { concurrency: 1 });
  await Promise.resolve();
  SampledGridRecordCache.cancelPrefetch();
  resolveFirst({ rows: [], timing: {} });
  await prefetch;

  assert.equal(urls.length, 1);
});

test("progressive preheat failure is lifecycle-scoped request state", async () => {
  const request = {
    datasetId: "gfw_full",
    date: "2024-01-02",
    bbox: "0,0,1,1",
    limit: "max",
    columns: "render",
  };
  const { PlaybackCacheService } = loadPlaybackCacheService({
    async prefetchRequests(requests, { onProgress } = {}) {
      onProgress({
        request: requests[1],
        cacheHit: false,
        ok: false,
        error: new Error("network down"),
      });
      return { total: 2, fetched: 0, cacheHits: 0, failed: 1 };
    },
  });

  await PlaybackCacheService.preheat({
    dates: ["2024-01-01", "2024-01-02"],
    bbox: request.bbox,
    datasetId: request.datasetId,
    limit: request.limit,
    blocking: false,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    PlaybackCacheService.failureForDate(request.date, request)?.message,
    "network down",
  );

  PlaybackCacheService.cancelBackground();
  assert.equal(PlaybackCacheService.failureForDate(request.date, request), null);
});

test("cancelled progressive preheat ignores stale late progress", async () => {
  let progressCallback = null;
  let resolveRun = null;
  const run = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const { PlaybackCacheService, state, statuses } = loadPlaybackCacheService({
    prefetchRequests(requests, { onProgress } = {}) {
      progressCallback = onProgress;
      return run;
    },
  });

  await PlaybackCacheService.preheat({
    dates: ["2024-01-01", "2024-01-02"],
    bbox: "0,0,1,1",
    datasetId: "gfw_full",
    limit: "max",
    blocking: false,
  });
  assert.equal(state.playbackCache.isBackgroundPreloading, true);

  PlaybackCacheService.cancelBackground();
  progressCallback({
    request: {
      datasetId: "gfw_full",
      date: "2024-01-02",
      bbox: "0,0,1,1",
      limit: "max",
      columns: "render",
    },
    cacheHit: false,
    ok: false,
    error: new Error("late failure"),
  });
  resolveRun({ total: 2, fetched: 0, cacheHits: 0, failed: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(state.playbackCache.isBackgroundPreloading, false);
  assert.equal(state.playbackCache.stats.completed, 0);
  assert.equal(
    PlaybackCacheService.failureForDate("2024-01-02", {
      datasetId: "gfw_full",
      bbox: "0,0,1,1",
      limit: "max",
      columns: "render",
    }),
    null,
  );
  assert.equal(statuses.length, 1);
});
