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

function cacheService({ readyDates = [], mode = "progressive" } = {}) {
  const ready = new Set(readyDates);
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
    setBufferState(nextState) {
      service.bufferState = nextState;
    },
  };
  return service;
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

test("non-progressive modes are not frame-buffer gated", () => {
  const { PlaybackFrameBuffer } = loadPlaybackCore();
  for (const mode of ["off", "before_play"]) {
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
  }
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
