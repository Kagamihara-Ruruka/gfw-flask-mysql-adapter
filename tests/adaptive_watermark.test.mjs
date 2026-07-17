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
      latencySafetyFactor: 1.35,
      reserveSlices: 2,
      maxSupplyDeficitFactor: 2,
      defaultFrameBytes: 4 * 1024 * 1024,
      decreaseHoldMs: 10000,
      decreaseStep: 3,
      ...adaptiveWatermark,
    },
    ...rest,
  };
}

const fixedPolicy = {
  lowWatermark: 10,
  highWatermark: 15,
  windowBehind: 1,
};

const emptyCache = {
  maxBytes: 4 * 1024 * 1024 * 1024,
  maxEntries: 0,
  estimatedFrameBytes: 0,
  averageFrameBytes: 0,
};

const observedCache = {
  maxBytes: 4 * 1024 * 1024 * 1024,
  maxEntries: 0,
  estimatedFrameBytes: 128 * 1024 * 1024,
};

test("an unobserved dataset uses the configured warm-up watermarks", () => {
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
    cacheSnapshot: emptyCache,
    config: baseConfig(),
  });

  assert.equal(policy.status, "WARMING");
  assert.equal(policy.hasObservedFrameSize, false);
  assert.equal(policy.ramBudgetFrames, null);
  assert.equal(policy.lowWatermark, 10);
  assert.equal(policy.highWatermark, 15);
  assert.equal(policy.targetWatermark, 15);
  assert.equal(policy.immediateReplenishment, false);
});

test("adaptive capacity uses half of RAM with one-third and two-thirds watermarks", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    remainingSlices: 365,
    metrics: {},
    cacheSnapshot: observedCache,
    config: baseConfig(),
  });

  assert.equal(policy.status, "WARMING");
  assert.equal(policy.hasObservedFrameSize, true);
  assert.equal(policy.playbackRamBudgetBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(policy.ramBudgetFrames, 16);
  assert.equal(policy.lowWatermark, 5);
  assert.equal(policy.highWatermark, 10);
  assert.equal(policy.targetWatermark, 10);
});

test("supply ratio is only an early refill trigger", () => {
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
    cacheSnapshot: observedCache,
    config: baseConfig(),
  });

  assert.equal(policy.status, "ADAPTIVE");
  assert.equal(policy.reason, "supply_deficit");
  assert.equal(policy.supplyRatio, 0.5);
  assert.equal(policy.immediateReplenishment, true);
  assert.equal(policy.lowWatermark, 5);
  assert.equal(policy.highWatermark, 10);
  assert.equal(policy.targetWatermark, 10);
  assert.equal(policy.tailDemandSlices, 54);
  assert.equal(policy.deficitCoverageSlices, 77);
  assert.equal(policy.degradationReason, "supply_below_consumption");
});

test("a sustainable source waits for the low watermark", () => {
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
    cacheSnapshot: observedCache,
    config: baseConfig(),
  });

  assert.equal(policy.sustainable, true);
  assert.equal(policy.immediateReplenishment, false);
  assert.equal(policy.lowWatermark, 5);
  assert.equal(policy.highWatermark, 10);
  assert.equal(policy.targetWatermark, 10);
  assert.equal(policy.degradationReason, "");
});

test("terminal tail fetches only the remaining dataset frames", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    remainingSlices: 4,
    metrics: {
      consumption_rate: 4,
      supply_rate: 1,
      cache_ready_latency_p95: 10000,
      supply_samples: 6,
      cache_ready_latency_samples: 6,
    },
    cacheSnapshot: observedCache,
    config: baseConfig(),
  });

  assert.equal(policy.status, "TAIL");
  assert.equal(policy.reason, "terminal_tail");
  assert.equal(policy.targetWatermark, 4);
  assert.equal(policy.tailMode, true);
  assert.equal(policy.sustainable, null);
  assert.equal(policy.degradationReason, "");
});

