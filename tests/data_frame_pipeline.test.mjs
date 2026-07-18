import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition was not reached");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function canonicalTransport(rows = []) {
  const values = Array.isArray(rows) ? rows : [];
  const frameFields = {};
  for (const field of ["date", "resolution_km"]) {
    if (values.length && values.every((row) => Object.hasOwn(row || {}, field))) {
      const first = values[0][field];
      if (values.every((row) => row[field] === first)) frameFields[field] = first;
    }
  }
  const rowFields = [];
  for (const row of values) {
    for (const field of Object.keys(row || {})) {
      if (field === "bounds" || Object.hasOwn(frameFields, field) || rowFields.includes(field)) continue;
      rowFields.push(field);
    }
    if (row?.bounds) {
      for (const direction of ["west", "south", "east", "north"]) {
        const field = `bounds.${direction}`;
        if (!rowFields.includes(field)) rowFields.push(field);
      }
    }
  }
  return {
    schema: "rrkal.canonical_grid_frame.v1",
    row_fields: rowFields,
    frame_fields: frameFields,
    columns: rowFields.map((field) => values.map((row) => (
      field.startsWith("bounds.") ? row?.bounds?.[field.slice(7)] ?? null : row?.[field] ?? null
    ))),
    row_count: values.length,
  };
}

function internalPacket(packet = {}) {
  if (packet.canonical_frame) return packet;
  const normalized = {
    ...packet,
    row_contract_version: "rrkal.sampled_grid.v1",
    canonical_frame: canonicalTransport(packet.rows),
    row_count: Array.isArray(packet.rows) ? packet.rows.length : 0,
  };
  delete normalized.rows;
  return normalized;
}

function framePacket(context, rows = [], patch = {}) {
  return {
    ...patch,
    frame: new context.CanonicalGridFrame(canonicalTransport(rows)),
    row_count: rows.length,
  };
}

function batchFetch(sourceFetchJson) {
  return async (url, options = {}) => {
    assert.equal(url, "/api/query/batch");
    const envelope = JSON.parse(options.body);
    const events = [{
      type: "batch.started",
      batch_id: envelope.batch_id,
      operation_count: envelope.operations.length,
    }];
    for (const operation of envelope.operations) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(operation.params || {})) {
        if (value != null) params.set(key, String(value));
      }
      try {
        const packet = internalPacket(await sourceFetchJson(
          `/api/datasets/${operation.dataset_id}/records?${params}`,
          { signal: options.signal },
        ));
        events.push({
          type: "batch.result",
          batch_id: envelope.batch_id,
          operation_id: operation.operation_id,
          status: "ok",
          packet,
        });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        events.push({
          type: "batch.result",
          batch_id: envelope.batch_id,
          operation_id: operation.operation_id,
          status: "error",
          error: error?.message || String(error),
        });
      }
    }
    events.push({
      type: "batch.completed",
      batch_id: envelope.batch_id,
      completed_count: envelope.operations.length,
    });
    return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
}

