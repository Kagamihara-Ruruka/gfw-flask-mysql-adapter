import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync("static/js/services/query-policy-controller.js", "utf8");

function createController(queryPolicy = {}) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const state = { queryPolicy: { ...queryPolicy } };
  let drainCount = 0;
  const controller = new context.QueryPolicyControllerCore({
    targetState: state,
    scheduler: { drain: () => { drainCount += 1; } },
  });
  return { controller, state, drainCount: () => drainCount };
}

test("query policy controller preserves total/background concurrency invariants", () => {
  const runtime = createController({
    network_concurrency: 6,
    background_network_concurrency: 3,
  });

  assert.deepEqual(
    { ...runtime.controller.setNetworkConcurrency(2) },
    { networkConcurrency: 2, backgroundConcurrency: 2 },
  );
  assert.deepEqual(
    { ...runtime.controller.setBackgroundConcurrency(9) },
    { networkConcurrency: 2, backgroundConcurrency: 2 },
  );
  assert.equal(runtime.state.queryPolicy.network_concurrency, 2);
  assert.equal(runtime.state.queryPolicy.background_network_concurrency, 2);
  assert.equal(runtime.drainCount(), 2);
});

test("query policy controller clamps invalid UI values and returns immutable snapshots", () => {
  const runtime = createController();
  const snapshot = runtime.controller.configure({
    networkConcurrency: "not-a-number",
    backgroundConcurrency: 2.9,
  });

  assert.deepEqual(
    { ...snapshot },
    { networkConcurrency: 6, backgroundConcurrency: 2 },
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(runtime.drainCount(), 1);
});
