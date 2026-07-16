import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const source = fs.readFileSync(
  path.join(root, "static/js/playback/adaptive-watermark-controller.js"),
  "utf8",
);

function loadController() {
  const context = { Math, Number, Object, String };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "adaptive-watermark-controller.js" });
  return {
    Controller: vm.runInContext("AdaptiveWatermarkControllerCore", context),
    calculate: vm.runInContext("calculateAdaptiveWatermarkPolicy", context),
  };
}

function baseConfig(patch = {}) {
  const { adaptiveWatermark = {}, ...rest } = patch;
  return {
    watermarkStrategy: "adaptive",
    adaptiveWatermark: {
      minimumSupplySamples: 2,
      minimumStartupSamples: 10,
      latencySafetyFactor: 1.35,
      reserveSlices: 2,
      maxSupplyDeficitFactor: 2,
      lowRatio: 0.5,
      maxHighWatermark: 60,
      ramBudgetFraction: 0.75,
      defaultFrameBytes: 4 * 1024 * 1024,
      decreaseHoldMs: 10000,
      decreaseStep: 3,
      ...adaptiveWatermark,
    },
    ...rest,
  };
}

const fixedPolicy = {
  lowWatermark: 5,
  highWatermark: 10,
  startupWatermark: 5,
  resumeWatermark: 5,
  windowBehind: 1,
};

test("adaptive watermark falls back to the configured policy until metrics are trustworthy", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    remainingSlices: 100,
    metrics: {
      consumption_rate: 1,
      supply_rate: 0,
      supply_samples: 1,
      cache_ready_latency_samples: 1,
    },
    cacheSnapshot: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxEntries: 0,
      estimatedFrameBytes: 4 * 1024 * 1024,
    },
    config: baseConfig(),
  });

  assert.equal(policy.status, "WARMING");
  assert.equal(policy.lowWatermark, 5);
  assert.equal(policy.highWatermark, 10);
  assert.equal(policy.startupWatermark, 10);
  assert.equal(policy.resumeWatermark, 5);
});

test("an empty cache uses the configured conservative frame-size estimate", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    metrics: {},
    cacheSnapshot: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxEntries: 0,
      estimatedFrameBytes: 0,
      averageFrameBytes: 0,
    },
    config: baseConfig(),
  });

  assert.equal(policy.estimatedFrameBytes, 4 * 1024 * 1024);
  assert.equal(policy.ramBudgetFrames, 382);
});

test("tail latency and a supply deficit raise the adaptive high watermark", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    metrics: {
      consumption_rate: 4,
      supply_rate: 2,
      cache_ready_latency_p95: 5000,
      supply_samples: 6,
      cache_ready_latency_samples: 6,
    },
    cacheSnapshot: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxEntries: 0,
      estimatedFrameBytes: 4 * 1024 * 1024,
    },
    config: baseConfig(),
  });

  assert.equal(policy.status, "ADAPTIVE");
  assert.equal(policy.supplyDeficitFactor, 2);
  assert.equal(policy.tailDemandSlices, 54);
  assert.equal(policy.highWatermark, 56);
  assert.equal(policy.lowWatermark, 28);
});

test("cold startup accounts for the unsupplied tail and reports a capped degradation", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    remainingSlices: 100,
    metrics: {
      consumption_rate: 4,
      supply_rate: 2,
      cache_ready_latency_p95: 5000,
      supply_samples: 6,
      cache_ready_latency_samples: 6,
    },
    cacheSnapshot: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      estimatedFrameBytes: 4 * 1024 * 1024,
    },
    config: baseConfig(),
  });

  assert.equal(policy.startupDemandSlices, 77);
  assert.equal(policy.startupWatermark, 60);
  assert.equal(policy.resumeWatermark, 56);
  assert.equal(policy.sustainable, false);
  assert.equal(policy.degradationReason, "startup_capacity_capped");
});

test("a sustainable source keeps the configured startup and resume gates", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    remainingSlices: 365,
    metrics: {
      consumption_rate: 1,
      supply_rate: 2,
      cache_ready_latency_p95: 1000,
      supply_samples: 6,
      cache_ready_latency_samples: 6,
    },
    cacheSnapshot: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      estimatedFrameBytes: 4 * 1024 * 1024,
    },
    config: baseConfig(),
  });

  assert.equal(policy.startupWatermark, 5);
  assert.equal(policy.resumeWatermark, 5);
  assert.equal(policy.sustainable, true);
  assert.equal(policy.degradationReason, "");
});

