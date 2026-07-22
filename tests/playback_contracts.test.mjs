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
  const { context } = loadBrowserScripts([
    "static/js/playback/playback-scheduler.js",
    "static/js/playback/playback-frame-buffer.js",
  ], globals);
  return {
    PlaybackFrameBuffer: vm.runInContext("PlaybackFrameBuffer", context),
    PlaybackScheduler: vm.runInContext("PlaybackScheduler", context),
  };
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

function loadPlaybackCacheService({
  waitForDates = async (dates) => ({
    total: dates.length,
    completed: dates.length,
    fetched: dates.length,
    cacheHits: 0,
    failed: 0,
  }),
  policyPreview = null,
} = {}) {
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
      highWatermark: 15,
      lowWatermark: 10,
      isBackgroundPreloading: false,
      buffering: false,
      bufferStatus: "idle",
      bufferReady: 0,
      bufferRequired: 0,
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
        return policyPreview
          ? policyPreview({ fixedPolicy })
          : { strategy: "fixed", status: "FIXED", ...fixedPolicy };
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
    "static/js/playback/adaptive-watermark-controller.js",
    "static/js/playback/playback-preheater.js",
    "static/js/playback/playback-cache-service.js",
  ], globals);
  const createPlaybackCacheService = vm.runInContext("globalThis.createPlaybackCacheService", context);
  const PlaybackCacheService = createPlaybackCacheService({
    targetState: state,
    dataFrameStore: globals.DataFrameStore,
    preheater: globals.PlaybackPreheater,
    watermarkController: globals.AdaptiveWatermarkController,
    fixedPolicyNormalizer: vm.runInContext("normalizedFixedWatermarkPolicy", context),
    capacityPolicyNormalizer: vm.runInContext("normalizedPlaybackCacheCapacityPolicy", context),
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

test("playback renderer propagates an explicitly non-visible frame result", async () => {
  const { PlaybackRenderer } = loadPlaybackRenderer();
  const dateInput = { value: "2024-01-01" };

  const result = await PlaybackRenderer.showDate({
    date: "2024-01-02",
    dateInput,
    reloadActiveLayer: async () => ({ visible: false, reason: "request_superseded" }),
  });

  assert.deepEqual(plain(result), { visible: false, reason: "request_superseded" });
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

  PlaybackScheduler.markFrameShown(timeline, {
    frameNumber: lateFrame,
    shownAtMs: 1_000 + 350 * 8,
  });
  assert.equal(timeline.nextFrameNumber, 2);
  assert.equal(
    PlaybackScheduler.delayUntilNextFrame(timeline, {
      nowMs: 1_000 + 350 * 8,
      fallbackIntervalMs: 350,
    }),
    350,
  );
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
  assert.equal(decision.canRender, false);

  service.setBufferState(PlaybackFrameBuffer.waitingState({
    decision,
    dates,
    targetIndex: 1,
    attempts: 2,
  }));

  assert.deepEqual(plain(service.bufferState), {
    buffering: true,
    status: "waiting",
    ready: 0,
    required: 1,
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
  assert.equal(decision.canRender, true);
  assert.equal(decision.isFallback, false);
});

test("an unresolved engine buffer gate blocks a ready target", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  const service = cacheService({ readyDates: ["2024-01-02"] });
  const decision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex: 1,
    hasCacheLayer: true,
    inspectFrame: engineFrameInspector(service),
    bufferGate: { active: true, ready: false, readyCount: 0, required: 1 },
  });

  assert.equal(decision.state, PlaybackFrameBuffer.FRAME_STATES.waiting);
  assert.equal(decision.renderIndex, -1);
  assert.equal(decision.readyCount, 0);
  assert.equal(decision.requiredCount, 1);
  assert.equal(decision.canRender, false);
});

test("a satisfied engine buffer gate releases the ready target immediately", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  const service = cacheService({ readyDates: ["2024-01-02"] });
  const decision = PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex: 0,
    targetIndex: 1,
    hasCacheLayer: true,
    inspectFrame: engineFrameInspector(service),
    bufferGate: { active: true, ready: true, readyCount: 1, required: 1 },
  });

  assert.equal(decision.state, PlaybackFrameBuffer.FRAME_STATES.ready);
  assert.equal(decision.renderIndex, 1);
  assert.equal(decision.canRender, true);
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

  service.setBufferState(PlaybackFrameBuffer.failedState({
    decision,
    dates,
    targetIndex: 1,
    attempts: 9,
    errorMessage: decision.errorMessage,
  }));

  assert.deepEqual(plain(service.bufferState), {
    buffering: false,
    status: "failed",
    ready: 0,
    required: 1,
    currentDate: "2024-01-02",
    targetIndex: 1,
    attempts: 9,
    stateName: "failed",
    errorMessage: "failed 2024-01-02",
  });
});

test("playback watermarks are explicit runtime policy", () => {
  const { PlaybackCacheService, state } = loadPlaybackCacheService();
  assert.equal(PlaybackCacheService.options().lowWatermark, 10);
  assert.equal(PlaybackCacheService.options().highWatermark, 15);
  assert.equal(PlaybackCacheService.options().effectiveTargetWatermark, 15);
  state.playbackCache.highWatermark = 4;
  state.playbackCache.lowWatermark = 8;
  assert.equal(PlaybackCacheService.options().highWatermark, 4);
  assert.equal(PlaybackCacheService.options().lowWatermark, 3);
  assert.equal(PlaybackCacheService.options().effectiveTargetWatermark, 4);
});

