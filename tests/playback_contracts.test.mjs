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
  ], globals).window;
}

function loadPlaybackRenderer() {
  const events = [];
  const order = [];
  const browserWindow = {
    dispatchEvent(event) {
      events.push(event);
      order.push(`event:${event.detail.date}`);
    },
  };
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const { context } = loadBrowserScripts([
    "static/js/playback/playback-renderer.js",
  ], { window: browserWindow, CustomEvent });
  const Renderer = vm.runInContext("globalThis.PlaybackRendererController", context);
  return { PlaybackRenderer: new Renderer({ eventTarget: browserWindow }), events, order };
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

function engineFrameInspector(service, sourceDates = dates) {
  return (index) => {
    const date = sourceDates[index] || "";
    const failure = service.failureForDate(date);
    if (failure) return { status: "failed", date, failure };
    return { status: service.hasDate(date) ? "ready" : "missing", date };
  };
}

function loadPlaybackCacheService({ waitForDates = async (dates) => ({
  total: dates.length,
  completed: dates.length,
  fetched: dates.length,
  cacheHits: 0,
  failed: 0,
}) } = {}) {
  const state = {
    dataLayer: "sampled-grid-test",
    playbackRate: 1,
    playIntervalMs: 1400,
    dataFrameStore: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      stats: {},
    },
    playbackCache: {
      windowBehind: 1,
      highWatermark: 10,
      lowWatermark: 5,
      startupWatermark: 5,
      resumeWatermark: 5,
      isBackgroundPreloading: false,
      buffering: false,
      bufferStatus: "idle",
      bufferReady: 0,
      bufferRequired: 0,
      bufferResume: 0,
      bufferCurrentDate: "",
      bufferTargetIndex: -1,
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
    DataFrameStore: {
      snapshot: () => ({ bytes: 0, maxBytes: state.dataFrameStore.maxBytes }),
      inspect: () => ({ status: "missing" }),
    },
    FrameIdentity: {
      normalizeRequest: (request) => ({ ...request }),
      scopeKey: (request) => JSON.stringify({ ...request, date: "" }),
    },
    PlaybackPreheater: {
      setScope() {},
      reconcile() {},
      snapshot: () => ({ status: "IDLE", readyAhead: 0, inflight: 0 }),
      stop() {},
      waitForDates,
    },
    AdaptiveWatermarkController: {
      preview({ fixedPolicy }) {
        return { strategy: "fixed", status: "FIXED", ...fixedPolicy };
      },
      resolve({ fixedPolicy }) {
        return { strategy: "fixed", status: "FIXED", ...fixedPolicy };
      },
      reset() {},
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
  const createPlaybackCacheService = vm.runInContext("globalThis.createPlaybackCacheService", context);
  const PlaybackCacheService = createPlaybackCacheService({
    targetState: state,
    dataFrameStore: globals.DataFrameStore,
    preheater: globals.PlaybackPreheater,
    watermarkController: globals.AdaptiveWatermarkController,
    frameIdentity: globals.FrameIdentity,
    sampledGridLayerPredicate: globals.isSampledGridLayer,
  });
  return { PlaybackCacheService, state, statuses };
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

test("playback publishes a semantic active-date event before loading the frame", async () => {
  const { PlaybackRenderer, events, order } = loadPlaybackRenderer();
  const dateInput = { value: "2024-01-01" };
  await PlaybackRenderer.showDate({
    date: "2024-01-02",
    dateInput,
    updateControls: () => order.push("controls"),
    reloadActiveLayer: async () => order.push("reload"),
    afterRender: () => order.push("after"),
    source: "test",
  });

  assert.equal(dateInput.value, "2024-01-02");
  assert.deepEqual(order, ["controls", "event:2024-01-02", "reload", "after"]);
  assert.equal(events[0].type, "rrkal:active-date-changed");
  assert.deepEqual(plain(events[0].detail), {
    date: "2024-01-02",
    previousDate: null,
    source: "test",
  });

  await PlaybackRenderer.showDate({
    date: "2024-01-02",
    dateInput,
    reloadActiveLayer: async () => order.push("reload-same-date"),
  });
  assert.equal(events.length, 1);
});

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
    inspectFrame: engineFrameInspector(service),
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
    attempts: 2,
    stateName: "fetching",
    errorMessage: "",
  });
});

test("a ready target renders immediately when no recovery gate is active", () => {
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
    inspectFrame: engineFrameInspector(service),
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

test("an active recovery gate blocks a ready target until the resume watermark", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  const service = cacheService({ readyDates: ["2024-01-02"] });
  const decision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex: 1,
    hasCacheLayer: true,
    inspectFrame: engineFrameInspector(service),
    resumeGate: { active: true, readyCount: 1, required: 3 },
  });

  assert.equal(decision.state, PlaybackFrameBuffer.FRAME_STATES.waiting);
  assert.equal(decision.renderIndex, -1);
  assert.equal(decision.readyCount, 1);
  assert.equal(decision.requiredCount, 3);
  assert.equal(decision.resumeCount, 3);
  assert.equal(decision.canRender, false);
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
    inspectFrame: engineFrameInspector(service),
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
    attempts: 9,
    stateName: "failed",
    errorMessage: "failed 2024-01-02",
  });
});

