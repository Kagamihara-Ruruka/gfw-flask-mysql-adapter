(() => {
const { ChartWidget, WidgetPlotlyLifecycle } = window.WidgetCore;
const {
  lineChartEscape,
  WidgetQueryContext,
  SampledGridWidgetLayerFilter,
} = window.WidgetCapabilityShared;
class PieChartDataSource {
  static shared() {
    if (!PieChartDataSource.instance) {
      PieChartDataSource.instance = new PieChartDataSource();
    }
    return PieChartDataSource.instance;
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

  selectedCell() {
    return state?.tileSelection?.selected || window.TileSelectionLayer?.selected?.() || null;
  }

  statusModel(stateName, title, detail, extra = {}) {
    return {
      state: stateName,
      title,
      detail,
      date: extra.date || "",
      metric: "value",
      totalLabel: extra.totalLabel || "Y 總量",
      valueRole: "y",
      total: 0,
      slices: [],
      selection: extra.selection || null,
      rowCount: 0,
    };
  }

  requestForCurrentState({ excludedLayerIds = [] } = {}) {
    const selected = this.selectedCell();
    if (!selected) {
      return { blocked: this.statusModel("waiting", "等待網格選取", "尚未點選取樣網格") };
    }
    if (!WidgetQueryContext.bbox(selected)) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 canonical bbox", { selection: selected }) };
    }
    const date = WidgetQueryContext.currentDate(selected);
    if (!date) {
      return { blocked: this.statusModel("waiting", "等待時間切片", "尚未取得單日模式日期", { selection: selected }) };
    }
    const layers = WidgetQueryContext.sampledGridLayers({ excludedLayerIds });
    if (!layers.length) {
      return { blocked: this.statusModel("waiting", "等待資料合約", "沒有啟用的 sampled-grid 圖層", { date, selection: selected }) };
    }
    const key = [
      selected.selection_id || selected.bbox_string,
      date,
      layers.map((layer) => layer.layerId).sort().join(","),
      selected.selection_grid?.revision || 0,
    ].join("|");
    return { key, selected, date, layers };
  }

  async loadModel(request, generation) {
    const results = await Promise.all(request.layers.map((layer) => (
      WidgetQueryContext.fetchValue(layer, request.selected)
    )));
    const available = results.filter((result) => ["observed", "zero"].includes(result.status));
    const slices = available.map((result) => ({
      label: result.layer.label,
      datasetId: result.layer.datasetId,
      layerId: result.layer.layerId,
      datasetLabel: result.layer.dataset?.label || result.layer.label,
      yKey: "value",
      aggregation: "sum",
      value: Math.max(0, Number(result.value || 0)),
      color: WidgetQueryContext.colorFor(result.layer.layerId, 0.96),
      className: "legend-a",
      status: result.status,
    }));
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    const unavailableCount = results.filter((result) => result.status === "unavailable").length;
    const model = {
      state: available.length ? (total > 0 ? "ready" : "zero") : (unavailableCount ? "error" : "zero"),
      title: total > 0 ? "網格切片比例" : available.length ? "切片總量為 0" : "沒有可用切片",
      detail: `${request.date} / ${request.selected.tile_key || request.selected.label || ""}`,
      date: request.date,
      metric: "value",
      totalLabel: "Y 總量",
      valueRole: "y",
      total,
      slices,
      selection: request.selected,
      rowCount: results.reduce((sum, result) => sum + Number(result.rowCount || 0), 0),
      sourceCount: request.layers.length,
      unavailableCount,
    };
    if (generation === this.generation) {
      this.cache.set(request.key, model);
      window.dispatchEvent(new CustomEvent("rrkal:pie-chart-data-changed", {
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
    return this.statusModel("loading", "載入切片比例", `${request.date} / ${request.layers.length} 個圖層`, {
      date: request.date,
      selection: request.selected,
    });
  }
}

class PieChartWidget extends ChartWidget {
  layerFilter() {
    if (!this.sampledGridLayerFilter) this.sampledGridLayerFilter = new SampledGridWidgetLayerFilter();
    return this.sampledGridLayerFilter;
  }

  chartModel() {
    return PieChartDataSource.shared().model({
      excludedLayerIds: [...this.layerFilter().excludedLayerIds],
    });
  }

  renderCapabilitySettings({ pane } = {}) {
    pane?.append(this.layerFilter().render({
      title: "比例來源圖層",
      onChange: () => {
        PieChartDataSource.shared().clear();
        window.dispatchEvent(new CustomEvent("rrkal:pie-chart-data-changed", {
          detail: { reason: "settings_changed", widgetId: this.id },
        }));
      },
    }));
  }

  rows() {
    return this.dimensions().rows || 1;
  }

  usePlotlyRenderer({ expanded = false } = {}) {
    return expanded || this.rows() >= 2;
  }

  pieChartElementId() {
    return `${this.id}-pie-plotly`;
  }

  isReadyModel(model) {
    return model?.state === "ready"
      && Array.isArray(model.slices)
      && model.slices.some((slice) => Number(slice.value || 0) > 0);
  }

  renderPieState(container, model) {
    const sourceLabel = model?.state === "error"
      ? "pie chart error"
      : model?.state === "zero"
        ? "pie chart zero"
        : "pie chart source";
    this.renderChartEmptyState(container, model, sourceLabel);
  }

  dominantSlice(segments) {
    if (!segments.length) return null;
    return segments.reduce((winner, slice) => (slice.value > winner.value ? slice : winner), segments[0]);
  }

  pieLegend(segments) {
    return segments.map((slice) => `
      <span>
        <i class="${slice.className}"></i>
        <b>${lineChartEscape(slice.label)}</b>
        <em>${slice.percent}%</em>
      </span>
    `).join("");
  }

  pieChartData(segments, { expanded = false, cinema = false } = {}) {
    return [{
      type: "pie",
      labels: segments.map((slice) => slice.label),
      values: segments.map((slice) => slice.value),
      hole: cinema ? 0.5 : 0.58,
      sort: false,
      direction: "clockwise",
      textinfo: expanded ? "label+percent" : "percent",
      textposition: "inside",
      insidetextorientation: "radial",
      marker: {
        colors: segments.map((slice) => slice.color),
        line: { color: "rgba(15, 23, 42, 0.92)", width: 1 },
      },
      hovertemplate: "%{label}<br>Y: %{value}<br>%{percent}<extra></extra>",
    }];
  }

  pieChartLayout(model, { expanded = false, cinema = false } = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: cinema ? { l: 18, r: 18, t: 8, b: 8 } : expanded ? { l: 12, r: 12, t: 6, b: 6 } : { l: 4, r: 4, t: 2, b: 2 },
      autosize: true,
      showlegend: expanded,
      font: { color: "#cbd5e1", family: "Inter, system-ui, sans-serif", size: expanded ? 11 : 10 },
      legend: {
        orientation: "h",
        x: 0.5,
        y: -0.08,
        xanchor: "center",
        bgcolor: "rgba(0,0,0,0)",
        font: { color: "#cbd5e1", size: 10 },
      },
      annotations: [{
        text: model.totalLabel,
        x: 0.5,
        y: 0.5,
        showarrow: false,
        font: { color: "#94a3b8", size: cinema ? 12 : 10 },
      }],
    };
  }

  renderPiePlotlyWhenReady(container, model, segments, options = {}, attempt = 0) {
    const chart = container.querySelector("[data-widget-pie-plotly]");
    if (!chart) return;
    if (!WidgetPlotlyLifecycle.waitUntilDisplayed(
      chart,
      () => this.renderPiePlotlyWhenReady(container, model, segments, options, attempt + 1),
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
    const data = this.pieChartData(segments, options);
    const layout = this.pieChartLayout(model, options);
    const config = { responsive: true, displayModeBar: false, scrollZoom: false };
    Promise.resolve(window.Plotly.react(chart, data, layout, config)).then(() => {
      WidgetPlotlyLifecycle.scheduleResize(chart);
    }).catch((err) => {
      chart.textContent = err.message || "Plotly render failed";
      chart.classList.add("pipeline-chart-empty");
    });
  }

  renderSvgPieTemplate(container, model, segments) {
    const total = segments.reduce((sum, slice) => sum + slice.value, 0);
    const dominant = this.dominantSlice(segments);
    const gradient = `conic-gradient(${segments.map((slice) => `${slice.color} ${slice.start}% ${slice.end}%`).join(", ")})`;

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${dominant.percent}%</strong>
        <em>${lineChartEscape(dominant.label)}</em>
      </div>
      <div class="widget-pie-shape" style="--widget-pie-gradient: ${gradient}" aria-label="圓餅圖空白範本">
        <span class="widget-pie-center">
          <strong>${this.formatValue(total)}</strong>
          <em>${lineChartEscape(model.totalLabel)}</em>
        </span>
      </div>
      <div class="widget-legend-list">
        ${this.pieLegend(segments)}
      </div>
    `;
  }

  renderPlotlyPieTemplate(container, model, segments, { expanded = false, cinema = false } = {}) {
    const dominant = this.dominantSlice(segments);
    const total = segments.reduce((sum, slice) => sum + slice.value, 0);

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${this.formatValue(total)}</strong>
        <em>${lineChartEscape(dominant.label)} / ${dominant.percent}%</em>
      </div>
      <div class="widget-pie-plotly-stage" data-widget-interactive="1">
        <div id="${this.pieChartElementId()}" class="pipeline-plotly-chart widget-pie-plotly-chart" data-widget-pie-plotly aria-label="圓餅圖工具預覽"></div>
      </div>
      <div class="widget-legend-list">
        ${this.pieLegend(segments)}
      </div>
    `;
    this.renderPiePlotlyWhenReady(container, model, segments, { expanded, cinema });
  }

  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-pie");
    if (expanded) container.classList.add("is-expanded");
    const model = this.chartModel();
    if (!this.isReadyModel(model)) {
      this.renderPieState(container, model);
      return;
    }
    const segments = this.pieSegments(model.slices);
    const shouldUsePlotly = this.usePlotlyRenderer({ expanded });
    container.classList.toggle("is-pie-plotly", shouldUsePlotly);
    container.classList.toggle("is-pie-svg", !shouldUsePlotly);
    if (shouldUsePlotly) {
      this.renderPlotlyPieTemplate(container, model, segments, { expanded, cinema });
      return;
    }
    this.renderSvgPieTemplate(container, model, segments);
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { PieChartDataSource, PieChartWidget });
})();
