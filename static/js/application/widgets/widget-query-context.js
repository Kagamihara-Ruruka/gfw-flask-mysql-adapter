(() => {
const { widgetColorFor } = globalThis.WidgetApplicationFunctions;

class WidgetQueryContext {
  constructor({
    stateProvider,
    layerRegistryProvider,
    tileSelectionProvider,
    selectedDateProvider,
    mapSnapshotProvider,
    sampledGridContract,
    renderIntentService,
    dataFrameStore,
    frameDemandService,
    playbackSnapshotProvider,
  } = {}) {
    if (typeof stateProvider !== "function") throw new TypeError("WidgetQueryContext requires stateProvider");
    if (!sampledGridContract) throw new TypeError("WidgetQueryContext requires SampledGridContract");
    if (!dataFrameStore || !frameDemandService) throw new TypeError("WidgetQueryContext requires cache services");
    this.stateProvider = stateProvider;
    this.layerRegistryProvider = layerRegistryProvider;
    this.tileSelectionProvider = tileSelectionProvider;
    this.selectedDateProvider = selectedDateProvider;
    this.mapSnapshotProvider = mapSnapshotProvider;
    this.sampledGridContract = sampledGridContract;
    this.renderIntentService = renderIntentService;
    this.dataFrameStore = dataFrameStore;
    this.frameDemandService = frameDemandService;
    this.playbackSnapshotProvider = playbackSnapshotProvider;
  }

  state() {
    return this.stateProvider() || {};
  }

  sampledGridLayers({ excludedLayerIds = [] } = {}) {
    const excluded = new Set(excludedLayerIds);
    const registry = this.layerRegistryProvider?.();
    return (registry?.sampledGridLayers?.({ enabledOnly: true }) || [])
      .filter((layer) => !excluded.has(layer.layerId));
  }

  selections() {
    const state = this.state();
    const items = Array.isArray(state.tileSelection?.items) ? state.tileSelection.items : [];
    if (items.length) return items;
    if (state.tileSelection?.selected) return [state.tileSelection.selected];
    const provided = this.tileSelectionProvider?.() || [];
    return Array.isArray(provided) ? provided.filter(Boolean) : [];
  }

  selectedCell() {
    return this.selections()[0] || null;
  }

  currentDate(selection = null) {
    const state = this.state();
    const locked = selection?.time_binding?.kind === "locked_axis"
      ? selection.time_binding.axis?.cursor
      : null;
    return locked
      || this.selectedDateProvider?.()
      || selection?.date
      || state.renderedSampledGridDate
      || "";
  }

  bbox(selection) {
    if (!Array.isArray(selection?.bbox) || selection.bbox.length !== 4) return null;
    const values = selection.bbox.map(Number);
    return values.every(Number.isFinite) ? values : null;
  }

  mapSnapshot() {
    return this.mapSnapshotProvider?.() || {};
  }

  resolutionFor(layer, selection) {
    const participant = selection?.selection_grid?.participants?.find((item) => (
      item.dataset_id === layer.datasetId || item.layer_id === layer.layerId
    ));
    const declared = participant?.effective_resolution_km
      ?? participant?.actual_resolution_km
      ?? participant?.requested_resolution_km;
    if (Number.isFinite(Number(declared))) return Number(declared);
    const mapSnapshot = this.mapSnapshot();
    return this.sampledGridContract.queryResolution({
      datasetId: layer.datasetId,
      zoom: mapSnapshot.zoom ?? null,
      latitude: selection?.center?.lat ?? mapSnapshot.latitude ?? null,
    });
  }

  requestedResolutionFor(layer) {
    return this.sampledGridContract.requestResolution({ datasetId: layer.datasetId });
  }

  request(layer, selection) {
    const bbox = this.bbox(selection);
    const date = this.currentDate(selection);
    if (!layer?.datasetId || !bbox || !date) return null;
    const resolution = this.requestedResolutionFor(layer);
    const queryResolution = this.resolutionFor(layer, selection);
    const mapSnapshot = this.mapSnapshot();
    return {
      datasetId: layer.datasetId,
      layerId: layer.layerId,
      label: layer.label,
      date,
      bbox: bbox.map((value) => value.toFixed(6)).join(","),
      limit: this.renderIntentService?.unlimitedLimit?.() ?? "max",
      columns: "render",
      resolution,
      queryResolution,
      zoom: mapSnapshot.zoom ?? null,
      latitude: selection?.center?.lat ?? (bbox[1] + bbox[3]) / 2,
      selection,
      key: [layer.datasetId, date, bbox.join(","), resolution ?? "auto", queryResolution ?? "auto"].join("|"),
    };
  }

  playbackOwnsQueryLifecycle() {
    const status = String(this.playbackSnapshotProvider?.()?.status || "IDLE");
    return ["PREPARING", "PLAYING", "BUFFERING"].includes(status);
  }

  async fetchValue(layer, selection, { allowNetwork = null } = {}) {
    const request = this.request(layer, selection);
    if (!request) {
      return { status: "missing", layer, selection, request, value: null, rowCount: 0 };
    }
    try {
      const cached = this.dataFrameStore.inspect(request);
      const networkAllowed = allowNetwork === null
        ? !this.playbackOwnsQueryLifecycle()
        : Boolean(allowNetwork);
      if (cached.status !== "ready" && !networkAllowed) {
        return { status: "missing", layer, selection, request, value: null, rowCount: 0 };
      }
      const result = cached.status === "ready"
        ? cached
        : await this.frameDemandService.demand(request, {
          lane: "widget-interactive",
          scopeId: `widget:${layer.layerId}:${selection?.selection_id || "selected"}`,
          consumerId: `value:${request.date}`,
        });
      const rows = Array.isArray(result.packet?.rows) ? result.packet.rows : [];
      const values = rows
        .map((row) => row?.value)
        .filter((value) => value !== null && value !== undefined && value !== "")
        .map(Number)
        .filter(Number.isFinite);
      if (!values.length) {
        return { status: "missing", layer, selection, request, value: null, rowCount: rows.length, packet: result.packet };
      }
      return {
        status: values.some((value) => value !== 0) ? "observed" : "zero",
        layer,
        selection,
        request,
        value: values.reduce((total, value) => total + value, 0),
        rowCount: rows.length,
        packet: result.packet,
        cacheHit: Boolean(result.cacheHit),
      };
    } catch (error) {
      return {
        status: "unavailable",
        layer,
        selection,
        request,
        value: null,
        rowCount: 0,
        error: error?.message || "query failed",
      };
    }
  }

  colorFor(key, alpha = 0.9) {
    return widgetColorFor(key, alpha);
  }
}

globalThis.WidgetQueryContext = WidgetQueryContext;
})();
