import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();

function loadWidgetClasses() {
  const context = {
    AbortController,
    Array,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "static/js/application/widgets/widget-model-functions.js",
    "static/js/application/widgets/widget-query-context.js",
    "static/js/application/widgets/line-chart-data-source.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  return {
    LineChartDataSource: vm.runInContext("LineChartDataSource", context),
    WidgetQueryContext: vm.runInContext("WidgetQueryContext", context),
  };
}

const selection = Object.freeze({
  selection_id: "tile-1",
  tile_key: "tile-1",
  bbox: [122, 12, 124, 14],
  bbox_string: "122,12,124,14",
  center: { lat: 13, lon: 123 },
});

const layer = Object.freeze({
  datasetId: "ocean",
  layerId: "ocean.layer",
  label: "Ocean",
});

test("slice widgets stay cache-only while playback owns the active query lifecycle", async () => {
  const { WidgetQueryContext } = loadWidgetClasses();
  let networkRequests = 0;
  let playbackStatus = "PLAYING";
  const queryContext = new WidgetQueryContext({
    stateProvider: () => ({}),
    selectedDateProvider: () => "2020-01-02",
    mapSnapshotProvider: () => ({ zoom: 5, latitude: 13 }),
    sampledGridContract: { queryResolution: () => 4, requestResolution: () => 4 },
    dataFrameStore: { inspect: () => ({ status: "missing" }) },
    frameDemandService: {
      async demand() {
        networkRequests += 1;
        return { packet: { rows: [{ value: 3 }] }, cacheHit: false };
      },
    },
    playbackSnapshotProvider: () => ({ status: playbackStatus }),
  });

  const playingResult = await queryContext.fetchValue(layer, selection);
  assert.equal(playingResult.status, "missing");
  assert.equal(networkRequests, 0);

  playbackStatus = "PAUSED";
  const pausedResult = await queryContext.fetchValue(layer, selection);
  assert.equal(pausedResult.status, "observed");
  assert.equal(networkRequests, 1);
});

test("line-chart active-date refresh can render cache state without filling its 61-day window", () => {
  const { LineChartDataSource } = loadWidgetClasses();
  let rangeDemands = 0;
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03"];
  const source = new LineChartDataSource({
    stateProvider: () => ({
      datasetId: "ocean",
      availableDates: dates,
      datasets: { ocean: { sampled_grid: {}, layer_id: "ocean.layer", label: "Ocean" } },
    }),
    queryContext: {
      selectedCell: () => selection,
      currentDate: () => "2020-01-02",
      resolutionFor: () => 4,
      requestedResolutionFor: () => 4,
      mapSnapshot: () => ({ zoom: 5, latitude: 13 }),
    },
    dataFrameStore: { inspect: () => ({ status: "missing" }) },
    frameDemandService: {
      demandRange() {
        rangeDemands += 1;
        return Promise.resolve({});
      },
    },
    renderIntentService: { unlimitedLimit: () => "max" },
    selectedRangeProvider: () => dates,
    dateBoundsProvider: () => ({ start: dates[0], end: dates.at(-1) }),
  });

  assert.equal(source.ensureCurrentWindow({ allowNetwork: false }), null);
  assert.equal(rangeDemands, 0);
  assert.equal(source.model().state, "loading");
});

test("line-chart source owns cache-first refresh policy", async () => {
  const { LineChartDataSource } = loadWidgetClasses();
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03"];
  const demands = [];
  let playbackOwnsQuery = true;
  const source = new LineChartDataSource({
    stateProvider: () => ({
      datasetId: "ocean",
      availableDates: dates,
      datasets: { ocean: { sampled_grid: {}, layer_id: "ocean.layer", label: "Ocean" } },
    }),
    queryContext: {
      selectedCell: () => selection,
      currentDate: () => "2020-01-02",
      resolutionFor: () => 4,
      requestedResolutionFor: () => 4,
      mapSnapshot: () => ({ zoom: 5, latitude: 13 }),
      playbackOwnsQueryLifecycle: () => playbackOwnsQuery,
    },
    dataFrameStore: { inspect: () => ({ status: "missing" }) },
    frameDemandService: {
      demandRange(request, options) {
        demands.push({ request, options });
        return Promise.resolve({});
      },
    },
    renderIntentService: { unlimitedLimit: () => "max" },
    selectedRangeProvider: () => dates,
    dateBoundsProvider: () => ({ start: dates[0], end: dates.at(-1) }),
  });

  assert.equal(source.refresh({ cause: "context_changed" }), null);
  assert.equal(demands.length, 0);

  await source.refresh({ cause: "tile_selection" });
  assert.deepEqual(Array.from(demands[0].request.dates), ["2020-01-02"]);
  assert.equal(demands[0].options.lane, "widget-interactive");

  playbackOwnsQuery = false;
  await source.refresh({ cause: "context_changed" });
  assert.deepEqual(Array.from(demands[1].request.dates), dates);
  assert.equal(demands[1].options.lane, "widget-auto");
});

test("line-chart auto fill cancels through its scheduler-owned query scope", async () => {
  const { LineChartDataSource } = loadWidgetClasses();
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03"];
  let demandOptions = null;
  let cancelledScope = "";
  let rejectDemand = null;
  const source = new LineChartDataSource({
    stateProvider: () => ({
      datasetId: "ocean",
      availableDates: dates,
      datasets: { ocean: { sampled_grid: {}, layer_id: "ocean.layer", label: "Ocean" } },
    }),
    queryContext: {
      selectedCell: () => selection,
      currentDate: () => "2020-01-02",
      resolutionFor: () => 4,
      requestedResolutionFor: () => 4,
      mapSnapshot: () => ({ zoom: 5, latitude: 13 }),
    },
    dataFrameStore: { inspect: () => ({ status: "missing" }) },
    frameDemandService: {
      cancelScope(scopeId) {
        cancelledScope = scopeId;
        const error = new Error("cancelled");
        error.name = "AbortError";
        rejectDemand?.(error);
      },
      demandRange(_request, options) {
        demandOptions = options;
        return new Promise((_resolve, reject) => { rejectDemand = reject; });
      },
    },
    renderIntentService: { unlimitedLimit: () => "max" },
    selectedRangeProvider: () => dates,
    dateBoundsProvider: () => ({ start: dates[0], end: dates.at(-1) }),
  });

  const fill = source.ensureCurrentWindow();
  assert.equal(Object.hasOwn(demandOptions, "signal"), false);
  assert.equal(source.cancelFills({ lane: "widget-auto", reason: "playback_started" }), 1);
  assert.match(cancelledScope, /^widget-line:/);
  await fill;
});