test("speed changes during playback do not turn the remaining timeline into a startup buffer", () => {
  const { calculate } = loadController();
  const metrics = {
    playback_status: "PLAYING",
    consumption_rate: 10 / 7,
    supply_rate: 1.2,
    cache_ready_latency_p95: 10000,
    supply_samples: 15,
    cache_ready_latency_samples: 15,
  };
  const cacheSnapshot = {
    maxBytes: 2 * 1024 * 1024 * 1024,
    estimatedFrameBytes: 4 * 1024 * 1024,
  };
  const active = calculate({
    fixedPolicy,
    remainingSlices: 188,
    metrics,
    cacheSnapshot,
    config: baseConfig(),
  });
  const cold = calculate({
    fixedPolicy,
    remainingSlices: 188,
    metrics: { ...metrics, playback_status: "PREPARING" },
    cacheSnapshot,
    config: baseConfig(),
  });

  assert.equal(active.startupPhase, false);
  assert.equal(active.highWatermark, 25);
  assert.equal(active.startupWatermark, 5);
  assert.equal(active.degradationReason, "supply_below_consumption");
  assert.equal(cold.startupPhase, true);
  assert.equal(cold.highWatermark, 51);
});

test("the DataFrameStore RAM budget is a hard cap for adaptive watermarks", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    metrics: {
      consumption_rate: 4,
      supply_rate: 1,
      cache_ready_latency_p95: 10000,
      supply_samples: 6,
      cache_ready_latency_samples: 6,
    },
    cacheSnapshot: {
      maxBytes: 64 * 1024 * 1024,
      maxEntries: 0,
      estimatedFrameBytes: 16 * 1024 * 1024,
    },
    config: baseConfig(),
  });

  assert.equal(policy.ramBudgetFrames, 2);
  assert.equal(policy.highWatermark, 2);
  assert.equal(policy.lowWatermark, 1);
  assert.equal(policy.startupWatermark, 2);
  assert.equal(policy.resumeWatermark, 2);
  assert.equal(policy.reason, "ram_budget_capped");
});

test("the configured maximum is reported separately from the RAM budget", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    metrics: {
      consumption_rate: 4,
      supply_rate: 1,
      cache_ready_latency_p95: 10000,
      supply_samples: 6,
      cache_ready_latency_samples: 6,
    },
    cacheSnapshot: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxEntries: 0,
      estimatedFrameBytes: 4 * 1024 * 1024,
    },
    config: baseConfig(),
  });

  assert.ok(policy.ramBudgetFrames > 60);
  assert.equal(policy.highWatermark, 60);
  assert.equal(policy.reason, "max_watermark_capped");
});

test("the smaller configured cap wins when demand exceeds both limits", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    metrics: {
      consumption_rate: 4,
      supply_rate: 1,
      cache_ready_latency_p95: 100000,
      supply_samples: 100,
      cache_ready_latency_samples: 100,
    },
    cacheSnapshot: {
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxEntries: 0,
      estimatedFrameBytes: 7 * 1024 * 1024,
    },
    config: baseConfig(),
  });

  assert.ok(policy.ramBudgetFrames > 60);
  assert.equal(policy.highWatermark, 60);
  assert.equal(policy.reason, "max_watermark_capped");
});

