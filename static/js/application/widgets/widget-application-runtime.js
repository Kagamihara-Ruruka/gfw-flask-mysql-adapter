(() => {
class WidgetApplicationRuntime {
  constructor({
    queryContext,
    sources,
    eventLog,
    eventSink,
    timingMetricsProvider,
    runtimeMetricsProvider,
    schedule,
    cancelSchedule,
  } = {}) {
    if (!queryContext || !(sources instanceof Map)) {
      throw new TypeError("WidgetApplicationRuntime requires query context and sources");
    }
    this.queryContext = queryContext;
    this.sources = sources;
    this.eventLog = eventLog || null;
    this.eventSink = eventSink;
    this.timingMetricsProvider = timingMetricsProvider;
    this.runtimeMetricsProvider = runtimeMetricsProvider;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.serviceCache = new Map();
  }

  source(widgetType) {
    return this.sources.get(String(widgetType || "")) || null;
  }

  emit(type, detail = {}) {
    this.eventSink?.(type, detail);
  }

  servicesFor(widgetType) {
    const normalized = String(widgetType || "blank");
    if (this.serviceCache.has(normalized)) return this.serviceCache.get(normalized);
    const common = {
      emit: (type, detail) => this.emit(type, detail),
      queryContext: this.queryContext,
    };
    const dataSource = this.source(normalized);
    const services = Object.freeze({
      ...common,
      ...(dataSource ? { dataSource } : {}),
      ...(normalized === "event-viewer" ? {
        eventLog: this.eventLog,
        runtimeMetricsProvider: this.runtimeMetricsProvider,
        schedule: this.schedule,
        cancelSchedule: this.cancelSchedule,
      } : {}),
      ...(normalized === "metrics" ? {
        eventLog: this.eventLog,
        timingMetricsProvider: this.timingMetricsProvider,
        runtimeMetricsProvider: this.runtimeMetricsProvider,
        schedule: this.schedule,
        cancelSchedule: this.cancelSchedule,
      } : {}),
      ...(normalized === "map-jump" ? {
        runViewAction: (id) => {
          if (!id) return false;
          this.emit("rrkal:map-view-action", { id });
          return true;
        },
      } : {}),
    });
    this.serviceCache.set(normalized, services);
    return services;
  }

  clear(widgetType) {
    this.source(widgetType)?.clear?.();
  }

  dispose() {
    for (const source of new Set(this.sources.values())) source?.dispose?.();
    this.sources.clear();
    this.serviceCache.clear();
  }
}

function createWidgetApplicationRuntime({
  stateProvider,
  layerRegistryProvider,
  tileSelectionProvider,
  selectedDateProvider,
  selectedRangeProvider,
  dateBoundsProvider,
  bboxProvider,
  mapSnapshotProvider,
  sampledGridContract,
  renderIntentService,
  dataFrameStore,
  frameDemandService,
  queryCoordinator,
  eventLog,
  eventSink,
  timingMetricsProvider,
  runtimeMetricsProvider,
  schedule,
  cancelSchedule,
} = {}) {
  const queryContext = new WidgetQueryContext({
    stateProvider,
    layerRegistryProvider,
    tileSelectionProvider,
    selectedDateProvider,
    mapSnapshotProvider,
    sampledGridContract,
    renderIntentService,
    dataFrameStore,
    frameDemandService,
  });
  const sources = new Map();
  sources.set("line-chart", new LineChartDataSource({
    stateProvider,
    queryContext,
    dataFrameStore,
    frameDemandService,
    renderIntentService,
    selectedRangeProvider,
    dateBoundsProvider,
    eventSink,
  }));
  sources.set("pie-chart", new PieChartDataSource({ queryContext, eventSink }));
  sources.set("horizontal-bar-chart", new HorizontalBarChartDataSource({ queryContext, eventSink }));
  sources.set("table", new TableWidgetDataSource({
    stateProvider,
    queryContext,
    layerRegistryProvider,
    bboxProvider,
    renderIntentService,
    sampledGridContract,
    dataFrameStore,
  }));
  sources.set("eez-attribution", new EezAttributionDataSource({
    queryContext,
    queryCoordinator,
    eventSink,
  }));
  return new WidgetApplicationRuntime({
    queryContext,
    sources,
    eventLog,
    eventSink,
    timingMetricsProvider,
    runtimeMetricsProvider,
    schedule,
    cancelSchedule,
  });
}

globalThis.WidgetApplicationRuntime = WidgetApplicationRuntime;
globalThis.createWidgetApplicationRuntime = createWidgetApplicationRuntime;
})();
