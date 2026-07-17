import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadDecorator() {
  const context = { Math, Object, Promise, String, TypeError };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/services/frame-demand-decorators.js"), "utf8"),
    context,
  );
  return context.decorateFrameDemandService;
}

function harness(overrides = {}) {
  let now = 100;
  let disposed = 0;
  const events = [];
  const value = Object.freeze({ cacheHit: true });
  const service = {
    demand: async () => value,
    demandMany: async () => ({ completed: 2 }),
    demandRange: async () => ({ completed: 3 }),
    requestsForDates: (context) => context.dates,
    cancelScope: () => 2,
    inspect: () => ({ status: "ready" }),
    dispose: () => { disposed += 1; },
    ...overrides,
  };
  const decorated = loadDecorator()(service, {
    eventLog: { record: (type, detail) => events.push({ type, ...detail }) },
    clock: { now: () => now },
  });
  return {
    decorated,
    events,
    value,
    advance: (milliseconds) => { now += milliseconds; },
    disposed: () => disposed,
  };
}

test("demand decorator preserves results and records monotonic boundary timing", async () => {
  const testHarness = harness();
  const promise = testHarness.decorated.demand(
    { datasetId: "ocean", layerId: "chlor", date: "2020-01-01" },
    { lane: "map-current", scopeId: "map:1" },
  );
  testHarness.advance(25);
  const result = await promise;

  assert.equal(result, testHarness.value);
  assert.deepEqual(testHarness.events.map((event) => event.type), [
    "FRAME_DEMAND_STARTED",
    "FRAME_DEMAND_FINISHED",
  ]);
  assert.equal(testHarness.events[1].duration_ms, 25);
  assert.equal(testHarness.events[1].lane, "map-current");
  assert.equal(testHarness.events[1].scope_id, "map:1");
});

test("demand decorator rethrows the original failure and classifies cancellation", async () => {
  const failure = new Error("cancelled by scope");
  failure.name = "AbortError";
  const testHarness = harness({ demand: async () => { throw failure; } });

  await assert.rejects(
    testHarness.decorated.demand({ datasetId: "ocean", date: "2020-01-02" }),
    (error) => error === failure,
  );
  assert.equal(testHarness.events.at(-1).type, "FRAME_DEMAND_CANCELLED");
});

test("demand decorator delegates non-observability methods and teardown", () => {
  const testHarness = harness();

  assert.deepEqual(testHarness.decorated.requestsForDates({ dates: ["a", "b"] }), ["a", "b"]);
  assert.equal(testHarness.decorated.cancelScope("scope"), 2);
  assert.equal(testHarness.decorated.inspect({}).status, "ready");
  testHarness.decorated.dispose();
  assert.equal(testHarness.disposed(), 1);
});
