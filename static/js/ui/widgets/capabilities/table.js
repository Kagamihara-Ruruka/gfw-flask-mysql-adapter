(() => {
const { DashboardWidget } = window.WidgetCore;
const { lineChartEscape } = window.WidgetCapabilityShared;
class TableWidgetDataSource {
  static shared() {
    if (!TableWidgetDataSource.instance) {
      TableWidgetDataSource.instance = new TableWidgetDataSource();
    }
    return TableWidgetDataSource.instance;
  }

  layerIdOf(value) {
    return String(value || "").trim().toLowerCase();
  }

  contractFor(layerId) {
    const normalized = this.layerIdOf(layerId);
    return (state?.layerContracts || []).find((contract) => (
      this.layerIdOf(contract?.layer_id) === normalized
    )) || null;
  }

  tabs() {
    const registered = window.LayerRuntimeContractRegistry?.sampledGridLayers?.({ enabledOnly: true }) || [];
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
    const datasetId = String(state?.datasetId || "").trim();
    const dataset = state?.datasets?.[datasetId] || null;
    const layerId = this.layerIdOf(state?.dataLayer || dataset?.layer_id || dataset?.runtime?.layer_id);
    if (!datasetId || !dataset || !layerId) return [];
    const contract = this.contractFor(layerId);
    return [{ id: datasetId, layerId, label: dataset.label || contract?.label || datasetId, datasetId, dataset, contract }];
  }

  selectedCell() {
    return state?.tileSelection?.selected || window.TileSelectionLayer?.selected?.() || null;
  }

  currentDate(selected) {
    const lockedCursor = selected?.time_binding?.kind === "locked_axis"
      ? selected.time_binding.axis?.cursor
      : null;
    return lockedCursor || $("date")?.value || selected?.date || state?.renderedSampledGridDate || "";
  }

  selectedBbox(selected) {
    const bbox = Array.isArray(selected?.bbox) ? selected.bbox.map(Number) : [];
    if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) return "";
    return selected.bbox_string || bbox.map((value) => value.toFixed(6)).join(",");
  }

  requestFor(tab) {
    const selected = this.selectedCell();
    const date = this.currentDate(selected);
    const intent = typeof RenderIntentService !== "undefined"
      ? RenderIntentService.snapshot({ date, layerId: tab.layerId, renderProfile: "widget.table.snapshot" })
      : null;
    const packetRequest = intent && typeof RenderIntentService.toSampledGridPacketRequest === "function"
      ? RenderIntentService.toSampledGridPacketRequest(intent)
      : {
          datasetId: tab.datasetId,
          layerId: tab.layerId,
          date,
          bbox: typeof currentBbox === "function" ? currentBbox() : "",
          limit: "max",
          columns: "render",
          resolution: typeof SampledGridContract !== "undefined"
            ? SampledGridContract.queryResolution({ datasetId: tab.datasetId })
            : null,
        };
    packetRequest.datasetId = tab.datasetId;
    packetRequest.layerId = tab.layerId;
    packetRequest.date = date;
    packetRequest.resolution = SampledGridContract.queryResolution({
      datasetId: tab.datasetId,
      zoom: packetRequest.zoom,
      latitude: packetRequest.latitude,
    });
    const selectedBbox = this.selectedBbox(selected);
    if (selectedBbox) packetRequest.bbox = selectedBbox;
    const scope = selected ? "tile" : "viewport";
    const scopeLabel = selected
      ? selected.tile_key || selected.label || "選取 Tile"
      : "目前視窗";
    const key = typeof DataFrameStore !== "undefined" && typeof DataFrameStore.keyFor === "function"
      ? DataFrameStore.keyFor(packetRequest)
      : [tab.datasetId, date, packetRequest.bbox, packetRequest.resolution ?? "auto"].join("|");
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
    };
  }

  columnsFor(packet, request) {
    const rows = Array.isArray(packet?.rows) ? packet.rows : [];
    const rowColumns = [];
    const seen = new Set();
    for (const row of rows.slice(0, 50)) {
      for (const column of Object.keys(row || {})) {
        if (seen.has(column)) continue;
        seen.add(column);
        rowColumns.push(column);
      }
    }
    const declared = [
      ...(Array.isArray(packet?.columns) ? packet.columns : []),
      ...(Array.isArray(request?.dataset?.display_columns) ? request.dataset.display_columns : []),
    ];
    const declaredPresent = declared.filter((column, index) => (
      declared.indexOf(column) === index && (!rows.length || rows.some((row) => Object.hasOwn(row || {}, column)))
    ));
    return [...declaredPresent, ...rowColumns.filter((column) => !declaredPresent.includes(column))];
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
    if (typeof DataFrameStore === "undefined" || typeof DataFrameStore.inspect !== "function") {
      return this.statusModel(request, "error", "目前快照快取尚未就緒");
    }
    const cached = DataFrameStore.inspect(request.packetRequest);
    if (cached.status !== "ready" || !cached.packet) {
      const context = state?.recordsContext || {};
      const isLoadingCurrentSnapshot = Boolean(context.loading)
        && this.layerIdOf(context.layer) === request.layerId
        && String(context.date || "") === String(request.date || "");
      return this.statusModel(
        request,
        isLoadingCurrentSnapshot ? "loading" : "uncached",
        isLoadingCurrentSnapshot ? "地圖正在取得目前快照" : "目前快照尚無快取資料",
      );
    }
    const rows = Array.isArray(cached.packet.rows) ? cached.packet.rows : [];
    return this.statusModel(request, "ready", "目前快照快取", {
      rows,
      columns: this.columnsFor(cached.packet, request),
      rowCount: Number(cached.packet.row_count ?? rows.length),
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
      };
    }
    const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
    const request = this.requestFor(activeTab);
    return {
      tabs,
      activeTabId: activeTab.id,
      active: this.activeModel(request),
    };
  }
}

