import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function steppingClock(stepMs = 10) {
  let value = 0;
  return {
    now: () => (value += stepMs),
    wallNowIso: () => "2026-07-16T00:00:00.000Z",
  };
}

function load(file, context = {}) {
  const sandbox = {
    Date,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Set,
    String,
    console,
    performance: { now: (() => { let value = 0; return () => value += 10; })() },
    ...context,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox);
  return sandbox;
}

test("frame identity separates requested intent from actual returned resolution", () => {
  const context = load("static/js/services/frame-identity.js", {
    state: {
      datasets: {
        ocean: {
          backend: "endpoint",
          sampled_grid: { mapping_version: "v7" },
        },
      },
    },
  });
  const identity = vm.runInContext(
    "createFrameIdentity({ datasetResolver: (datasetId) => state.datasets?.[datasetId] || {} })",
    context,
  );
  const request = {
    datasetId: "ocean",
    date: "2020-01-01",
    bbox: "120.12345644,10,130,20",
    limit: "max",
    columns: "render",
    resolution: 4,
  };
  const intentKey = identity.intentKey(request);
  const frameKey = identity.frameKey(request, { grid: { actual_resolution_km: 16 } });
  assert.match(intentKey, /\|4\|4\|fixed$/);
  assert.match(frameKey, /\|4\|4\|16\|fixed$/);
  assert.notEqual(intentKey, frameKey);
  assert.equal(identity.bboxSignature(request.bbox), "120.123456,10.000000,130.000000,20.000000");
});

test("effective query resolution preserves logical intent but changes physical identity", () => {
  const context = load("static/js/services/frame-identity.js", {
    state: {
      datasets: {
        ocean: {
          backend: "endpoint",
          sampled_grid: { mapping_version: "v7" },
        },
      },
    },
  });
  const identity = vm.runInContext(
    "createFrameIdentity({ datasetResolver: (datasetId) => state.datasets?.[datasetId] || {} })",
    context,
  );
  const requested = identity.normalizeRequest({
    datasetId: "ocean",
    date: "2020-01-01",
    bbox: "120,10,130,20",
    resolution: 4,
  });
  const routed = identity.normalizeRequest({ ...requested, queryResolution: 16 });

  assert.equal(routed.resolution, 4);
  assert.equal(routed.requestedResolutionKm, 4);
  assert.equal(routed.queryResolution, 16);
  assert.equal(identity.requestedIntentKey(routed), identity.requestedIntentKey(requested));
  assert.notEqual(identity.intentKey(routed), identity.intentKey(requested));
  assert.notEqual(identity.scopeKey(routed), identity.scopeKey(requested));
  assert.match(identity.intentKey(routed), /\|4\|16\|fixed$/);
  assert.match(identity.frameKey(routed), /\|4\|16\|16\|fixed$/);
});

test("frame identity carries provider transport truth without changing cache identity", () => {
  const context = load("static/js/services/frame-identity.js", {
    state: {
      datasets: {
        chlorophyll: { query_transport_key: "provider:8791", cache_namespace: "chlor-cache" },
        temperature: { query_transport_key: "provider:8791", cache_namespace: "temp-cache" },
      },
    },
  });
  const identity = vm.runInContext(
    "createFrameIdentity({ datasetResolver: (datasetId) => state.datasets?.[datasetId] || {} })",
    context,
  );
  const chlorophyll = identity.normalizeRequest({ datasetId: "chlorophyll" });
  const temperature = identity.normalizeRequest({ datasetId: "temperature" });

  assert.equal(chlorophyll.transportKey, "provider:8791");
  assert.equal(temperature.transportKey, "provider:8791");
  assert.notEqual(chlorophyll.cacheNamespace, temperature.cacheNamespace);
});