function createContext({ fetchJson, statePatch = {} } = {}) {
  const sourceFetchJson = fetchJson || (async () => ({ rows: [], row_count: 0 }));
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
    TextDecoder,
    URLSearchParams,
    clearTimeout,
    console,
    performance,
    setTimeout,
    fetch: batchFetch(sourceFetchJson),
    fetchJson: sourceFetchJson,
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
    "static/js/core/canonical-grid-frame.js",
    "static/js/services/render-intent-service.js",
    "static/js/services/layer-query-coordinator.js",
    "static/js/services/query-broker.js",
    "static/js/services/query-policy-controller.js",
    "static/js/services/data-frame-store.js",
    "static/js/services/frame-demand-service.js",
    "static/js/services/frame-demand-decorators.js",
    "static/js/playback/playback-preheater.js",
    "static/js/playback/playback-engine.js",
    "static/js/playback/adaptive-watermark-controller.js",
    "static/js/playback/playback-renderer.js",
    "static/js/playback/playback-scheduler.js",
    "static/js/playback/playback-runtime-controller.js",
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

test("active frame demand drains into cache after its last consumer leaves", async () => {
  const context = createContext();
  const source = deferred();
  let sourceSignal = null;
  const queryBroker = {
    operationStatus: () => "active",
    promoteSampledGrid: () => false,
    requestSampledGrid(_request, { signal }) {
      sourceSignal = signal;
      signal.addEventListener("abort", () => {
        const error = new Error("source transport aborted");
        error.name = "AbortError";
        source.reject(error);
      }, { once: true });
      return source.promise;
    },
  };
  const FrameDemandService = api(context, "FrameDemandServiceCore");
  const store = api(context, "DataFrameStore");
  const eventLog = api(context, "LifecycleEventLog");
  const service = new FrameDemandService({
    frameIdentity: api(context, "FrameIdentity"),
    queryBroker,
    dataFrameStore: store,
    eventLog,
    sampledGridContract: context.SampledGridContract,
    clock: api(context, "ClockDomain").monotonic,
  });
  const consumer = new AbortController();
  const result = service.demand(request(), {
    lane: "playback-window",
    scopeId: "old-scope",
    signal: consumer.signal,
  });
  await flush();

  consumer.abort();
  await assert.rejects(result, (error) => error?.name === "AbortError");
  assert.equal(sourceSignal.aborted, false);
  assert.equal(eventLog.query({ type: "QUERY_OPERATION_DRAINING" }).length, 1);

  source.resolve(framePacket(context, [{ cell_id: "kept", lat: 15, lon: 125, value: 7 }], {
    grid: { actual_resolution_km: 4 },
  }));
  await flush();
  await flush();

  assert.equal(store.inspect(request()).status, "ready");
  assert.equal(store.inspect(request()).packet.frame.valueAt("cell_id", 0), "kept");
  service.dispose();
});

test("queued frame demand still aborts when its last consumer leaves", async () => {
  const context = createContext();
  const source = deferred();
  let sourceSignal = null;
  const queryBroker = {
    operationStatus: () => "queued",
    promoteSampledGrid: () => false,
    requestSampledGrid(_request, { signal }) {
      sourceSignal = signal;
      signal.addEventListener("abort", () => {
        const error = new Error("queued source transport aborted");
        error.name = "AbortError";
        source.reject(error);
      }, { once: true });
      return source.promise;
    },
  };
  const FrameDemandService = api(context, "FrameDemandServiceCore");
  const service = new FrameDemandService({
    frameIdentity: api(context, "FrameIdentity"),
    queryBroker,
    dataFrameStore: api(context, "DataFrameStore"),
    eventLog: api(context, "LifecycleEventLog"),
    sampledGridContract: context.SampledGridContract,
    clock: api(context, "ClockDomain").monotonic,
  });
  const consumer = new AbortController();
  const result = service.demand(request(), {
    lane: "playback-window",
    scopeId: "old-scope",
    signal: consumer.signal,
  });
  await flush();

  consumer.abort();
  await assert.rejects(result, (error) => error?.name === "AbortError");
  await flush();

  assert.equal(sourceSignal.aborted, true);
  assert.equal(api(context, "LifecycleEventLog").query({ type: "QUERY_OPERATION_DRAINING" }).length, 0);
  service.dispose();
});

test("browser frame cache defaults to a bounded 512 MB budget", () => {
  const context = createContext({ statePatch: { dataFrameStore: undefined } });
  assert.equal(api(context, "DataFrameStore").snapshot().maxBytes, 512 * 1024 * 1024);
  api(context, "AppRuntime").dataFrameStatsTarget();
  assert.equal(context.state.dataFrameStore.maxBytes, 512 * 1024 * 1024);
});

test("browser frame cache clamps configured capacity to a safe heap fraction", () => {
  const context = createContext();
  const DataFrameStore = api(context, "DataFrameStoreCore");
  const configuredMaxBytes = 4 * 1024 * 1024 * 1024;
  const heapLimitBytes = 4 * 1024 * 1024 * 1024;
  const store = new DataFrameStore({
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({ maxBytes: configuredMaxBytes }),
    heapLimitProvider: () => heapLimitBytes,
    heapBudgetFraction: 0.35,
  });

  const snapshot = store.snapshot();
  assert.equal(snapshot.configuredMaxBytes, configuredMaxBytes);
  assert.equal(snapshot.heapLimitBytes, heapLimitBytes);
  assert.equal(snapshot.heapSafeMaxBytes, Math.floor(heapLimitBytes * 0.35));
  assert.equal(snapshot.maxBytes, snapshot.heapSafeMaxBytes);
  assert.equal(snapshot.heapSafetyApplied, true);
});

test("browser frame cache preserves configured capacity when heap telemetry is unavailable", () => {
  const context = createContext();
  const DataFrameStore = api(context, "DataFrameStoreCore");
  const configuredMaxBytes = 768 * 1024 * 1024;
  const store = new DataFrameStore({
    frameIdentity: api(context, "FrameIdentity"),
    clock: api(context, "ClockDomain").monotonic,
    optionsProvider: () => ({ maxBytes: configuredMaxBytes }),
  });

  const snapshot = store.snapshot();
  assert.equal(snapshot.maxBytes, configuredMaxBytes);
  assert.equal(snapshot.configuredMaxBytes, configuredMaxBytes);
  assert.equal(snapshot.heapLimitBytes, 0);
  assert.equal(snapshot.heapSafetyApplied, false);
});

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
  const second = await demand.demand(request(), { lane: "widget-interactive", scopeId: "widget" });
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
  assert.equal(first.packet.grid.requested_resolution_km, 4);
  assert.equal(first.packet.grid.effective_query_resolution_km, 4);
  assert.equal(first.packet.grid.actual_resolution_km, 16);
  assert.equal(first.packet.grid.lod_degraded, true);
  assert.equal(store.snapshot().entries, 1);
  assert.equal(store.snapshot().aliases, 2);
});