class WidgetTableView {
  constructor({ container, model, expanded = false, onSelectTab }) {
    this.container = container;
    this.model = model;
    this.expanded = expanded;
    this.onSelectTab = onSelectTab;
  }

  cellValue(value) {
    if (value === undefined || value === null || value === "") return "-";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  renderTabs() {
    return this.model.tabs.map((tab) => `
      <button
        type="button"
        class="widget-table-tab"
        role="tab"
        aria-selected="${tab.id === this.model.activeTabId ? "true" : "false"}"
        data-widget-table-tab="${lineChartEscape(tab.id)}"
        data-widget-interactive="1"
      >${lineChartEscape(tab.label)}</button>
    `).join("");
  }

  renderRows(active) {
    const columns = active?.columns || [];
    const previewLimit = Math.max(1, Number(state?.queryPolicy?.table_preview_limit || 300));
    const rows = (active?.rows || []).slice(0, previewLimit);
    if (active?.status === "loading") {
      return `<tr><td colspan="${Math.max(1, columns.length)}" class="widget-table-message">${lineChartEscape(active.detail)}</td></tr>`;
    }
    if (active?.status === "error") {
      return `<tr><td colspan="${Math.max(1, columns.length)}" class="widget-table-message is-error">${lineChartEscape(active.detail)}</td></tr>`;
    }
    if (active?.status === "uncached") {
      return `<tr><td colspan="${Math.max(1, columns.length)}" class="widget-table-message">${lineChartEscape(active.detail)}</td></tr>`;
    }
    if (!rows.length) {
      return `<tr><td colspan="${Math.max(1, columns.length)}" class="widget-table-message">目前快照的快取沒有資料</td></tr>`;
    }
    return rows.map((row) => `
      <tr>${columns.map((column) => `<td title="${lineChartEscape(this.cellValue(row?.[column]))}">${lineChartEscape(this.cellValue(row?.[column]))}</td>`).join("")}</tr>
    `).join("");
  }

  summary(active) {
    if (!active?.request) return this.model.detail || "等待資料合約";
    const request = active.request;
    const scope = request.scope === "tile" ? request.scopeLabel : "目前視窗";
    const date = request.date || "全時段";
    if (active.status === "loading") return `${scope} / ${date} / 載入中`;
    if (active.status === "uncached") return `${scope} / ${date} / 尚無快取`;
    if (active.status === "error") return `${scope} / ${date} / 查詢失敗`;
    const previewLimit = Math.max(1, Number(state?.queryPolicy?.table_preview_limit || 300));
    const visibleCount = Math.min(active.rowCount, previewLimit);
    const count = active.rowCount > previewLimit
      ? `顯示 ${visibleCount.toLocaleString()} / 共 ${active.rowCount.toLocaleString()} 筆`
      : `${active.rowCount.toLocaleString()} 筆`;
    return `${scope} / ${date} / ${count}`;
  }

  bindTabs() {
    this.container.querySelectorAll("[data-widget-table-tab]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onSelectTab?.(button.dataset.widgetTableTab);
      });
    });
  }

  render() {
    this.container.classList.add("widget-template", "widget-template-table");
    if (this.expanded) this.container.classList.add("is-expanded");
    if (!this.model.tabs.length) {
      this.container.innerHTML = `
        <div class="widget-table-empty-state">
          <strong>等待可查詢圖層</strong>
          <span>${lineChartEscape(this.model.detail)}</span>
        </div>
      `;
      return;
    }
    const active = this.model.active;
    const columns = active?.columns || [];
    this.container.innerHTML = `
      <div class="widget-table-shell">
        <div class="widget-table-tabs" role="tablist" aria-label="目前快照資料集" data-widget-interactive="1">
          ${this.renderTabs()}
        </div>
        <div class="widget-table-summary">${lineChartEscape(this.summary(active))}</div>
        <div class="widget-table-scroll" data-widget-interactive="1">
          <table class="widget-table-template" aria-label="${lineChartEscape(active?.request?.label || "目前快照快取")}">
            <thead>
              <tr>${columns.map((column) => `<th title="${lineChartEscape(column)}">${lineChartEscape(column)}</th>`).join("")}</tr>
            </thead>
            <tbody>${this.renderRows(active)}</tbody>
          </table>
        </div>
      </div>
    `;
    this.bindTabs();
  }
}

class TableWidget extends DashboardWidget {
  constructor(options) {
    super(options);
    this.activeTabId = "";
  }

  renderTemplate(container, { expanded = false } = {}) {
    const source = TableWidgetDataSource.shared();
    const model = source.model(this.activeTabId);
    this.activeTabId = model.activeTabId;
    new WidgetTableView({
      container,
      model,
      expanded,
      onSelectTab: (tabId) => {
        this.activeTabId = tabId;
        container.replaceChildren();
        this.renderTemplate(container, { expanded });
      },
    }).render();
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { TableWidgetDataSource, WidgetTableView, TableWidget });
})();
