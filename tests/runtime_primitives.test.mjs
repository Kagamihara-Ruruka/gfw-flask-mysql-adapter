import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadPrimitives() {
  const context = vm.createContext({ AbortController });
  context.globalThis = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/core/runtime-primitives.js"), "utf8"),
    context,
  );
  return {
    AsyncEpoch: context.AsyncEpoch,
    BoundedLruMap: context.BoundedLruMap,
  };
}

test("AsyncEpoch invalidates the previous signal and accepts only the latest token", () => {
  const { AsyncEpoch } = loadPrimitives();
  const epoch = new AsyncEpoch();
  const first = epoch.begin("first");
  const second = epoch.begin("second");

  assert.equal(first.signal.aborted, true);
  assert.equal(epoch.isCurrent(first), false);
  assert.equal(epoch.isCurrent(second), true);
  epoch.dispose();
  assert.equal(second.signal.aborted, true);
});

test("BoundedLruMap evicts the least recently used value and disposes it", () => {
  const { BoundedLruMap } = loadPrimitives();
  const disposed = [];
  const cache = new BoundedLruMap({
    maxEntries: 2,
    disposeValue: (value, key) => disposed.push([key, value]),
  });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);

  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("c"), true);
  assert.deepEqual(disposed, [["b", 2]]);
});