test("resolved query route sends the effective resolution while preserving requested intent", () => {
  const context = createContext();
  const identity = api(context, "FrameIdentity");
  const operationFor = api(context, "sampledGridBatchOperation");
  const routed = request("2020-01-02", { queryResolution: 16 });
  const operation = operationFor(routed, identity.intentKey(routed));

  assert.equal(operation.params.resolution, 16);
  assert.match(identity.intentKey(routed), /\|4\|fixed$/);
  assert.equal(identity.scopeKey(routed), identity.scopeKey(request("2020-01-02")));
});

test("canonical frame metadata preserves configured, routed and actual resolutions", async () => {
  let requestedUrl = "";
  const context = createContext({
    fetchJson: async (url) => {
      requestedUrl = url;
      return {
        rows: [{ cell_id: "a", value: 3, resolution_km: 16 }],
        row_count: 1,
        grid: { requested_resolution_km: 16, actual_resolution_km: 16 },
      };
    },
  });
  const demand = api(context, "FrameDemandService");
  const log = api(context, "LifecycleEventLog");
  const routed = request("2020-01-03", { queryResolution: 16 });
  const result = await demand.demand(routed, { lane: "playback-window", scopeId: "preheater" });
  const url = new URL(`http://local${requestedUrl}`);
  const ready = log.query({ type: "CACHE_READY" }).at(-1);

  assert.equal(url.searchParams.get("resolution"), "16");
  assert.equal(result.packet.grid.source_requested_resolution_km, 16);
  assert.equal(result.packet.grid.requested_resolution_km, 4);
  assert.equal(result.packet.grid.effective_query_resolution_km, 16);
  assert.equal(result.packet.grid.actual_resolution_km, 16);
  assert.equal(result.packet.grid.lod_degraded, true);
  assert.equal(ready.requested_resolution_km, 4);
  assert.equal(ready.effective_query_resolution_km, 16);
  assert.equal(ready.actual_resolution_km, 16);
});

test("render intent separates configured resolution from the effective source route", () => {
  const context = createContext();
  const identity = api(context, "FrameIdentity");
  const createService = api(context, "createRenderIntentService");
  const service = createService({
    targetState: { ...context.state, datasetId: "ocean", dataLayer: "ocean.layer" },
    bboxProvider: () => "120,10,130,20",
    viewportController: { queryBbox: () => "105,15,135,35" },
    targetMap: {
      getZoom: () => 9,
      getCenter: () => ({ lat: 23.5, lng: 121 }),
    },
    frameIdentity: identity,
    sampledGridContract: {
      requestResolution: () => 4,
      queryResolution: () => 16,
    },
    selectedDateProvider: () => "2020-01-01",
  });
  const requestPacket = service.toSampledGridPacketRequest(service.snapshot());

  assert.equal(requestPacket.resolution, 4);
  assert.equal(requestPacket.queryResolution, 16);
  assert.equal(requestPacket.bbox, "105.000000,15.000000,135.000000,35.000000");
  assert.equal("zoom" in requestPacket, false);
  assert.equal("latitude" in requestPacket, false);
  assert.equal("center" in requestPacket, false);
  assert.match(identity.intentKey(requestPacket), /\|4\|fixed$/);
});

