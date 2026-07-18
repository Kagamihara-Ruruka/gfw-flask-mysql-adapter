(() => {
class TableWidgetDataSource {
  constructor({
    stateProvider,
    queryContext,
    layerRegistryProvider,
    bboxProvider,
    renderIntentService,
    sampledGridContract,
    dataFrameStore,
  } = {}) {
    if (typeof stateProvider !== "function" || !queryContext || !sampledGridContract || !dataFrameStore) {
      throw new TypeError("TableWidgetDataSource requires state, query and cache dependencies");
    }
    this.stateProvider = stateProvider;
    this.queryContext = queryContext;
    this.layerRegistryProvider = layerRegistryProvider;
    this.bboxProvider = bboxProvider;
    this.renderIntentService = renderIntentService;
    this.sampledGridContract = sampledGridContract;
    this.dataFrameStore = dataFrameStore;
  }

  state() {
    return this.stateProvider() || {};
  }

  layerIdOf(value) {
    return String(value || "").trim().toLowerCase();
  }

  contractFor(layerId) {
    const normalized = this.layerIdOf(layerId);
    return (this.state().layerContracts || []).find((contract) => (
      this.layerIdOf(contract?.layer_id) === normalized
    )) || null;
  }

  tabs() {
    const registered = this.layerRegistryProvider?.()?.sampledGridLayers?.({ enabledOnly: true }) || [];
    if (registered.length) {
      return registered.map((layer) => ({
        id: layer.datasetId,
        layerId: this.layerIdOf(layer.layerId),
        label: layer.label,
        datasetId: layer.datasetId,
        dataset: layer.dataset,
        contract: layer.contract,
      }));
    }
    const state = this.state();
    const datasetId = String(state.datasetId || "").trim();
    const dataset = state.datasets?.[datasetId] || null;
    const layerId = this.layerIdOf(state.dataLayer || dataset?.layer_id || dataset?.runtime?.layer_id);
    if (!datasetId || !dataset || !layerId) return [];
    const contract = this.contractFor(layerId);
    return [{ id: datasetId, layerId, label: dataset.label || contract?.label || datasetId, datasetId, dataset, contract }];
  }

  selectedCell() {
    return this.queryContext.selectedCell();
  }

  currentDate(selected) {
    return this.queryContext.currentDate(selected);
  }

  selectedBbox(selected) {
    const bbox = this.queryContext.bbox(selected);
    if (!bbox) return "";
    return selected.bbox_string || bbox.map((value) => value.toFixed(6)).join(",");
  }

  requestFor(tab) {
    const selected = this.selectedCell();
    const date = this.currentDate(selected);
    const intent = this.renderIntentService?.snapshot?.({
      date,
      layerId: tab.layerId,
      renderProfile: "widget.table.snapshot",
    });
    const packetRequest = intent && this.renderIntentService?.toSampledGridPacketRequest
      ? this.renderIntentService.toSampledGridPacketRequest(intent)
      : {
          datasetId: tab.datasetId,
          layerId: tab.layerId,
          date,
          bbox: this.bboxProvider?.() || "",
          limit: "max",
          columns: "render",
          resolution: this.sampledGridContract.requestResolution({ datasetId: tab.datasetId }),
          queryResolution: null,
        };
    packetRequest.datasetId = tab.datasetId;
    packetRequest.layerId = tab.layerId;
    packetRequest.date = date;
    packetRequest.resolution = this.sampledGridContract.requestResolution({
      datasetId: tab.datasetId,
    });
    const selectedBbox = this.selectedBbox(selected);
    if (selectedBbox) packetRequest.bbox = selectedBbox;
    packetRequest.queryResolution = this.sampledGridContract.queryResolution({
      datasetId: tab.datasetId,
      bbox: packetRequest.bbox,
      zoom: packetRequest.zoom,
      latitude: packetRequest.latitude,
    });
    const scope = selected ? "tile" : "viewport";
    const scopeLabel = selected
      ? selected.tile_key || selected.label || "選取 Tile"
      : "目前視窗";
    const key = this.dataFrameStore.keyFor?.(packetRequest)
      || [
        tab.datasetId,
        date,
        packetRequest.bbox,
        packetRequest.resolution ?? "auto",
        packetRequest.queryResolution ?? "auto",
      ].join("|");
    return {
      ...tab,
      selected,
      date,
      bbox: packetRequest.bbox,
      scope,
      scopeLabel,
      key,
      packetRequest,
    };
  }

  statusModel(request, status, detail, extra = {}) {
    return {
      status,
      detail,
      rows: extra.rows || [],
      columns: extra.columns || [],
      rowCount: Number(extra.rowCount || 0),
      timing: extra.timing || {},
      request,
      previewLimit: this.previewLimit(),
    };
  }

  previewLimit() {
    return Math.max(1, Number(this.state().queryPolicy?.table_preview_limit || 300));
  }

  columnsFor(packet, request) {
    const frame = packet?.frame;
    const frameColumns = globalThis.CanonicalGridFrame?.isFrame(frame) ? frame.fieldNames() : [];
    const declared = [
      ...(Array.isArray(packet?.columns) ? packet.columns : []),
      ...(Array.isArray(request?.dataset?.display_columns) ? request.dataset.display_columns : []),
    ];
    const declaredPresent = declared.filter((column, index) => (
      declared.indexOf(column) === index && frameColumns.includes(column)
    ));
    return [...declaredPresent, ...frameColumns.filter((column) => !declaredPresent.includes(column))];
  }

  cacheEventAffectsCurrent(event) {
    const detail = event?.detail || {};
    return this.tabs().some((tab) => {
      const request = this.requestFor(tab);
      return String(detail.datasetId || "") === request.datasetId
        && String(detail.date || "") === String(request.date || "");
    });
  }

  activeModel(request) {
    if (!request.bbox) {
      return this.statusModel(request, "uncached", "目前快照位於資料範圍外");
    }
    const cached = this.dataFrameStore.inspect(request.packetRequest);
    if (cached.status !== "ready" || !cached.packet) {
      const context = this.state().recordsContext || {};
      const isLoadingCurrentSnapshot = Boolean(context.loading)
        && this.layerIdOf(context.layer) === request.layerId
        && String(context.date || "") === String(request.date || "");
      return this.statusModel(
        request,
        isLoadingCurrentSnapshot ? "loading" : "uncached",
        isLoadingCurrentSnapshot ? "地圖正在取得目前快照" : "目前快照尚無快取資料",
      );
    }
    const frame = cached.packet.frame;
    if (!globalThis.CanonicalGridFrame?.isFrame(frame)) {
      return this.statusModel(request, "uncached", "目前快照尚無可讀取的格網快取");
    }
    const rows = frame.rows(0, this.previewLimit());
    return this.statusModel(request, "ready", "目前快照快取", {
      rows,
      columns: this.columnsFor(cached.packet, request),
      rowCount: frame.rowCount,
      timing: cached.packet.timing || {},
    });
  }

  model(activeTabId = "") {
    const tabs = this.tabs();
    if (!tabs.length) {
      return {
        tabs: [],
        activeTabId: "",
        active: null,
        status: "empty",
        detail: "目前沒有正在渲染的資料集",
        previewLimit: this.previewLimit(),
      };
    }
    const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
    return {
      tabs,
      activeTabId: activeTab.id,
      active: this.activeModel(this.requestFor(activeTab)),
      previewLimit: this.previewLimit(),
    };
  }

  dispose() {}
}

globalThis.TableWidgetDataSource = TableWidgetDataSource;
})();