test("watermark hysteresis raises immediately and lowers gradually on monotonic time", () => {
  const { Controller } = loadController();
  let now = 0;
  let config = baseConfig();
  let metrics = {
    run_id: "run-1",
    consumption_rate: 4,
    supply_rate: 2,
    cache_ready_latency_p95: 5000,
    supply_samples: 6,
    cache_ready_latency_samples: 6,
  };
  const events = [];
  const controller = new Controller({
    metricsProvider: () => metrics,
    cacheSnapshotProvider: () => ({
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxEntries: 0,
      estimatedFrameBytes: 4 * 1024 * 1024,
    }),
    configProvider: () => config,
    eventLog: { record: (type, detail) => events.push({ type, ...detail }) },
    clock: { now: () => now },
  });

  assert.equal(controller.resolve({ fixedPolicy }).highWatermark, 56);
  metrics = {
    ...metrics,
    consumption_rate: 1,
    supply_rate: 8,
    cache_ready_latency_p95: 100,
  };
  assert.equal(controller.resolve({ fixedPolicy }).highWatermark, 56);
  assert.equal(controller.snapshot().reason, "decrease_hysteresis");

  now = 10000;
  assert.equal(controller.resolve({ fixedPolicy }).highWatermark, 53);
  assert.equal(controller.snapshot().reason, "decrease_step");
  assert.equal(controller.resolve({ fixedPolicy }).highWatermark, 53);
  assert.equal(controller.snapshot().reason, "decrease_interval");

  now = 11000;
  assert.equal(controller.resolve({ fixedPolicy }).highWatermark, 50);
  assert.equal(controller.snapshot().reason, "decrease_step");

  metrics = { ...metrics, run_id: "run-2" };
  assert.equal(controller.resolve({ fixedPolicy }).highWatermark, 10);

  config = { ...config, watermarkStrategy: "fixed" };
  const fixed = controller.resolve({ fixedPolicy });
  assert.equal(fixed.strategy, "fixed");
  assert.equal(fixed.lowWatermark, 5);
  assert.equal(fixed.highWatermark, 10);
  assert.ok(events.some((event) => event.type === "WATERMARK_POLICY_CHANGED"));
});

test("an explicit rate downshift can bypass decrease hysteresis", () => {
  const { Controller } = loadController();
  let metrics = {
    run_id: "run-downshift",
    consumption_rate: 4,
    supply_rate: 2,
    cache_ready_latency_p95: 5000,
    supply_samples: 6,
    cache_ready_latency_samples: 6,
  };
  const controller = new Controller({
    metricsProvider: () => metrics,
    cacheSnapshotProvider: () => ({
      maxBytes: 2 * 1024 * 1024 * 1024,
      estimatedFrameBytes: 4 * 1024 * 1024,
    }),
    configProvider: () => baseConfig(),
    eventLog: { record() {} },
    clock: { now: () => 0 },
  });

  assert.equal(controller.resolve({ fixedPolicy }).highWatermark, 56);
  metrics = {
    run_id: "run-downshift",
    consumption_rate: 0,
    supply_rate: 0,
    cache_ready_latency_p95: 0,
    supply_samples: 0,
    cache_ready_latency_samples: 0,
  };
  const lowered = controller.resolve({ fixedPolicy, bypassDecreaseHysteresis: true });
  assert.equal(lowered.highWatermark, 10);
  assert.equal(lowered.resumeWatermark, 5);
  assert.equal(lowered.reason, "insufficient_metrics");
});

test("preview is read-only and only resolve applies a policy", () => {
  const { Controller } = loadController();
  const events = [];
  const controller = new Controller({
    metricsProvider: () => ({
      run_id: "run-preview",
      consumption_rate: 2,
      supply_rate: 2,
      cache_ready_latency_p95: 1000,
      supply_samples: 4,
      cache_ready_latency_samples: 4,
    }),
    cacheSnapshotProvider: () => ({
      maxBytes: 2 * 1024 * 1024 * 1024,
      estimatedFrameBytes: 4 * 1024 * 1024,
    }),
    configProvider: () => baseConfig(),
    eventLog: { record: (type, detail) => events.push({ type, ...detail }) },
    clock: { now: () => 100 },
  });

  const preview = controller.preview({ fixedPolicy });
  assert.equal(preview.strategy, "adaptive");
  assert.equal(controller.snapshot(), null);
  assert.equal(events.length, 0);

  controller.resolve({ fixedPolicy });
  assert.ok(controller.snapshot());
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WATERMARK_POLICY_CHANGED");
});

test("adaptive watermark timing never reads playback rate or ambient clocks", () => {
  assert.doesNotMatch(source, /playbackRate|playbackSpeed|speedMultiplier/);
  assert.doesNotMatch(source, /Date\.now|performance\.now|setTimeout|requestAnimationFrame/);
  assert.match(source, /class AdaptiveWatermarkControllerCore/);
  assert.match(source, /function calculateAdaptiveWatermarkPolicy/);
});
