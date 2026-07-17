(() => {
const { DashboardWidget } = window.WidgetCore;
const { lineChartEscape } = window.WidgetCapabilityShared;

function tableFractionDigits(column) {
  const semantic = String(column || "").toLowerCase();
  return /(^|_)(lat|latitude|lon|lng|longitude|bounds?)(_|$)/.test(semantic) ? 6 : 2;
}

function formatTableCell(value, column, seen = new WeakSet()) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") {
    return formatDisplayNumber(value, { maximumFractionDigits: tableFractionDigits(column) });
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[循環參照]";
  seen.add(value);
  const formatNested = (item) => formatTableCell(item, column, seen);
  const formatted = Array.isArray(value)
    ? `[${value.map(formatNested).join(", ")}]`
    : `{ ${Object.entries(value).map(([key, item]) => `${key}: ${formatTableCell(item, `${column}_${key}`, seen)}`).join(", ")} }`;
  seen.delete(value);
  return formatted;
}

class WidgetTableView {
  constructor({ container, model, expanded = false, onSelectTab }) {
    this.container = container;
    this.model = model;
    this.expanded = expanded;
    this.onSelectTab = onSelectTab;
  }

  cellValue(value, column) {
    return formatTableCell(value, column);
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
    const previewLimit = this.model.previewLimit;
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
      <tr>${columns.map((column) => {
        const displayValue = this.cellValue(row?.[column], column);
        return `<td title="${lineChartEscape(displayValue)}">${lineChartEscape(displayValue)}</td>`;
      }).join("")}</tr>
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
    const previewLimit = this.model.previewLimit;
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
    const source = this.services.dataSource;
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


Object.assign(window.WidgetCapabilities ||= {}, {
  formatTableCell,
  WidgetTableView,
  TableWidget,
});
})();