test("playback watermarks are explicit runtime policy", () => {
  const { PlaybackCacheService, state } = loadPlaybackCacheService();
  assert.equal(PlaybackCacheService.options().lowWatermark, 5);
  assert.equal(PlaybackCacheService.options().highWatermark, 10);
  assert.equal(PlaybackCacheService.options().effectiveStartupWatermark, 5);
  assert.equal(PlaybackCacheService.options().effectiveResumeWatermark, 5);
  state.playbackCache.highWatermark = 4;
  state.playbackCache.lowWatermark = 8;
  assert.equal(PlaybackCacheService.options().highWatermark, 4);
  assert.equal(PlaybackCacheService.options().lowWatermark, 3);
  assert.equal(PlaybackCacheService.options().effectiveStartupWatermark, 4);
  assert.equal(PlaybackCacheService.options().effectiveResumeWatermark, 4);
});

test("playback settings preview policy without applying lifecycle state", () => {
  const source = readFileSync(
    path.join(repoRoot, "static/js/playback/playback-cache-service.js"),
    "utf8",
  );
  const start = source.indexOf("function options()");
  const end = source.indexOf("function formatBytes", start);
  const body = source.slice(start, end);

  assert.match(body, /WatermarkController\.preview/);
  assert.doesNotMatch(body, /WatermarkController\.resolve/);
});

test("watermark playback awaits the engine-owned startup gate without calling the preheater from UI", () => {
  const source = readFileSync(
    path.join(repoRoot, "static/js/playback/playback-controls.js"),
    "utf8",
  );
  const start = source.indexOf("async function setPlayback(active)");
  const end = source.indexOf("async function normalizeDateInputs", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /const startPromise = PlaybackEngine\.start/);
  assert.match(body, /started = await startPromise/);
  assert.match(body, /schedulePlaybackTick\(generation\);/);
  assert.doesNotMatch(body, /state\.isPlaying/);
  assert.doesNotMatch(body, /PlaybackPreheater\.|preheatPlaybackCache|before_play/);
});

test("PlaybackEngine is the only mutable playback lifecycle truth", () => {
  const controls = readFileSync(
    path.join(repoRoot, "static/js/playback/playback-controls.js"),
    "utf8",
  );
  const fullscreen = readFileSync(
    path.join(repoRoot, "static/js/playback/fullscreen-playback-controls.js"),
    "utf8",
  );
  const app = readFileSync(
    path.join(repoRoot, "static/app.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(controls, /function playbackIsActive\(\)/);
  assert.doesNotMatch(controls, /state\.isPlaying/);
  assert.doesNotMatch(fullscreen, /state\.isPlaying/);
  assert.doesNotMatch(app, /state\.isPlaying/);
  assert.match(app, /setPlayback\(!playbackIsActive\(\)\)/);
});

test("document visibility shutdown keeps its lifecycle reason and records preheater stop first", () => {
  const app = readFileSync(
    path.join(repoRoot, "static/app.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = app.indexOf('document.addEventListener("visibilitychange"');
  const end = app.indexOf("\n  });\n}", start);
  const body = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /PlaybackPreheater\?\.stop\?\.\("document_hidden"\)/);
  assert.match(body, /stopPlayback\(\{ reason: "document_hidden" \}\)/);
  assert.ok(
    body.indexOf("PlaybackPreheater") < body.indexOf("stopPlayback"),
    "the preheater event must be attached to the active run before RUN_FINISHED clears it",
  );
});

test("playback rendering advances the preheater through PlaybackEngine only", () => {
  const source = readFileSync(
    path.join(repoRoot, "static/js/playback/playback-controls.js"),
    "utf8",
  );
  const start = source.indexOf("function markPlaybackTargetWaiting");
  const end = source.indexOf("async function advancePlaybackToTimelineTarget", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /PlaybackEngine\.requireTarget\(targetIndex\)/);
  assert.match(body, /PlaybackEngine\.markFrameVisible\(targetIndex/);
  assert.doesNotMatch(body, /PlaybackPreheater\.|queueProgressivePreheat|afterRender/);
  assert.doesNotMatch(source, /PlaybackPreheater\./);
});

test("the independent preheater has no serialized batch gate", () => {
  const preheater = readFileSync(path.join(repoRoot, "static/js/playback/playback-preheater.js"), "utf8");
  const cacheServiceSource = readFileSync(path.join(repoRoot, "static/js/playback/playback-cache-service.js"), "utf8");
  assert.match(preheater, /lane:\s*"playback-window"/);
  assert.match(preheater, /this\.inflight = new Map\(\)/);
  assert.doesNotMatch(preheater, /backgroundPreloadRun|pendingBackgroundPreload/);
  assert.doesNotMatch(cacheServiceSource, /backgroundPreloadRun|pendingBackgroundPreload/);
});

test("legacy batch cache and prefetch entrypoints are removed", () => {
  const template = readFileSync(path.join(repoRoot, "templates/index.html"), "utf8");
  const cacheServiceSource = readFileSync(path.join(repoRoot, "static/js/playback/playback-cache-service.js"), "utf8");
  assert.equal(template.includes("sampled-grid-record-cache.js"), false);
  assert.equal(template.includes("playback-prefetch-controller.js"), false);
  assert.doesNotMatch(template, /before_play|playback-cache-mode|playback-cache-max-dates/);
  assert.doesNotMatch(cacheServiceSource, /function preheat\(|waitForDates|selectFullPlaybackDates|startupBufferPlan/);
});

test("map scope updates flow through PlaybackEngine instead of addressing the preheater directly", () => {
  const apiClient = readFileSync(path.join(repoRoot, "static/js/services/api-client.js"), "utf8");
  assert.match(apiClient, /PlaybackEngine\.configure\(\{[\s\S]{0,220}requestContext,[\s\S]{0,120}currentDate: requestedDate/);
  assert.doesNotMatch(apiClient, /resolvedRequestContext|resolution:\s*actualResolution/);
  assert.doesNotMatch(apiClient, /PlaybackPreheater\.setScope\(/);
});
