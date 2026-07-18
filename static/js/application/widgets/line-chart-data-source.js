(() => {
const {
  widgetDateKey,
  widgetFormatDateLabel,
  widgetMetricForDataset,
} = globalThis.WidgetApplicationFunctions;

class LineChartDataSource {
  constructor({
    stateProvider,
    queryContext,
    dataFrameStore,
    frameDemandService,
    renderIntentService,
    selectedRangeProvider,
    dateBoundsProvider,
    eventSink,
  } = {}) {
    if (typeof stateProvider !== "function" || !queryContext || !dataFrameStore || !frameDemandService) {
      throw new TypeError("LineChartDataSource requires state, query and cache dependencies");
    }
    this.stateProvider = stateProvider;
    this.queryContext = queryContext;
    this.dataFrameStore = dataFrameStore;
    this.frameDemandService = frameDemandService;
    this.renderIntentService = renderIntentService;
    this.selectedRangeProvider = selectedRangeProvider;
    this.dateBoundsProvider = dateBoundsProvider;
    this.eventSink = eventSink;
    this.errors = new Map();
    this.inflight = new Map();
    this.pointCache = new Map();
    this.generation = 0;
    this.windowDays = 30;
  }

  state() {
    return this.stateProvider() || {};
  }

  clear() {
    this.generation += 1;
    this.cancelFills({ reason: "source_cleared" });
    this.errors.clear();
    this.inflight.clear();
    this.pointCache.clear();
  }

  cancelFills({ lane = "", reason = "cancelled" } = {}) {
    let cancelled = 0;
    for (const entry of this.inflight.values()) {
      if (lane && entry.lane !== lane) continue;
      cancelled += 1;
      this.frameDemandService.cancelScope?.(entry.scopeId, { includeActive: true });
    }
    return cancelled;
  }

  dispose() {
    this.clear();
  }

  selectedCell() {
    return this.queryContext.selectedCell();
  }

  scopeDates(selected = null) {
    const state = this.state();
    const lockedAxis = selected?.time_binding?.kind === "locked_axis"
      ? selected.time_binding.axis
      : null;
    const available = Array.isArray(state.availableDates) ? state.availableDates : [];
    if (!available.length) return [];
    if (!lockedAxis) {
      const selectedRange = this.selectedRangeProvider?.();
      if (Array.isArray(selectedRange)) return selectedRange;
    }
    const bounds = this.dateBoundsProvider?.() || {};
    let start = lockedAxis?.start || bounds.start || available[0];
    let end = lockedAxis?.end || bounds.end || available[available.length - 1];
    if (start > end) [start, end] = [end, start];
    return available.filter((date) => date >= start && date <= end);
  }

  selectedDates(selected = null) {
    const scope = this.scopeDates(selected);
    if (!scope.length) return [];
    const anchor = this.queryContext.currentDate(selected) || scope[0];
    const exactIndex = scope.indexOf(anchor);
    const laterIndex = scope.findIndex((date) => date >= anchor);
    const anchorIndex = exactIndex >= 0
      ? exactIndex
      : laterIndex >= 0
        ? laterIndex
        : scope.length - 1;
    const windowSize = Math.min(scope.length, (this.windowDays * 2) + 1);
    const startIndex = Math.min(
      Math.max(0, anchorIndex - this.windowDays),
      scope.length - windowSize,
    );
    return scope.slice(startIndex, startIndex + windowSize);
  }

  anchorDate(selected, dates) {
    const requested = widgetDateKey(this.queryContext.currentDate(selected));
    if (requested && dates.includes(requested)) return requested;
    const later = dates.find((date) => date >= requested);
    return later || dates[dates.length - 1] || "";
  }

  displayDateRange(dates) {
    return dates.length ? [dates[0], dates[dates.length - 1]] : [];
  }

  selectedBbox(selected) {
    return Array.isArray(selected?.bbox) && selected.bbox.length === 4 ? selected.bbox : null;
  }

  selectedBboxString(selected) {
    const bbox = this.selectedBbox(selected);
    if (!bbox) return "";
    return selected.bbox_string || bbox.map((value) => Number(value).toFixed(6)).join(",");
  }

  statusModel(stateName, title, detail, extra = {}) {
    return {
      state: stateName,
      title,
      detail,
      metric: extra.metric || "指標值",
      unit: extra.unit || "",
      xLabel: "時間",
      yLabel: extra.yLabel || "值",
      labels: [],
      compactLabels: [],
      series: [],
      selection: extra.selection || null,
      rowCount: 0,
      pointCount: 0,
    };
  }

  requestForCurrentState() {
    const state = this.state();
    const datasetId = state.datasetId;
    const dataset = state.datasets?.[datasetId] || null;
    const selected = this.selectedCell();
    if (!selected) {
      return { blocked: this.statusModel("waiting", "等待網格選取", "尚未點選取樣網格") };
    }
    if (selected.dataset_id && datasetId && selected.dataset_id !== datasetId) {
      return { blocked: this.statusModel("waiting", "等待重新選取", "目前資料集已切換", { selection: selected }) };
    }
    const bboxString = this.selectedBboxString(selected);
    if (!bboxString) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 bbox", { selection: selected }) };
    }
    const dates = this.selectedDates(selected);
    if (!dates.length) {
      return { blocked: this.statusModel("waiting", "等待時間區間", "尚未取得播放器時間序列", { selection: selected }) };
    }
    const metric = widgetMetricForDataset(dataset);
    if (!datasetId || !dataset || !metric) {
      return { blocked: this.statusModel("waiting", "等待資料合約", "目前圖層沒有可查詢指標", { selection: selected }) };
    }
    const aggregation = "sum";
    const start = dates[0];
    const end = dates[dates.length - 1];
    const anchorDate = this.anchorDate(selected, dates);
    const xRange = this.displayDateRange(dates);
    const layer = {
      datasetId,
      layerId: dataset.layer_id || dataset.data_layer || datasetId,
      label: dataset.label || datasetId,
    };
    const resolution = this.queryContext.requestedResolutionFor(layer);
    const queryResolution = this.queryContext.resolutionFor(layer, selected);
    const mapSnapshot = this.queryContext.mapSnapshot();
    const key = [
      datasetId,
      metric,
      aggregation,
      start,
      end,
      resolution ?? "auto",
      queryResolution ?? "auto",
      bboxString,
    ].join("|");
    return {
      key,
      datasetId,
      dataset,
      selected,
      dates,
      metric,
      aggregation,
      bboxString,
      resolution,
      queryResolution,
      zoom: mapSnapshot.zoom ?? null,
      latitude: selected?.center?.lat ?? mapSnapshot.latitude ?? null,
      start,
      end,
      anchorDate,
      xRange,
      windowDays: this.windowDays,
    };
  }

  model() {
    const request = this.requestForCurrentState();
    if (request.blocked) return request.blocked;
    const snapshots = this.snapshotSeries(request);
    const cachedError = this.errors.get(request.key);
    if (!snapshots.cachedDates.length && cachedError) {
      return this.statusModel("error", "查詢失敗", cachedError, {
        metric: request.metric,
        yLabel: `${request.aggregation.toUpperCase()} ${request.metric}`,
        unit: request.metric,
        selection: request.selected,
      });
    }
    if (!snapshots.cachedDates.length) {
      return this.statusModel("loading", "載入時間序列", request.selected.tile_key || "等待快取", {
        metric: request.metric,
        yLabel: `${request.aggregation.toUpperCase()} ${request.metric}`,
        unit: request.metric,
        selection: request.selected,
      });
    }
    return this.snapshotsToModel(request, snapshots);
  }

  refresh({ cause = "context_changed" } = {}) {
    this.clear();
    const playbackOwnsQuery = this.queryContext.playbackOwnsQueryLifecycle?.() === true;
    if (cause === "tile_selection") {
      return playbackOwnsQuery ? this.ensureCurrentSlice() : this.ensureCurrentWindow();
    }
    return this.ensureCurrentWindow({ allowNetwork: !playbackOwnsQuery });
  }

  ensureCurrentWindow({ allowNetwork = true } = {}) {
    const request = this.requestForCurrentState();
    if (request.blocked) return null;
    const snapshots = this.snapshotSeries(request);
    return allowNetwork && snapshots.missingDates.length ? this.fill(request) : null;
  }

  ensureCurrentSlice() {
    const request = this.requestForCurrentState();
    if (request.blocked) return null;
    const current = request.anchorDate;
    if (!current || this.dataFrameStore.inspect(this.packetRequest(request, current)).status === "ready") {
      return null;
    }
    return this.fill(request, { dates: [current], lane: "widget-interactive" });
  }

  packetRequest(request, date) {
    return {
      datasetId: request.datasetId,
      layerId: request.dataset?.layer_id || request.datasetId,
      date,
      bbox: request.bboxString,
      limit: this.renderIntentService?.unlimitedLimit?.() ?? "max",
      columns: "render",
      resolution: request.resolution,
      queryResolution: request.queryResolution,
      zoom: request.zoom,
      latitude: request.latitude,
      renderProfile: "widget.line.snapshot",
    };
  }

  packetValue(packet) {
    const frame = packet?.frame;
    if (!globalThis.CanonicalGridFrame?.isFrame(frame)) {
      return { value: null, rowCount: 0 };
    }
    const summary = frame.numericSummary("value");
    return {
      value: summary.count ? summary.sum : null,
      rowCount: frame.rowCount,
    };
  }

  pointCacheKey(request, date) {
    return [
      request.datasetId,
      request.metric,
      request.bboxString,
      request.resolution ?? "auto",
      request.queryResolution ?? "auto",
      date,
    ].join("|");
  }

  cachedPoint(request, date) {
    const key = this.pointCacheKey(request, date);
    if (this.pointCache.has(key)) return this.pointCache.get(key);
    const cached = this.dataFrameStore.inspect(this.packetRequest(request, date));
    if (cached.status !== "ready" || !cached.packet) return null;
    const point = Object.freeze({
      ...this.packetValue(cached.packet),
      timing: cached.packet.timing || {},
    });
    this.pointCache.set(key, point);
    return point;
  }

  snapshotSeries(request) {
    const points = new Map();
    const missingDates = [];
    const cachedDates = [];
    let rowCount = 0;
    let timing = {};
    for (const date of request.dates) {
      const point = this.cachedPoint(request, date);
      if (!point) {
        missingDates.push(date);
        continue;
      }
      points.set(widgetDateKey(date), point.value);
      rowCount += point.rowCount;
      timing = point.timing || timing;
      cachedDates.push(date);
    }
    return { points, missingDates, cachedDates, rowCount, timing };
  }

  cacheEventAffectsCurrent(event) {
    if (this.queryContext.playbackOwnsQueryLifecycle?.() === true) return false;
    const request = this.requestForCurrentState();
    if (request.blocked) return false;
    const detail = event?.detail || {};
    return detail.datasetId === request.datasetId && request.dates.includes(String(detail.date || ""));
  }

  fill(request, { dates = request.dates, lane = "widget-auto" } = {}) {
    const fillKey = `${request.key}|${lane}|${dates.join(",")}`;
    if (this.inflight.has(fillKey)) return this.inflight.get(fillKey).promise;
    const generation = this.generation;
    const scopeId = `widget-line:${fillKey}`;
    const loader = this.frameDemandService.demandRange({
      dates,
      bbox: request.bboxString,
      datasetId: request.datasetId,
      limit: this.renderIntentService?.unlimitedLimit?.() ?? "max",
      columns: "render",
      resolution: request.resolution,
      queryResolution: request.queryResolution,
      zoom: request.zoom,
      latitude: request.latitude,
    }, {
      lane,
      scopeId,
    })
      .then(() => {
        if (generation !== this.generation) return;
        this.errors.delete(request.key);
      })
      .catch((error) => {
        if (error?.name === "AbortError" || generation !== this.generation) return;
        this.errors.set(request.key, error.message || "snapshot cache fill failed");
      })
      .finally(() => {
        if (this.inflight.get(fillKey)?.promise === loader) this.inflight.delete(fillKey);
        if (generation !== this.generation) return;
        this.eventSink?.("rrkal:line-chart-data-changed", { key: request.key });
      });
    this.inflight.set(fillKey, { lane, promise: loader, scopeId });
    return loader;
  }

  snapshotsToModel(request, snapshots) {
    const values = request.dates.map((date) => {
      const rawValue = snapshots.points.get(widgetDateKey(date));
      if (rawValue === null || rawValue === undefined || rawValue === "") return null;
      const value = Number(rawValue);
      return Number.isFinite(value) ? value : null;
    });
    return {
      state: "ready",
      title: "網格時間序列",
      detail: snapshots.missingDates.length
        ? `${request.selected.tile_key || "選取網格"} / 快取 ${snapshots.cachedDates.length}/${request.dates.length}`
        : request.selected.tile_key || "",
      metric: request.metric,
      unit: request.metric,
      xLabel: "時間",
      yLabel: `${request.aggregation.toUpperCase()} ${request.metric}`,
      labels: request.dates,
      compactLabels: request.dates.map(widgetFormatDateLabel),
      anchorDate: request.anchorDate,
      xRange: request.xRange,
      windowDays: request.windowDays,
      series: [{
        key: "primary",
        label: request.selected.tile_key || "選取網格",
        color: "#43e28c",
        values,
      }],
      selection: request.selected,
      rowCount: snapshots.rowCount,
      pointCount: snapshots.cachedDates.length,
      timing: snapshots.timing,
    };
  }
}

globalThis.LineChartDataSource = LineChartDataSource;
})();
