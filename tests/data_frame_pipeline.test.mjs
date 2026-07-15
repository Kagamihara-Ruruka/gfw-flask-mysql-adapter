import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createContext({ fetchJson, statePatch = {} } = {}) {
  const context = {
    AbortController,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    clearTimeout,
    console,
    performance,
    setTimeout,
    fetchJson: fetchJson || (async () => ({ rows: [], row_count: 0 })),
    state: {
      datasets: {
        ocean: {
          backend: "endpoint",
          sampled_grid: { mapping_version: "v1" },
        },
      },
      queryPolicy: { network_concurrency: 3 },
      dataFrameStore: { maxEntries: 12, maxBytes: 128 * 1024 * 1024, stats: {} },
      lifecycleEvents: { maxEntries: 2000 },
      ...statePatch,
    },
    SampledGridContract: { recordResolvedResolution() {} },
    document: { getElementById: () => null },
  };
  context.window = {
    dispatchEvent() {},
  };
  vm.createContext(context);
  for (const file of [
    "static/js/core/clock-domain.js",
    "static/TimingMetrics.js",
    "static/js/services/lifecycle-event-log.js",
    "static/js/services/frame-identity.js",
    "static/js/services/layer-query-coordinator.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/frame-demand-service.js",
    "static/js/playback/playback-preheater.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/adaptive-watermark-controller.js",
    "static/js/playback/playback-renderer.js",
    "static/js/services/runtime-performance-metrics.js",
    "static/js/runtime/runtime-composition-root.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  return context;
}

function api(context, name) {
  return vm.runInContext(name, context);
}

function request(date = "2020-01-01", patch = {}) {
  return {
    datasetId: "ocean",
    layerId: "ocean.layer",
    date,
    bbox: "120,10,130,20",
    limit: "max",
    columns: "render",
    resolution: 4,
    ...patch,
  };
}

test("frame demand stores actual frame identity behind requested intent alias", async () => {
  let requests = 0;
  const context = createContext({
    fetchJson: async () => {
      requests += 1;
      return {
        rows: [{ cell_id: "a", value: 3, lat: 15, lon: 125, resolution_km: 16 }],
        row_count: 1,
        grid: { requested_resolution_km: 4, actual_resolution_km: 16 },
      };
    },
  });
  const demand = api(context, "FrameDemandService");
  const identity = api(context, "FrameIdentity");
  const store = api(context, "DataFrameStore");
  const first = await demand.demand(request(), { lane: "map-current", scopeId: "map" });
  const second = await demand.demand(request(), { lane: "widget", scopeId: "widget" });
  const actualRoute = await demand.demand(request("2020-01-01", { resolution: 16 }), {
    lane: "playback-window",
    scopeId: "preheater",
  });

  assert.equal(requests, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(actualRoute.cacheHit, true);
  assert.equal(first.intentKey, identity.intentKey(request()));
  assert.equal(first.frameKey, identity.frameKey(request(), first.packet));
  assert.notEqual(first.intentKey, first.frameKey);
  assert.equal(store.snapshot().entries, 1);
  assert.equal(store.snapshot().aliases, 2);
});

test("concurrent map and widget demand shares one HTTP request", async () => {
  let release;
  let requests = 0;
  const response = new Promise((resolve) => { release = resolve; });
  const context = createContext({
    fetchJson: async () => {
      requests += 1;
      return response;
    },
  });
  const demand = api(context, "FrameDemandService");
  const background = demand.demand(request(), { lane: "playback-window", scopeId: "preheater" });
  await flush();
  const target = demand.demand(request(), { lane: "playback-target", scopeId: "playback" });
  await flush();
  assert.equal(requests, 1);
  release({ rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  const [left, right] = await Promise.all([background, target]);
  assert.equal(left.frameKey, right.frameKey);
  assert.equal(requests, 1);
});

test("partially overlapping viewport fetches the new bbox once instead of fragmenting HTTP work", async () => {
  let requests = 0;
  const context = createContext({
    fetchJson: async () => {
      requests += 1;
      return { rows: [], row_count: 0, grid: { actual_resolution_km: 4 } };
    },
  });
  const demand = api(context, "FrameDemandService");
  const store = api(context, "DataFrameStore");
  store.put(request("2020-01-01", { bbox: "120,10,130,20" }), {
    rows: [],
    row_count: 0,
    grid: { actual_resolution_km: 4 },
  });

  await demand.demand(request("2020-01-01", { bbox: "125,10,135,20" }), {
    lane: "playback-window",
    scopeId: "preheater",
  });

  assert.equal(requests, 1);
});

test("covered bbox reuse excludes a neighboring cell that only touches the selected boundary", () => {
  const context = createContext();
  const store = api(context, "DataFrameStore");
  store.put(request("2020-01-01", { bbox: "119.6,25.6,120.1,25.9" }), {
    rows: [
      {
        cell_id: "left",
        lat: 25.75,
        lon: 119.75,
        bounds: { west: 119.66666666666669, south: 25.66666666666666, east: 119.83333333333336, north: 25.83333333333333 },
      },
      {
        cell_id: "selected",
        lat: 25.75,
        lon: 119.91666666666666,
        bounds: { west: 119.83333333333331, south: 25.66666666666666, east: 120, north: 25.83333333333333 },
      },
    ],
    row_count: 2,
    grid: { actual_resolution_km: 16 },
  });

  const selected = store.inspect(request("2020-01-01", {
    bbox: "119.833333,25.666667,120.000000,25.833333",
  }));

  assert.equal(selected.status, "ready");
  assert.deepEqual(selected.packet.rows.map((row) => row.cell_id), ["selected"]);
});

test("covered bbox inspection is read-only and does not notify cache subscribers", () => {
  const context = createContext();
  const store = api(context, "DataFrameStore");
  const sourceRequest = request("2020-01-01", { bbox: "120,10,130,20" });
  const selectedRequest = request("2020-01-01", { bbox: "122,12,124,14" });
  const source = store.put(sourceRequest, {
    rows: [{ cell_id: "selected", lat: 13, lon: 123, value: 7 }],
    row_count: 1,
    grid: { actual_resolution_km: 4 },
  });
  const changes = [];
  const unsubscribe = store.subscribe((change) => changes.push(change));
  const before = store.snapshot();

  const selected = store.inspect(selectedRequest);
  const after = store.snapshot();
  unsubscribe();

  assert.equal(selected.status, "ready");
  assert.equal(selected.frameKey, source.frameKey);
  assert.equal(selected.reusedFrom, source.frameKey);
  assert.deepEqual(selected.packet.rows.map((row) => row.cell_id), ["selected"]);
  assert.equal(after.entries, before.entries);
  assert.equal(after.aliases, before.aliases);
  assert.deepEqual(changes, []);
});

test("canonical store clips a query response to its exact requested bbox before caching", () => {
  const context = createContext();
  const store = api(context, "DataFrameStore");
  const tileRequest = request("2020-10-25", {
    bbox: "125.166667,26.500000,125.333333,26.666667",
    resolution: 16,
  });

  store.put(tileRequest, {
    rows: [
      {
        cell_id: "north-neighbor",
        lat: 26.75,
        lon: 125.25,
        bounds: {
          west: 125.16666666666669,
          south: 26.666666666666668,
          east: 125.33333333333336,
          north: 26.833333333333336,
        },
      },
      {
        cell_id: "selected",
        lat: 26.583333333333332,
        lon: 125.25,
        bounds: {
          west: 125.16666666666669,
          south: 26.499999999999996,
          east: 125.33333333333336,
          north: 26.666666666666664,
        },
      },
    ],
    row_count: 2,
    grid: { actual_resolution_km: 16 },
    timing: {},
  });

  const selected = store.inspect(tileRequest);
  assert.equal(selected.status, "ready");
  assert.deepEqual(selected.packet.rows.map((row) => row.cell_id), ["selected"]);
  assert.equal(selected.packet.row_count, 1);
  assert.equal(selected.packet.timing.canonical_bbox_clipped, true);
  assert.equal(selected.packet.timing.canonical_bbox_dropped_rows, 1);
});

test("data frame store keeps pinned entries while enforcing LRU entry budget", () => {
  const context = createContext();
  const store = api(context, "DataFrameStore");
  store.put(request("2020-01-01"), { rows: [], row_count: 0, grid: { actual_resolution_km: 4 } });
  assert.equal(store.pin(request("2020-01-01"), "renderer"), true);
  for (let day = 2; day <= 14; day += 1) {
    store.put(request(`2020-01-${String(day).padStart(2, "0")}`), {
      rows: [],
      row_count: 0,
      grid: { actual_resolution_km: 4 },
    });
  }
  assert.equal(store.snapshot().entries, 12);
  assert.equal(store.inspect(request("2020-01-01")).status, "ready");
});