test("adaptive policy does not display an unknown RAM budget as zero frames", () => {
  const { PlaybackCacheService } = loadPlaybackCacheService({
    policyPreview: ({ fixedPolicy }) => ({
      ...fixedPolicy,
      strategy: "adaptive",
      status: "WARMING",
      ramBudgetFrames: null,
    }),
  });

  assert.doesNotMatch(PlaybackCacheService.policyStatusText(), /RAM 50%/);
  assert.doesNotMatch(PlaybackCacheService.policyStatusText(), /0 張/);
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

test("watermark playback delegates timing to the runtime and never calls the preheater from UI", () => {
  const source = readFileSync(
    path.join(repoRoot, "static/js/playback/playback-controls.js"),
    "utf8",
  );
  const start = source.indexOf("async function setPlayback(active)");
  const end = source.indexOf("async function normalizeDateInputs", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /const startPromise = PlaybackRuntime\.start/);
  assert.match(body, /started = await startPromise/);
  assert.match(body, /onFrameDue:[\s\S]*advancePlaybackToTimelineTarget/);
  assert.doesNotMatch(body, /schedulePlaybackTick|PlaybackEngine\.start/);
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
  );
  assert.match(controls, /function playbackIsActive\(\)/);
  assert.doesNotMatch(controls, /state\.isPlaying/);
  assert.doesNotMatch(fullscreen, /state\.isPlaying/);
  assert.doesNotMatch(app, /state\.isPlaying/);
  assert.match(app, /setPlayback\(!playbackIsActive\(\)\)/);
  assert.match(controls, /PlaybackRuntime\.frameDecision\(/);
  assert.doesNotMatch(controls, /PlaybackTimePolicy|bufferTimedOut|BUFFER_TIMEOUT/);
});

test("document visibility suspends only the playback clock and preserves the producer", () => {
  const app = readFileSync(
    path.join(repoRoot, "static/app.js"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const start = app.indexOf('document.addEventListener("visibilitychange"');
  const end = app.indexOf("\n  });\n}", start);
  const body = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /PlaybackRuntime\.suspend\(\{ reason: "document_hidden" \}\)/);
  assert.match(body, /PlaybackRuntime\.resume\(\{ reason: "document_hidden" \}\)/);
  assert.doesNotMatch(body, /stopPlayback|clearPreheater/);
  assert.doesNotMatch(body, /PlaybackPreheater|PlaybackEngine/);
});

test("page navigation preserves playback intent behind a scoped runtime suspension", () => {
  const app = readFileSync(
    path.join(repoRoot, "static/app.js"),
    "utf8",
  );
  const start = app.indexOf("function setActivePage");
  const end = app.indexOf("function bindPageTabs", start);
  const body = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /PlaybackRuntime\.suspend\(\{ reason: "dashboard_hidden" \}\)/);
  assert.match(body, /PlaybackRuntime\.resume\(\{ reason: "dashboard_hidden" \}\)/);
  assert.doesNotMatch(body, /stopPlayback/);
});

test("playback rendering advances the engine through the PlaybackRuntime facade", () => {
  const source = readFileSync(
    path.join(repoRoot, "static/js/playback/playback-controls.js"),
    "utf8",
  );
  const start = source.indexOf("function markPlaybackTargetWaiting");
  const end = source.indexOf("async function advancePlaybackToTimelineTarget", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(body, /PlaybackRuntime\.requireTarget\(targetIndex\)/);
  assert.match(body, /PlaybackRuntime\.markFrameVisible\(targetIndex/);
  assert.doesNotMatch(body, /PlaybackEngine\.|PlaybackPreheater\.|queueProgressivePreheat|afterRender/);
  assert.doesNotMatch(source, /PlaybackEngine\.|PlaybackPreheater\./);
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

test("settings expose playback policy without duplicating dashboard controls", () => {
  const template = readFileSync(path.join(repoRoot, "templates/index.html"), "utf8");
  const controls = readFileSync(path.join(repoRoot, "static/js/playback/playback-controls.js"), "utf8");

  assert.match(template, /id="play-speed"/);
  assert.match(template, /id="playback-cache-strategy"/);
  assert.doesNotMatch(template, /id="playback-rate"|測速觀測/);
  assert.doesNotMatch(controls, /playback-rate/);
});

test("map scope updates flow through PlaybackRuntime instead of core lifecycle owners", () => {
  const apiClient = readFileSync(path.join(repoRoot, "static/js/services/api-client.js"), "utf8");
  assert.match(apiClient, /PlaybackRuntime\.configure\(\{[\s\S]{0,220}requestContext,[\s\S]{0,120}currentDate: requestedDate/);
  assert.doesNotMatch(apiClient, /resolvedRequestContext|resolution:\s*actualResolution/);
  assert.doesNotMatch(apiClient, /PlaybackEngine\.|PlaybackPreheater\./);
});
