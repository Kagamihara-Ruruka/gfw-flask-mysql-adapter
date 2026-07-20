import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadDataSource() {
  const context = vm.createContext({ AbortController, console, URLSearchParams });
  context.globalThis = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/core/runtime-primitives.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(root, "static/js/application/widgets/eez-attribution-data-source.js"), "utf8"),
    context,
  );
  return context.EezAttributionDataSource;
}

function createSource() {
  const EezAttributionDataSource = loadDataSource();
  return new EezAttributionDataSource({
    queryContext: { selections: () => [], bbox: () => null },
    queryCoordinator: { fetchEezAttribution: async () => ({}) },
    clock: { now: () => 0 },
  });
}

function createRuntimeSource({
  fetchEezAttribution,
  now = () => 0,
  version = () => "v1",
  cacheMaxEntries = 2,
  retryDelayMs = 3000,
  eventSink = null,
} = {}) {
  const EezAttributionDataSource = loadDataSource();
  const selected = { tile_key: "selected", bbox: [120, 20, 121, 21] };
  return new EezAttributionDataSource({
    queryContext: {
      selections: () => [selected],
      bbox: (value) => value.bbox,
    },
    queryCoordinator: { fetchEezAttribution },
    clock: { now },
    cacheVersionProvider: version,
    cacheMaxEntries,
    retryDelayMs,
    eventSink,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const request = { selected: { tile_key: "test" } };

test("EEZ attribution distinguishes High Seas and land from the shared domain packet", () => {
  const source = createSource();
  const highSeas = source.packetToModel(request, {
    attribution: [],
    domain: { kind: "high_seas", regions: [{ kind: "high_seas", overlap_ratio: 1 }] },
  });
  const land = source.packetToModel(request, {
    attribution: [],
    domain: { kind: "land", regions: [{ kind: "land", overlap_ratio: 0.92 }] },
  });

  assert.equal(highSeas.state, "high-seas");
  assert.equal(highSeas.title, "公海");
  assert.equal(highSeas.jurisdictionKind, "high_seas");
  assert.equal(land.state, "land");
  assert.equal(land.title, "陸地");
  assert.equal(land.jurisdictionKind, "land");
});

test("EEZ attribution preserves disputed and joint regime semantics", () => {
  const source = createSource();
  const disputed = source.packetToModel(request, {
    attribution: [{ sovereign: "A", pol_type: "Overlapping claim", overlap_ratio: 1 }],
    domain: { kind: "unresolved", regions: [] },
  });
  const joint = source.packetToModel(request, {
    attribution: [{ sovereign: "A/B", pol_type: "Joint regime", overlap_ratio: 1 }],
    domain: { kind: "unresolved", regions: [] },
  });

  assert.equal(disputed.state, "ready");
  assert.equal(disputed.jurisdictionKind, "disputed");
  assert.equal(joint.state, "ready");
  assert.equal(joint.jurisdictionKind, "joint");
});

test("EEZ attribution keeps the exact-domain complement beside a primary claim", () => {
  const source = createSource();
  const model = source.packetToModel(request, {
    attribution: [{ sovereign: "Taiwan", pol_type: "Overlapping claim", overlap_ratio: 0.93 }],
    domain: {
      kind: "land",
      eez_coverage_ratio: 0.93,
      regions: [{ kind: "land", overlap_ratio: 0.07 }],
    },
  });

  assert.equal(model.state, "ready");
  assert.equal(model.jurisdictionKind, "disputed");
  assert.equal(model.domain.kind, "land");
  assert.equal(model.domain.regions[0].overlap_ratio, 0.07);
});

test("EEZ attribution does not cache a transient failure as permanent truth", async () => {
  let now = 0;
  let attempts = 0;
  const source = createRuntimeSource({
    now: () => now,
    fetchEezAttribution: async () => {
      attempts += 1;
      throw new Error("temporary");
    },
  });
  const bboxString = "120.000000,20.000000,121.000000,21.000000";
  const request = { key: bboxString, bboxString, selected: { tile_key: "cell" } };

  await source.fetch(request);
  assert.equal(source.cache.size, 0);
  assert.equal(source.failures.size, 1);

  source.model();
  assert.equal(attempts, 1);
  now = 3001;
  source.model();
  await Promise.resolve();
  assert.equal(attempts, 2);
});

test("EEZ attribution ignores late completion after disposal", async () => {
  const pending = deferred();
  let eventCount = 0;
  const source = createRuntimeSource({
    fetchEezAttribution: () => pending.promise,
    eventSink: () => { eventCount += 1; },
  });
  const request = { key: "late", bboxString: "120,20,121,21", selected: { tile_key: "late" } };
  const loading = source.fetch(request);
  source.dispose();
  pending.resolve({ attribution: [], domain: { kind: "high_seas" } });
  await loading;

  assert.equal(source.cache.size, 0);
  assert.equal(eventCount, 0);
});

test("EEZ attribution invalidates inflight work when the runtime contract changes", async () => {
  let version = "v1";
  let capturedSignal = null;
  const pending = deferred();
  const source = createRuntimeSource({
    version: () => version,
    fetchEezAttribution: (_params, options) => {
      capturedSignal = options.signal;
      return pending.promise;
    },
  });
  const request = { key: "versioned", bboxString: "120,20,121,21", selected: { tile_key: "versioned" } };
  const loading = source.fetch(request);
  version = "v2";
  source.syncCacheVersion();

  assert.equal(capturedSignal.aborted, true);
  pending.resolve({ attribution: [], domain: { kind: "high_seas" } });
  await loading;
  assert.equal(source.cache.size, 0);
});

test("EEZ attribution success cache is bounded by LRU capacity", async () => {
  const source = createRuntimeSource({
    cacheMaxEntries: 2,
    fetchEezAttribution: async () => ({ attribution: [], domain: { kind: "high_seas" } }),
  });
  for (const key of ["a", "b", "c"]) {
    await source.fetch({ key, bboxString: `${key},20,121,21`, selected: { tile_key: key } });
  }

  assert.equal(source.cache.size, 2);
  assert.equal(source.cache.has("a"), false);
  assert.equal(source.cache.has("b"), true);
  assert.equal(source.cache.has("c"), true);
});
