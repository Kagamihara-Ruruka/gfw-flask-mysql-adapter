import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function loadCoordinator(state, { eventLog = null } = {}) {
  const context = {
    AbortController,
    Error,
    Map,
    Number,
    Promise,
    URLSearchParams,
    console,
    fetchJson: async () => ({}),
    LifecycleEventLog: eventLog,
    ...(state === undefined ? {} : { state }),
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/services/layer-query-coordinator.js"), "utf8"),
    context,
  );
  const QuerySchedulerClass = vm.runInContext("globalThis.QueryScheduler", context);
  const createCoordinator = vm.runInContext("globalThis.createLayerQueryCoordinator", context);
  const scheduler = new QuerySchedulerClass({
    concurrency: state?.queryPolicy?.network_concurrency ?? 6,
    backgroundConcurrency: state?.queryPolicy?.background_network_concurrency ?? 3,
    eventLog,
    clock: { now: () => performance.now() },
  });
  return createCoordinator({ scheduler, fetchJson: context.fetchJson });
}

test("query coordinator caps background work and leaves foreground capacity", async () => {
  const coordinator = loadCoordinator(undefined);
  const release = deferred();
  let started = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => coordinator.schedule({
    key: `request-${index}`,
    lane: "background",
    execute: async () => {
      started += 1;
      await release.promise;
      return index;
    },
  }));

  await flush();
  assert.equal(started, 3);
  assert.equal(coordinator.snapshot().active.length, 3);
  assert.equal(coordinator.snapshot().queued.length, 5);
  assert.equal(coordinator.snapshot().backgroundConcurrency, 3);

  let foregroundStarted = false;
  const foreground = coordinator.schedule({
    key: "foreground",
    lane: "playback-target",
    execute: () => {
      foregroundStarted = true;
      return "foreground";
    },
  });
  await flush();
  assert.equal(foregroundStarted, true);
  assert.equal(await foreground, "foreground");

  release.resolve();
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("queued playback work runs before widget and background fills", async () => {
  const coordinator = loadCoordinator({ queryPolicy: { network_concurrency: 1 } });
  const release = deferred();
  const order = [];
  const blocker = coordinator.schedule({
    key: "blocker",
    lane: "background",
    execute: async () => {
      await release.promise;
      order.push("blocker");
    },
  });
  await flush();

  const background = coordinator.schedule({
    key: "background",
    lane: "background",
    execute: () => { order.push("background"); },
  });
  const widget = coordinator.schedule({
    key: "widget",
    lane: "widget-interactive",
    execute: () => { order.push("widget"); },
  });
  const playback = coordinator.schedule({
    key: "playback",
    lane: "playback-window",
    execute: () => { order.push("playback"); },
  });
  const map = coordinator.schedule({
    key: "map",
    lane: "map-current",
    execute: () => { order.push("map"); },
  });

  release.resolve();
  await Promise.all([blocker, background, widget, playback, map]);
  assert.deepEqual(order, ["blocker", "map", "playback", "widget", "background"]);
});

test("cancelling queued background work does not affect completed results", async () => {
  const coordinator = loadCoordinator({ queryPolicy: { network_concurrency: 1 } });
  const release = deferred();
  const completed = await coordinator.schedule({
    key: "completed",
    lane: "map-current",
    execute: () => ({ rows: [1, 2, 3] }),
  });
  const blocker = coordinator.schedule({
    key: "blocker",
    lane: "map-current",
    execute: () => release.promise,
  });
  await flush();
  let executed = false;
  const queued = coordinator.schedule({
    key: "prewarm",
    lane: "background",
    execute: () => { executed = true; },
  });

  coordinator.cancelPending({ lane: "background", includeActive: true });
  await assert.rejects(queued, (error) => error?.name === "AbortError");
  assert.deepEqual(completed, { rows: [1, 2, 3] });
  assert.equal(executed, false);

  release.resolve();
  await blocker;
});

test("lane cancellation removes only widget-auto consumers from shared foreground work", async () => {
  const recorded = [];
  const coordinator = loadCoordinator(
    { queryPolicy: { network_concurrency: 1 } },
    { eventLog: { record: (type, detail) => recorded.push({ type, detail }) } },
  );
  const release = deferred();
  const widget = coordinator.schedule({
    key: "shared-frame",
    lane: "widget-auto",
    execute: async () => {
      await release.promise;
      return "shared";
    },
  });
  await flush();
  const foreground = coordinator.schedule({
    key: "shared-frame",
    lane: "map-current",
    execute: () => "unused",
  });

  assert.equal(coordinator.cancelPending({
    lane: "widget-auto",
    includeActive: true,
    reason: "playback_started",
  }), 1);
  await assert.rejects(widget, (error) => error?.name === "AbortError");
  release.resolve();
  assert.equal(await foreground, "shared");
  const cancellation = recorded.find((event) => event.type === "QUERY_TASKS_CANCELLED");
  assert.equal(cancellation?.detail?.cancelled_consumers, 1);
  assert.equal(cancellation?.detail?.reason, "playback_started");
});

test("same key shares one execution and queued work is promoted", async () => {
  const recorded = [];
  const coordinator = loadCoordinator(
    { queryPolicy: { network_concurrency: 1 } },
    { eventLog: { record: (type, detail) => recorded.push({ type, detail }) } },
  );
  const release = deferred();
  const blocker = coordinator.schedule({
    key: "blocker",
    lane: "map-current",
    execute: () => release.promise,
  });
  await flush();

  let executions = 0;
  const background = coordinator.schedule({
    key: "shared-frame",
    lane: "background",
    execute: () => {
      executions += 1;
      return { rows: [1] };
    },
  });
  const target = coordinator.schedule({
    key: "shared-frame",
    lane: "playback-target",
    execute: () => {
      executions += 1;
      return { rows: [2] };
    },
  });

  assert.equal(coordinator.snapshot().queued[0].lane, "playback-target");
  assert.equal(recorded.some((event) => event.type === "TASK_PROMOTED"), true);
  release.resolve();
  await blocker;
  assert.deepEqual(await background, { rows: [1] });
  assert.deepEqual(await target, { rows: [1] });
  assert.equal(executions, 1);
});

test("scope cancellation removes only that consumer from shared work", async () => {
  const coordinator = loadCoordinator({ queryPolicy: { network_concurrency: 1 } });
  const release = deferred();
  let executions = 0;
  const first = coordinator.schedule({
    key: "shared",
    lane: "playback-window",
    scopeId: "old-scope",
    execute: async () => {
      executions += 1;
      await release.promise;
      return 42;
    },
  });
  const second = coordinator.schedule({
    key: "shared",
    lane: "widget-interactive",
    scopeId: "current-scope",
    execute: () => 99,
  });
  await flush();

  assert.equal(coordinator.cancelScope("old-scope"), 1);
  await assert.rejects(first, (error) => error?.name === "AbortError");
  release.resolve();
  assert.equal(await second, 42);
  assert.equal(executions, 1);
});

test("a new scope never attaches to an aborted execution with the same key", async () => {
  const coordinator = loadCoordinator({ queryPolicy: { network_concurrency: 1 } });
  const oldRelease = deferred();
  let executions = 0;
  const oldRequest = coordinator.schedule({
    key: "same-frame",
    lane: "playback-window",
    scopeId: "old-scope",
    execute: async () => {
      executions += 1;
      await oldRelease.promise;
      return "old";
    },
  });
  await flush();
  assert.equal(coordinator.cancelScope("old-scope"), 1);
  await assert.rejects(oldRequest, (error) => error?.name === "AbortError");

  const currentRequest = coordinator.schedule({
    key: "same-frame",
    lane: "playback-target",
    scopeId: "current-scope",
    execute: () => {
      executions += 1;
      return "current";
    },
  });
  assert.equal(await currentRequest, "current");
  assert.equal(executions, 2);
  oldRelease.resolve();
});