test("maxEntries remains an absolute cap after RAM conversion", () => {
  const { calculate } = loadController();
  const policy = calculate({
    fixedPolicy,
    remainingSlices: 365,
    metrics: {},
    cacheSnapshot: { ...observedCache, maxEntries: 9 },
    config: baseConfig(),
  });

  assert.equal(policy.ramBudgetFrames, 9);
  assert.equal(policy.lowWatermark, 3);
  assert.equal(policy.highWatermark, 6);
});

test("playback lifecycle status cannot alter RAM-derived watermarks", () => {
  const { calculate } = loadController();
  const metrics = {
    consumption_rate: 10 / 7,
    supply_rate: 1.2,
    cache_ready_latency_p95: 10000,
    supply_samples: 15,
    cache_ready_latency_samples: 15,
  };
  const active = calculate({
    fixedPolicy,
    remainingSlices: 188,
    metrics: { ...metrics, playback_status: "PLAYING" },
    cacheSnapshot: observedCache,
    config: baseConfig(),
  });
  const preparing = calculate({
    fixedPolicy,
    remainingSlices: 188,
    metrics: { ...metrics, playback_status: "PREPARING" },
    cacheSnapshot: observedCache,
    config: baseConfig(),
  });

  assert.equal(active.preparing, false);
  assert.equal(preparing.preparing, true);
  assert.equal(active.lowWatermark, 5);
  assert.equal(preparing.lowWatermark, 5);
  assert.equal(active.highWatermark, 10);
  assert.equal(preparing.highWatermark, 10);
});

test("controller forwards dataset partition context and publishes the refill policy", () => {
  const { Controller } = loadController();
  const contexts = [];
  const events = [];
  const controller = new Controller({
    metricsProvider: () => ({
      run_id: "run-1",
      consumption_rate: 2,
      supply_rate: 1,
      cache_ready_latency_p95: 1000,
      supply_samples: 4,
      cache_ready_latency_samples: 4,
    }),
    cacheSnapshotProvider: (context) => {
      contexts.push(context);
      return observedCache;
    },
    configProvider: () => baseConfig(),
    eventLog: { record: (type, detail) => events.push({ type, ...detail }) },
    clock: { now: () => 100 },
  });

  const policy = controller.resolve({
    fixedPolicy,
    remainingSlices: 100,
    datasetId: "pipeline_iceberg.sea_temperature",
    cacheNamespace: "sea-temperature-v1",
  });
  assert.equal(policy.targetWatermark, 10);
  assert.equal(policy.immediateReplenishment, true);
  assert.equal(contexts[0].datasetId, "pipeline_iceberg.sea_temperature");
  assert.equal(contexts[0].cacheNamespace, "sea-temperature-v1");
  assert.equal(events[0].target_watermark, 10);
  assert.equal(events[0].immediate_replenishment, true);
});

test("fixed mode retains the manually configured single target", () => {
  const { Controller } = loadController();
  const controller = new Controller({
    metricsProvider: () => ({}),
    cacheSnapshotProvider: () => observedCache,
    configProvider: () => ({ watermarkStrategy: "fixed" }),
    eventLog: { record() {} },
    clock: { now: () => 100 },
  });

  const policy = controller.resolve({ fixedPolicy });
  assert.equal(policy.strategy, "fixed");
  assert.equal(policy.lowWatermark, 10);
  assert.equal(policy.highWatermark, 15);
  assert.equal(policy.targetWatermark, 15);
  assert.equal("startupWatermark" in policy, false);
  assert.equal("resumeWatermark" in policy, false);
});

test("adaptive watermark timing never reads playback rate or ambient clocks", () => {
  assert.doesNotMatch(source, /playbackRate|playbackSpeed|speedMultiplier/);
  assert.doesNotMatch(source, /Date\.now|performance\.now|setTimeout|requestAnimationFrame/);
  assert.match(source, /class AdaptiveWatermarkControllerCore/);
  assert.match(source, /function calculateAdaptiveWatermarkPolicy/);
});
