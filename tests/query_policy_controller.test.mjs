import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync("static/js/services/query-policy-controller.js", "utf8");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createController(queryPolicy = {}, sourceCapacities = {}) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const state = {
    queryPolicy: { ...queryPolicy },
    queryPolicyServerLimits: { ...queryPolicy },
    queryTransportCapacities: { ...sourceCapacities },
  };
  let schedulerDrainCount = 0;
  let brokerReconcileCount = 0;
  const controller = new context.QueryPolicyControllerCore({
    targetState: state,
    scheduler: { drain: () => { schedulerDrainCount += 1; } },
    broker: { reconcilePolicy: () => { brokerReconcileCount += 1; } },
  });
  return {
    controller,
    state,
    schedulerDrainCount: () => schedulerDrainCount,
    brokerReconcileCount: () => brokerReconcileCount,
  };
}

test("query policy resolves requested values through server and foreground limits", () => {
  const runtime = createController({
    network_concurrency: 6,
    background_network_concurrency: 3,
    batch_max_operations: 3,
    foreground_reserved_slots: 1,
  }, { iceberg: 2 });

  const snapshot = runtime.controller.setNetworkConcurrency(2);
  assert.deepEqual(plain(snapshot.requested), {
    networkConcurrency: 2,
    backgroundConcurrency: 3,
    batchMaxOperations: 3,
    foregroundReservedSlots: 1,
  });
  assert.deepEqual(plain(snapshot.effective), {
    networkConcurrency: 2,
    backgroundConcurrency: 1,
    batchMaxOperations: 3,
    foregroundReservedSlots: 1,
  });
  assert.equal(snapshot.transports.iceberg.effectiveBatchSize, 2);
  assert.equal(snapshot.transports.iceberg.overrideReason, "source_capacity");
  assert.equal(runtime.schedulerDrainCount(), 1);
  assert.equal(runtime.brokerReconcileCount(), 1);
});

test("query policy hydrate keeps server ceilings separate from browser requests", () => {
  const runtime = createController({
    network_concurrency: 6,
    background_network_concurrency: 3,
    batch_max_operations: 3,
  });
  runtime.controller.hydrate({
    policy: {
      network_concurrency: 4,
      background_network_concurrency: 2,
      batch_max_operations: 2,
    },
    sourceCapacities: { source: 1 },
  });
  const configured = runtime.controller.configure({
    networkConcurrency: 12,
    backgroundConcurrency: 9,
    batchMaxOperations: 6,
  });

  assert.deepEqual(plain(configured.requested), {
    networkConcurrency: 12,
    backgroundConcurrency: 9,
    batchMaxOperations: 6,
    foregroundReservedSlots: 1,
  });
  assert.deepEqual(plain(configured.effective), {
    networkConcurrency: 4,
    backgroundConcurrency: 3,
    batchMaxOperations: 2,
    foregroundReservedSlots: 1,
  });
  assert.equal(configured.controls.networkConcurrency.overrideReason, "server_worker_limit");
  assert.equal(configured.controls.batchMaxOperations.overrideReason, "server_batch_limit");
  assert.equal(configured.transports.source.effectiveBatchSize, 1);
  assert.equal(runtime.state.queryPolicyServerLimits.network_concurrency, 4);
  assert.equal(runtime.schedulerDrainCount(), 2);
  assert.equal(runtime.brokerReconcileCount(), 2);
});

test("query policy returns immutable snapshots and never mutates cache state", () => {
  const runtime = createController();
  const snapshot = runtime.controller.configure({
    networkConcurrency: "not-a-number",
    backgroundConcurrency: 2.9,
  });

  assert.equal(snapshot.requested.networkConcurrency, 6);
  assert.equal(snapshot.requested.backgroundConcurrency, 2);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.effective), true);
  assert.equal(Object.hasOwn(runtime.state, "dataFrameStore"), false);
});