test("lifecycle log computes user-perceived stall and cadence metrics", () => {
  const context = load("static/js/services/lifecycle-event-log.js", {
    state: { lifecycleEvents: { maxEntries: 1000 } },
  });
  const LifecycleEventLogCore = vm.runInContext("globalThis.LifecycleEventLogCore", context);
  const log = new LifecycleEventLogCore({
    maxEntriesProvider: () => 1000,
    clock: steppingClock(),
  });
  const runId = log.beginRun({ run_id: "annual-audit" });
  log.record("FRAME_VISIBLE", { run_id: runId, frame_key: "f1" });
  log.record("BUFFER_ENTERED", { run_id: runId, intent_key: "i2" });
  log.record("CACHE_MISS", { run_id: runId, intent_key: "i2" });
  log.record("TASK_DISPATCHED", { run_id: runId, intent_key: "i2", wait_ms: 12, queue_depth: 4 });
  log.record("QUERY_OPERATION_STARTED", { run_id: runId, intent_key: "i2" });
  log.record("HTTP_BATCH_STARTED", { run_id: runId, batch_id: "b1" });
  log.record("HTTP_BATCH_FINISHED", { run_id: runId, batch_id: "b1", duration_ms: 18 });
  log.record("QUERY_OPERATION_FINISHED", { run_id: runId, intent_key: "i2" });
  log.record("CACHE_READY", { run_id: runId, intent_key: "i2" });
  log.record("BUFFER_RESUMED", { run_id: runId, intent_key: "i2", frame_key: "f2" });
  log.record("RENDER_STARTED", { run_id: runId, intent_key: "i2", frame_key: "f2" });
  log.record("FRAME_VISIBLE", { run_id: runId, intent_key: "i2", frame_key: "f2", render_ms: 7 });
  log.endRun({ run_id: runId });

  const summary = log.summary(runId);
  assert.equal(summary.frameCount, 2);
  assert.equal(summary.cacheMisses, 1);
  assert.equal(summary.stallCount, 1);
  assert.equal(summary.totalStallMs, 80);
  assert.equal(summary.cadenceP95Ms, 110);
  assert.equal(summary.phases.queue.p95Ms, 12);
  assert.equal(summary.phases.network.p95Ms, 18);
  assert.equal(summary.phases.cacheCommit.p95Ms, 10);
  assert.equal(summary.phases.render.p95Ms, 7);
  assert.equal(summary.maxQueueDepth, 4);
  assert.equal(summary.httpRequests, 1);
  assert.equal(summary.queryOperations, 1);
  assert.equal(JSON.parse(log.exportRun(runId)).schema, "rrkal.lifecycle-events.v2");
});

test("scope cancellation closes an active stall instead of leaving it open", () => {
  const context = load("static/js/services/lifecycle-event-log.js", {
    state: { lifecycleEvents: { maxEntries: 1000 } },
  });
  const LifecycleEventLogCore = vm.runInContext("globalThis.LifecycleEventLogCore", context);
  const log = new LifecycleEventLogCore({
    maxEntriesProvider: () => 1000,
    clock: steppingClock(),
  });
  const runId = log.beginRun({ run_id: "scope-change" });
  log.record("BUFFER_ENTERED", { run_id: runId, intent_key: "old-scope" });
  log.record("BUFFER_CANCELLED", {
    run_id: runId,
    intent_key: "old-scope",
    duration_ms: 25,
    reason: "scope_changed",
  });
  log.endRun({ run_id: runId });

  const summary = log.summary(runId);
  assert.equal(summary.stallCount, 1);
  assert.equal(summary.activeStallCount, 0);
  assert.equal(summary.totalStallMs, 25);
});

test("lifecycle summaries pair each ready frame with the latest queued intent", () => {
  const context = load("static/js/services/lifecycle-event-log.js");
  const LifecycleEventLogCore = vm.runInContext("globalThis.LifecycleEventLogCore", context);
  const log = new LifecycleEventLogCore({
    maxEntriesProvider: () => 1000,
    clock: steppingClock(),
  });
  const runId = log.beginRun({ run_id: "linear-ready-pairing", scope_key: "scope-a" });
  log.record("TASK_QUEUED", {
    run_id: runId,
    intent_key: "frame-a",
    lane: "playback-window",
    scope_key: "scope-a",
    monotonic_ms: 100,
  });
  log.record("CACHE_READY", {
    run_id: runId,
    intent_key: "frame-a",
    lane: "playback-window",
    scope_key: "scope-a",
    monotonic_ms: 160,
  });
  log.record("TASK_QUEUED", {
    run_id: runId,
    intent_key: "frame-a",
    lane: "playback-window",
    scope_key: "scope-a",
    monotonic_ms: 200,
  });
  log.record("CACHE_READY", {
    run_id: runId,
    intent_key: "frame-a",
    lane: "playback-window",
    scope_key: "scope-a",
    monotonic_ms: 230,
  });
  log.endRun({ run_id: runId, monotonic_ms: 240 });

  const summary = log.summary(runId);
  assert.equal(summary.trustedMetrics.supply_samples, 2);
  assert.equal(summary.trustedMetrics.cache_ready_latency_samples, 2);
  assert.equal(summary.trustedMetrics.cache_ready_latency_p95, 60);
  assert.equal(
    Array.from(log.query({ run_id: runId, limit: 2 }), (event) => event.type).join(","),
    "CACHE_READY,RUN_FINISHED",
  );
  assert.equal(log.latest({ run_id: runId, type: "TASK_QUEUED" }).monotonic_ms, 200);
});