test("scope cancellation drains dispatched HTTP into cache instead of creating phantom capacity", async () => {
  let requestStarted = false;
  let sourceSignal = null;
  const source = deferred();
  const context = createContext({
    fetchJson: async (_url, { signal } = {}) => {
      requestStarted = true;
      sourceSignal = signal;
      return source.promise;
    },
  });
  const demand = api(context, "FrameDemandService");
  const log = api(context, "LifecycleEventLog");
  const pending = demand.demand(request(), {
    lane: "playback-window",
    scopeId: "preheater:stale",
  });
  await flush();
  assert.equal(requestStarted, true);

  demand.cancelScope("preheater:stale");
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  await flush();

  assert.equal(sourceSignal.aborted, false);
  assert.equal(log.query({ type: "QUERY_OPERATION_DRAINING" }).length, 1);
  assert.equal(log.query({ type: "QUERY_OPERATION_CANCELLED" }).length, 0);
  assert.equal(log.query({ type: "QUERY_OPERATION_FAILED" }).length, 0);
  assert.equal(log.query({ type: "HTTP_BATCH_CANCELLED" }).length, 0);
  assert.equal(api(context, "DataFrameStore").snapshot().failures, 0);

  source.resolve({
    rows: [{ cell_id: "drained", value: 3, lat: 15, lon: 125, resolution_km: 4 }],
    row_count: 1,
    grid: { actual_resolution_km: 4 },
  });
  await waitFor(() => api(context, "DataFrameStore").inspect(request()).status === "ready");

  assert.equal(log.query({ type: "QUERY_OPERATION_FINISHED" }).length, 1);
  assert.equal(log.query({ type: "HTTP_BATCH_FINISHED" }).length, 1);
});

