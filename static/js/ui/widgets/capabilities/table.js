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

  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
  }

  clear() {
    this.cache.clear();
  }

  invalidateLayer(layerId) {
    const normalized = this.layerIdOf(layerId);
    if (!normalized) return;
    for (const [key, model] of this.cache.entries()) {
      if (model?.request?.layerId === normalized) this.cache.delete(key);
    }
  }

  layerIdOf(value) {
    return String(value || "").trim().toLowerCase();
  }

  importedLayerIds() {
    return new Set((state?.importedLayerIds || []).map((layerId) => this.layerIdOf(layerId)).filter(Boolean));
  }

  queryableContracts() {
    const imported = this.importedLayerIds();
    const contracts = new Map();
    for (const contract of state?.layerContracts || []) {
      const layerId = this.layerIdOf(contract?.layer_id);
      if (!layerId || !imported.has(layerId)) continue;
      if (contract?.capabilities?.relational_query !== true) continue;
      if (!contracts.has(layerId)) contracts.set(layerId, contract);
    }
    return contracts;
  }

  tabs() {
    const contracts = this.queryableContracts();
    const datasetsByLayer = new Map();
    for (const [datasetId, dataset] of Object.entries(state?.datasets || {})) {
      const layerId = this.layerIdOf(dataset?.layer_id || dataset?.runtime?.layer_id);
      if (!layerId || !contracts.has(layerId)) continue;
      if (!datasetsByLayer.has(layerId)) datasetsByLayer.set(layerId, []);
      datasetsByLayer.get(layerId).push({ datasetId, dataset });
    }
    const layerOrder = new Map((state?.layerOrder || []).map((layerId, index) => [this.layerIdOf(layerId), index]));
    return Array.from(datasetsByLayer.entries())
      .map(([layerId, datasets]) => {
        const selected = datasets.find((entry) => entry.datasetId === state?.datasetId) || datasets[0];
        const contract = contracts.get(layerId);
        return {
          id: layerId,
          layerId,
          label: contract?.label || selected.dataset?.label || layerId,
          datasetId: selected.datasetId,
          dataset: selected.dataset,
          contract,
        };
      })
      .sort((left, right) => {
        const leftOrder = layerOrder.has(left.layerId) ? layerOrder.get(left.layerId) : Number.MAX_SAFE_INTEGER;
        const rightOrder = layerOrder.has(right.layerId) ? layerOrder.get(right.layerId) : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.label.localeCompare(right.label, "zh-TW");
      });
  }

  recordsEventAffectsTabs(event) {
    const layerId = this.layerIdOf(event?.detail?.layer);
    if (!layerId || layerId === "none") return false;
    return this.tabs().some((tab) => tab.layerId === layerId);
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

  bboxFor(selected) {
    if (selected) {
      const bbox = Array.isArray(selected.bbox) ? selected.bbox.map(Number) : [];
      if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) return "";
      return selected.bbox_string || bbox.map((value) => value.toFixed(6)).join(",");
    }
    return typeof currentBbox === "function" ? currentBbox() : "";
  }

  requestFor(tab) {
    const selected = this.selectedCell();
    const date = this.currentDate(selected);
    const bbox = this.bboxFor(selected);
    const scope = selected ? "tile" : "viewport";
    const scopeLabel = selected
      ? selected.tile_key || selected.label || "選取 Tile"
      : "目前視窗";
    const key = [tab.datasetId, date, bbox, scope].join("|");
    return { ...tab, selected, date, bbox, scope, scopeLabel, key };
  }

  statusModel(request, status, detail, extra = {}) {
    return {
      status,
      detail,
      rows: extra.rows || [],
      columns: extra.columns || request?.dataset?.display_columns || [],
      rowCount: Number(extra.rowCount || 0),
      timing: extra.timing || {},
      request,
    };
  }

  currentRecordsModel(request) {
    if (request.scope !== "viewport" || request.datasetId !== state?.datasetId) return null;
    const context = state?.recordsContext || {};
    if (this.layerIdOf(context.layer) !== request.layerId) return null;
    if (String(context.date || "") !== String(request.date || "")) return null;
    if (context.loading) {
      return this.statusModel(request, "loading", "正在更新目前視窗");
    }
    const rows = Array.isArray(state?.rows) ? state.rows : [];
    const columns = request.dataset?.display_columns || [];
    const hasDisplayColumns = !rows.length || columns.every((column) => Object.hasOwn(rows[0], column));
    if (!hasDisplayColumns) return null;
    return this.statusModel(request, "ready", "已使用目前視窗資料", {
      rows,
      columns,
      rowCount: rows.length,
    });
  }

  activeModel(request) {
    if (!request.bbox) {
      return this.statusModel(request, "error", "查詢範圍沒有可用的 bbox");
    }
    const current = this.currentRecordsModel(request);
    if (current) return current;
    const cached = this.cache.get(request.key);
    if (cached) return cached;
    this.fetch(request);
    return this.statusModel(request, "loading", "正在查詢圖層資料");
  }

  model(activeTabId = "") {
    const tabs = this.tabs();
    if (!tabs.length) {
      return {
        tabs: [],
        activeTabId: "",
        active: null,
        status: "empty",
        detail: "目前沒有已導入且可查表的圖層",
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

  fetch(request) {
    if (this.inflight.has(request.key)) return this.inflight.get(request.key);
    const params = new URLSearchParams({
      bbox: request.bbox,
      limit: typeof RenderIntentService !== "undefined"
        ? String(RenderIntentService.unlimitedLimit())
        : "max",
      columns: "display",
    });
    if (request.date) params.set("date", request.date);
    const url = `/api/datasets/${encodeURIComponent(request.datasetId)}/records?${params.toString()}`;
    const loader = fetchJson(url)
      .then((packet) => {
        this.cache.set(request.key, this.statusModel(request, "ready", "查詢完成", {
          rows: Array.isArray(packet?.rows) ? packet.rows : [],
          columns: packet?.columns || request.dataset?.display_columns || [],
          rowCount: Number(packet?.row_count || 0),
          timing: packet?.timing || {},
        }));
      })
      .catch((err) => {
        this.cache.set(request.key, this.statusModel(request, "error", err.message || "table query failed"));
      })
      .finally(() => {
        this.inflight.delete(request.key);
        window.dispatchEvent(new CustomEvent("rrkal:table-widget-data-changed", {
          detail: { key: request.key, layerId: request.layerId },
        }));
      });
    this.inflight.set(request.key, loader);
    return loader;
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
      return `<tr><td colspan="${Math.max(1, columns.length)}" class="widget-table-message">載入中</td></tr>`;
    }
    if (active?.status === "error") {
      return `<tr><td colspan="${Math.max(1, columns.length)}" class="widget-table-message is-error">${lineChartEscape(active.detail)}</td></tr>`;
    }
    if (!rows.length) {
      return `<tr><td colspan="${Math.max(1, columns.length)}" class="widget-table-message">此範圍沒有資料</td></tr>`;
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
        <div class="widget-table-tabs" role="tablist" aria-label="圖層查詢結果" data-widget-interactive="1">
          ${this.renderTabs()}
        </div>
        <div class="widget-table-summary">${lineChartEscape(this.summary(active))}</div>
        <div class="widget-table-scroll" data-widget-interactive="1">
          <table class="widget-table-template" aria-label="${lineChartEscape(active?.request?.label || "圖層查詢結果")}">
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
