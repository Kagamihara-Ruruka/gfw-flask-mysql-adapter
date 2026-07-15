(() => {
const { ChartWidget, WidgetPlotlyLifecycle } = window.WidgetCore;
const {
  lineChartEscape,
  WidgetQueryContext,
  SampledGridWidgetLayerFilter,
} = window.WidgetCapabilityShared;

class HorizontalBarChartDataSource {
  static shared() {
    if (!HorizontalBarChartDataSource.instance) {
      HorizontalBarChartDataSource.instance = new HorizontalBarChartDataSource();
    }
    return HorizontalBarChartDataSource.instance;
  }

  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
    this.generation = 0;
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
    this.inflight.clear();
  }

  statusModel(stateName, title, detail) {
    return {
      state: stateName,
      title,
      detail,
      xLabel: "canonical value",
      yLabel: "儲存標籤",
      categories: [],
      values: [],
      colors: [],
      series: [],
    };
  }

  requestForCurrentState({ excludedLayerIds = [], excludedSelectionIds = [], aliases = {}, sort = "selection" } = {}) {
    const excludedSelections = new Set(excludedSelectionIds);
    const selections = WidgetQueryContext.selections()
      .filter((selection) => !excludedSelections.has(selection.selection_id));
    if (!selections.length) {
      return { blocked: this.statusModel("waiting", "等待儲存標籤", "請使用連續網格選取建立比較標籤") };
    }
    const layers = WidgetQueryContext.sampledGridLayers({ excludedLayerIds });
    if (!layers.length) {
      return { blocked: this.statusModel("waiting", "等待資料圖層", "沒有啟用的 sampled-grid 圖層") };
    }
    const key = JSON.stringify({
      selections: selections.map((selection) => [
        selection.selection_id,
        WidgetQueryContext.currentDate(selection),
        selection.bbox_string,
      ]),
      layers: layers.map((layer) => layer.layerId),
      aliases,
      sort,
    });
    return { key, selections, layers, aliases, sort };
  }

  defaultSelectionLabel(selection, index) {
    const date = WidgetQueryContext.currentDate(selection);
    const prefix = selection?.time_binding?.kind === "locked_axis" ? "異時" : "同時";
    return `${prefix} ${index + 1}${date ? ` · ${date}` : ""}`;
  }

  sortSelections(selections, totals, sort) {
    const indexed = selections.map((selection, index) => ({ selection, index, total: totals[index] }));
    const compareMissingLast = (left, right, direction) => {
      const leftAvailable = Number.isFinite(left.total);
      const rightAvailable = Number.isFinite(right.total);
      if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
      if (!leftAvailable) return left.index - right.index;
      return direction * (left.total - right.total) || left.index - right.index;
    };
    if (sort === "value_desc") indexed.sort((left, right) => compareMissingLast(left, right, -1));
    if (sort === "value_asc") indexed.sort((left, right) => compareMissingLast(left, right, 1));
    return indexed;
  }

  comparableValue(result) {
    if (!["observed", "zero"].includes(result?.status)) return null;
    const value = Number(result.value);
    return Number.isFinite(value) ? value : null;
  }

  async loadModel(request, generation) {
    const matrix = await Promise.all(request.layers.map(async (layer) => ({
      layer,
      results: await Promise.all(request.selections.map((selection) => (
        WidgetQueryContext.fetchValue(layer, selection)
      ))),
    })));
    const totals = request.selections.map((_, selectionIndex) => {
      const values = matrix
        .map((row) => this.comparableValue(row.results[selectionIndex]))
        .filter((value) => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    });
    const ordered = this.sortSelections(request.selections, totals, request.sort);
    const categories = ordered.map(({ selection, index }) => (
      request.aliases[selection.selection_id] || this.defaultSelectionLabel(selection, index)
    ));
    const series = matrix.map(({ layer, results }) => ({
      layerId: layer.layerId,
      datasetId: layer.datasetId,
      label: layer.label,
      color: WidgetQueryContext.colorFor(layer.layerId, 0.88),
      values: ordered.map(({ index }) => {
        return this.comparableValue(results[index]);
      }),
      statuses: ordered.map(({ index }) => results[index]?.status || "missing"),
    }));
    const values = ordered.map(({ total }) => total);
    const observed = matrix.flatMap((row) => row.results)
      .filter((result) => ["observed", "zero"].includes(result.status));
    const total = values.reduce((sum, value) => (
      sum + (Number.isFinite(value) ? Math.max(0, value) : 0)
    ), 0);
    const model = {
      state: observed.length ? (total > 0 ? "ready" : "zero") : "error",
      title: observed.length ? (total > 0 ? "網格標籤比較" : "比較值皆為 0") : "沒有可比較資料",
      detail: `${request.selections.length} 個標籤 / ${request.layers.length} 個圖層`,
      xLabel: "canonical value",
      yLabel: "儲存標籤",
      categories,
      values,
      colors: categories.map((_, index) => WidgetQueryContext.colorFor(`selection-${index}`, 0.82)),
      series,
      rowCount: matrix.flatMap((row) => row.results).reduce((sum, result) => sum + Number(result.rowCount || 0), 0),
    };
    if (generation === this.generation) {
      this.cache.set(request.key, model);
      window.dispatchEvent(new CustomEvent("rrkal:horizontal-bar-data-changed", {
        detail: { key: request.key, state: model.state },
      }));
    }
    return model;
  }

  model(options = {}) {
    const request = this.requestForCurrentState(options);
    if (request.blocked) return request.blocked;
    if (this.cache.has(request.key)) return this.cache.get(request.key);
    if (!this.inflight.has(request.key)) {
      const generation = this.generation;
      const loader = this.loadModel(request, generation).finally(() => {
        if (this.inflight.get(request.key) === loader) this.inflight.delete(request.key);
      });
      this.inflight.set(request.key, loader);
    }
    return this.statusModel("loading", "載入標籤比較", `${request.selections.length} 個標籤 / ${request.layers.length} 個圖層`);
  }
}

class HorizontalBarChartWidget extends ChartWidget {
  layerFilter() {
    if (!this.sampledGridLayerFilter) this.sampledGridLayerFilter = new SampledGridWidgetLayerFilter();
    return this.sampledGridLayerFilter;
  }

  settings() {
    if (!this.comparisonSettings) {
      this.comparisonSettings = {
        excludedSelectionIds: new Set(),
        aliases: new Map(),
        sort: "selection",
      };
    }
    return this.comparisonSettings;
  }

  chartModel() {
    const settings = this.settings();
    return HorizontalBarChartDataSource.shared().model({
      excludedLayerIds: [...this.layerFilter().excludedLayerIds],
      excludedSelectionIds: [...settings.excludedSelectionIds],
      aliases: Object.fromEntries(settings.aliases),
      sort: settings.sort,
    });
  }

  refreshData() {
    HorizontalBarChartDataSource.shared().clear();
    window.dispatchEvent(new CustomEvent("rrkal:horizontal-bar-data-changed", {
      detail: { reason: "settings_changed", widgetId: this.id },
    }));
  }

  renderSelectionSettings() {
    const section = document.createElement("section");
    section.className = "widget-query-settings widget-comparison-settings";
    const heading = document.createElement("h4");
    heading.textContent = "比較標籤";
    const list = document.createElement("div");
    list.className = "widget-comparison-label-list";
    const selections = WidgetQueryContext.selections();
    const settings = this.settings();
    selections.forEach((selection, index) => {
      const row = document.createElement("div");
      row.className = "widget-comparison-label-row";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = !settings.excludedSelectionIds.has(selection.selection_id);
      enabled.setAttribute("aria-label", `使用標籤 ${index + 1}`);
      enabled.addEventListener("change", () => {
        if (enabled.checked) settings.excludedSelectionIds.delete(selection.selection_id);
        else settings.excludedSelectionIds.add(selection.selection_id);
        this.refreshData();
      });
      const number = document.createElement("strong");
      number.textContent = String(index + 1);
      const alias = document.createElement("input");
      alias.type = "text";
      alias.value = settings.aliases.get(selection.selection_id) || "";
      alias.placeholder = HorizontalBarChartDataSource.shared().defaultSelectionLabel(selection, index);
      alias.setAttribute("aria-label", `標籤 ${index + 1} 名稱`);
      alias.addEventListener("change", () => {
        const value = alias.value.trim();
        if (value) settings.aliases.set(selection.selection_id, value);
        else settings.aliases.delete(selection.selection_id);
        this.refreshData();
      });
      row.append(enabled, number, alias);
      list.append(row);
    });
    if (!selections.length) {
      const empty = document.createElement("p");
      empty.textContent = "尚未建立儲存標籤";
      list.append(empty);
    }
    section.append(heading, list);
    return section;
  }

  renderSortSettings() {
    const field = document.createElement("label");
    field.className = "widget-settings-field";
    const label = document.createElement("span");
    label.textContent = "排序";
    const select = document.createElement("select");
    [
      ["selection", "標籤建立順序"],
      ["value_desc", "總值由高到低"],
      ["value_asc", "總值由低到高"],
    ].forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    select.value = this.settings().sort;
    select.addEventListener("change", () => {
      this.settings().sort = select.value;
      this.refreshData();
    });
    field.append(label, select);
    return field;
  }

  renderCapabilitySettings({ pane } = {}) {
    if (!pane) return;
    pane.append(
      this.layerFilter().render({ title: "比較圖層", onChange: () => this.refreshData() }),
      this.renderSelectionSettings(),
      this.renderSortSettings(),
    );
  }

  horizontalBarChartElementId() {
    return `${this.id}-horizontal-bar-plotly`;
  }

  compactBars(model) {
    const values = model.values.map((value) => (value === null ? null : Number(value)));
    const available = values.filter(Number.isFinite);
    const max = Math.max(...available.map((value) => Math.max(0, value)), 1);
    const plotLeft = 45;
    const plotRight = 280;
    const plotTop = 6;
    const plotBottom = 64;
    const step = (plotBottom - plotTop) / Math.max(values.length, 1);
    const barHeight = Math.min(8, step * 0.64);
    return values.map((value, index) => ({
      x: plotLeft,
      y: Number((plotTop + step * index + (step - barHeight) / 2).toFixed(2)),
      width: Number.isFinite(value)
        ? Number(Math.max(2, ((plotRight - plotLeft) * Math.max(0, value)) / max).toFixed(2))
        : 0,
      height: Number(barHeight.toFixed(2)),
      label: model.categories[index] || String(index + 1),
      color: model.colors[index] || "rgba(56, 189, 248, 0.82)",
    }));
  }

  horizontalBarChartData(model) {
    return model.series.map((series) => ({
      type: "bar",
      orientation: "h",
      name: series.label,
      x: [...series.values],
      y: [...model.categories],
      marker: {
        color: series.color,
        line: { color: "rgba(226, 232, 240, 0.18)", width: 1 },
      },
      customdata: series.statuses,
      hovertemplate: `${lineChartEscape(series.label)}<br>%{y}<br>Y: %{x}<br>%{customdata}<extra></extra>`,
    }));
  }

  horizontalBarChartLayout(model, { cinema = false } = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(5,10,16,0.5)",
      margin: cinema ? { l: 90, r: 30, t: 18, b: 54 } : { l: 74, r: 22, t: 12, b: 48 },
      autosize: true,
      barmode: "group",
      bargap: 0.28,
      showlegend: model.series.length > 1,
      font: { color: "#94a3b8", family: "Inter, system-ui, sans-serif", size: cinema ? 12 : 11 },
      legend: { orientation: "h", x: 0, y: 1.08, bgcolor: "rgba(0,0,0,0)" },
      xaxis: {
        title: { text: model.xLabel, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
        rangemode: "tozero",
      },
      yaxis: {
        title: { text: model.yLabel, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.08)",
        zeroline: false,
        autorange: "reversed",
      },
    };
  }

  renderHorizontalBarPlotlyWhenReady(container, model, options = {}, attempt = 0) {
    const chart = container.querySelector("[data-widget-horizontal-bar-plotly]");
    if (!chart) return;
    if (!WidgetPlotlyLifecycle.waitUntilDisplayed(
      chart,
      () => this.renderHorizontalBarPlotlyWhenReady(container, model, options, attempt + 1),
      { attempt },
    )) {
      return;
    }
    if (!window.Plotly?.react) {
      chart.textContent = "Plotly 尚未載入";
      chart.classList.add("pipeline-chart-empty");
      return;
    }
    chart.classList.remove("pipeline-chart-empty");
    chart.textContent = "";
    const config = { responsive: true, displayModeBar: false, scrollZoom: false };
    Promise.resolve(window.Plotly.react(
      chart,
      this.horizontalBarChartData(model),
      this.horizontalBarChartLayout(model, options),
      config,
    )).then(() => {
      WidgetPlotlyLifecycle.scheduleResize(chart);
    }).catch((error) => {
      chart.textContent = error.message || "Plotly render failed";
      chart.classList.add("pipeline-chart-empty");
    });
  }

  renderCompactHorizontalBarTemplate(container, model) {
    const bars = this.compactBars(model);
    const barShapes = bars.map((bar) => `
      <text x="39" y="${bar.y + bar.height / 2 + 2.5}">${lineChartEscape(bar.label)}</text>
      <rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="3" style="--widget-horizontal-bar-color: ${bar.color}" />
    `).join("");
    container.innerHTML = `
      <div class="widget-horizontal-bar-summary">
        <span>${lineChartEscape(model.detail)}</span>
        <strong>${model.categories.length}</strong>
        <em>${lineChartEscape(model.title)}</em>
      </div>
      <div class="widget-horizontal-bar-chart-shell">
        <span class="widget-horizontal-bar-axis widget-horizontal-bar-axis-y">Y</span>
        <svg class="widget-horizontal-bar-chart" viewBox="0 0 286 76" role="img" aria-label="儲存網格標籤橫條比較">
          <path class="widget-grid-line" d="M45 5V65M103 5V65M162 5V65M221 5V65M280 5V65" />
          <path class="widget-axis-line" d="M45 4V65H283" />
          ${barShapes}
        </svg>
        <span class="widget-horizontal-bar-axis widget-horizontal-bar-axis-x">X</span>
      </div>
    `;
  }

  renderExpandedHorizontalBarTemplate(container, model, { cinema = false } = {}) {
    container.innerHTML = `
      <div class="widget-horizontal-bar-panel${cinema ? " is-cinema" : ""}">
        <div class="widget-horizontal-bar-heading">
          <span>${lineChartEscape(model.detail)}</span>
          <strong>${lineChartEscape(model.title)}</strong>
          <div class="widget-horizontal-bar-binding-row">
            <span><b>X</b><em>${lineChartEscape(model.xLabel)}</em></span>
            <span><b>Y</b><em>${lineChartEscape(model.yLabel)}</em></span>
          </div>
        </div>
        <div class="widget-horizontal-bar-plotly-stage" data-widget-interactive="1">
          <div id="${this.horizontalBarChartElementId()}" class="pipeline-plotly-chart widget-horizontal-bar-plotly-chart" data-widget-horizontal-bar-plotly aria-label="橫條圖工具"></div>
        </div>
      </div>
    `;
    this.renderHorizontalBarPlotlyWhenReady(container, model, { cinema });
  }

  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-horizontal-bar");
    if (expanded) container.classList.add("is-expanded");
    container.dataset.chartView = cinema ? "cinema" : expanded ? "expanded" : "compact";
    const model = this.chartModel();
    if (model.state !== "ready") {
      this.renderChartEmptyState(container, model, "horizontal bar source");
      return;
    }
    if (expanded) {
      this.renderExpandedHorizontalBarTemplate(container, model, { cinema });
      return;
    }
    this.renderCompactHorizontalBarTemplate(container, model);
  }
}

Object.assign(window.WidgetCapabilities ||= {}, {
  HorizontalBarChartDataSource,
  HorizontalBarChartWidget,
});
})();