test("scope replacement waits for dispatched source work instead of oversubscribing phantom slots", async () => {
  const sourceRequests = [];
  const context = createContext({
    statePatch: {
      playbackCache: {
        watermarkStrategy: "fixed",
        highWatermark: 2,
        lowWatermark: 1,
        maxPendingFrames: 2,
        windowBehind: 0,
        scopeSettleMs: 0,
      },
    },
    fetchJson: async (url, { signal } = {}) => {
      const task = deferred();
      sourceRequests.push({ url, signal, task });
      return task.promise;
    },
  });
  const preheater = api(context, "PlaybackPreheater");
  const firstScope = request("2020-01-01", { bbox: "120,10,130,20" });
  const secondScope = request("2020-01-01", { bbox: "130,10,140,20" });
  const allDates = ["2020-01-01", "2020-01-02", "2020-01-03"];

  preheater.setScope({ dates: allDates, requestContext: firstScope, anchorDate: allDates[0] });
  await waitFor(() => sourceRequests.length === 1);
  const staleRequest = sourceRequests[0];

  preheater.setScope({ dates: allDates, requestContext: secondScope, anchorDate: allDates[0] });
  await flush();
  await flush();

  assert.equal(staleRequest.signal.aborted, false);
  assert.equal(sourceRequests.length, 1);

  staleRequest.task.resolve({
    rows: [{ cell_id: "stale", value: 1, lat: 15, lon: 125, resolution_km: 4 }],
    row_count: 1,
    grid: { actual_resolution_km: 4 },
  });
  await waitFor(() => sourceRequests.length === 2);

  assert.match(sourceRequests[1].url, /bbox=130\.000000%2C10\.000000%2C140\.000000%2C20\.000000/);
  assert.equal(api(context, "LifecycleEventLog").query({ type: "HTTP_BATCH_CANCELLED" }).length, 0);

  sourceRequests[1].task.resolve({
    rows: [{ cell_id: "current", value: 2, lat: 15, lon: 135, resolution_km: 4 }],
    row_count: 1,
    grid: { actual_resolution_km: 4 },
  });
  preheater.stop("test_complete");
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

test("an in-flight viewport request satisfies a covered widget bbox without duplicate HTTP", async () => {
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
  const viewport = request("2020-01-01", { bbox: "120,10,130,20" });
  const selectedTile = request("2020-01-01", { bbox: "122,12,124,14" });

  const mapRequest = demand.demand(viewport, {
    lane: "playback-window",
    scopeId: "playback-scope",
  });
  await flush();
  const widgetRequest = demand.demand(selectedTile, {
    lane: "widget-interactive",
    scopeId: "widget-scope",
  });
  await flush();

  assert.equal(requests, 1);
  release({
    rows: [{ cell_id: "selected", lat: 13, lon: 123, value: 7 }],
    row_count: 1,
    grid: { actual_resolution_km: 4 },
  });
  const [mapFrame, widgetFrame] = await Promise.all([mapRequest, widgetRequest]);
  assert.equal(requests, 1);
  assert.equal(mapFrame.packet.row_count, 1);
  assert.equal(widgetFrame.packet.row_count, 1);
  assert.equal(widgetFrame.packet.frame.valueAt("cell_id", 0), "selected");
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
  store.put(
    request("2020-01-01", { bbox: "120,10,130,20" }),
    framePacket(context, [], { grid: { actual_resolution_km: 4 } }),
  );

  await demand.demand(request("2020-01-01", { bbox: "125,10,135,20" }), {
    lane: "playback-window",
    scopeId: "preheater",
  });

  assert.equal(requests, 1);
});

test("covered bbox reuse excludes a neighboring cell that only touches the selected boundary", () => {
  const context = createContext();
  const store = api(context, "DataFrameStore");
  store.put(request("2020-01-01", { bbox: "119.6,25.6,120.1,25.9" }), framePacket(context, [
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
    ], { grid: { actual_resolution_km: 16 } }));

  const selected = store.inspect(request("2020-01-01", {
    bbox: "119.833333,25.666667,120.000000,25.833333",
  }));

  assert.equal(selected.status, "ready");
  assert.deepEqual([...selected.packet.frame.rows()].map((row) => row.cell_id), ["selected"]);
});

test("covered bbox inspection is read-only and does not notify cache subscribers", () => {
  const context = createContext();
  const store = api(context, "DataFrameStore");
  const sourceRequest = request("2020-01-01", { bbox: "120,10,130,20" });
  const selectedRequest = request("2020-01-01", { bbox: "122,12,124,14" });
  const source = store.put(sourceRequest, framePacket(
    context,
    [{ cell_id: "selected", lat: 13, lon: 123, value: 7 }],
    { grid: { actual_resolution_km: 4 } },
  ));
  const changes = [];
  const unsubscribe = store.subscribe((change) => changes.push(change));
  const before = store.snapshot();

  const selected = store.inspect(selectedRequest);
  const after = store.snapshot();
  unsubscribe();

  assert.equal(selected.status, "ready");
  assert.equal(selected.frameKey, source.frameKey);
  assert.equal(selected.reusedFrom, source.frameKey);
  assert.deepEqual([...selected.packet.frame.rows()].map((row) => row.cell_id), ["selected"]);
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

  store.put(tileRequest, framePacket(context, [
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
    ], { grid: { actual_resolution_km: 16 }, timing: {} }));

  const selected = store.inspect(tileRequest);
  assert.equal(selected.status, "ready");
  assert.deepEqual([...selected.packet.frame.rows()].map((row) => row.cell_id), ["selected"]);
  assert.equal(selected.packet.row_count, 1);
  assert.equal(selected.packet.timing.canonical_bbox_clipped, true);
  assert.equal(selected.packet.timing.canonical_bbox_dropped_rows, 1);
});

test("data frame store keeps pinned entries while enforcing LRU entry budget", () => {
  const context = createContext();
  const store = api(context, "DataFrameStore");
  store.put(request("2020-01-01"), framePacket(context, [], { grid: { actual_resolution_km: 4 } }));
  assert.equal(store.pin(request("2020-01-01"), "renderer"), true);
  for (let day = 2; day <= 14; day += 1) {
    store.put(
      request(`2020-01-${String(day).padStart(2, "0")}`),
      framePacket(context, [], { grid: { actual_resolution_km: 4 } }),
    );
  }
  assert.equal(store.snapshot().entries, 12);
  assert.equal(store.inspect(request("2020-01-01")).status, "ready");
});

test("shared frame memory evicts an inactive dataset before the active dataset LRU", () => {
  const context = createContext({
    statePatch: {
      datasetId: "hot",
      datasets: {
        hot: { backend: "endpoint", sampled_grid: { mapping_version: "v1" } },
        cold: { backend: "endpoint", sampled_grid: { mapping_version: "v1" } },
      },
      dataFrameStore: { maxEntries: 12, maxBytes: 128 * 1024 * 1024, stats: {} },
    },
  });
  const store = api(context, "DataFrameStore");
  const frame = (datasetId, date) => request(date, {
    datasetId,
    layerId: `${datasetId}.layer`,
  });
  const packet = framePacket(context, [], { grid: { actual_resolution_km: 4 } });

  store.put(frame("hot", "2020-01-01"), packet);
  store.put(frame("cold", "2020-01-01"), packet);
  for (let day = 2; day <= 11; day += 1) {
    store.put(frame("hot", `2020-01-${String(day).padStart(2, "0")}`), packet);
  }
  store.put(frame("hot", "2020-01-12"), packet);

  assert.equal(store.snapshot().entries, 12);
  assert.equal(store.inspect(frame("cold", "2020-01-01")).status, "missing");
  assert.equal(store.inspect(frame("hot", "2020-01-01")).status, "ready");
  assert.equal("playbackSegmentLimitBytes" in context.state.dataFrameStore.stats, false);
  assert.equal("lookupSegmentLimitBytes" in context.state.dataFrameStore.stats, false);
});
