(() => {
const { ChartWidget } = window.WidgetCore;
const { lineChartDateKey, lineChartFormatDateLabel, lineChartEscape, widgetMetricForDataset } = window.WidgetCapabilityShared;
class LineChartDataSource {
  static shared() {
    if (!LineChartDataSource.instance) {
      LineChartDataSource.instance = new LineChartDataSource();
    }
    return LineChartDataSource.instance;
  }

  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
  }

  clear() {
    this.cache.clear();
    this.inflight.clear();
  }

  selectedCell() {
    return state?.tileSelection?.selected || window.TileSelectionLayer?.selected?.() || null;
  }

  selectedDates(selected = null) {
    const lockedAxis = selected?.time_binding?.kind === "locked_axis"
      ? selected.time_binding.axis
      : null;
    if (!lockedAxis && typeof datesInSelectedRange === "function") {
      return datesInSelectedRange();
    }
    const available = Array.isArray(state?.availableDates) ? state.availableDates : [];
    if (!available.length) return [];
    let start = lockedAxis?.start || $("start-date")?.value || available[0];
    let end = lockedAxis?.end || $("end-date")?.value || available[available.length - 1];
    if (start > end) [start, end] = [end, start];
    return available.filter((date) => date >= start && date <= end);
  }

  metricForDataset(dataset) {
    return widgetMetricForDataset(dataset);
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
    const datasetId = state?.datasetId;
    const dataset = state?.datasets?.[datasetId] || null;
    const selected = this.selectedCell();
    if (!selected) {
      return { blocked: this.statusModel("waiting", "等待網格選取", "尚未點選取樣網格") };
    }
    if (selected.dataset_id && datasetId && selected.dataset_id !== datasetId) {
      return { blocked: this.statusModel("waiting", "等待重新選取", "目前資料集已切換", { selection: selected }) };
    }
    const bboxString = this.selectedBboxString(selected);
    const hasIdentity = Boolean(selected.identity?.column && selected.identity?.value !== undefined && selected.identity?.value !== null);
    if (!bboxString && !hasIdentity) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 bbox 或 identity", { selection: selected }) };
    }
    const dates = this.selectedDates(selected);
    if (!dates.length) {
      return { blocked: this.statusModel("waiting", "等待時間區間", "尚未取得播放器時間序列", { selection: selected }) };
    }
    const metric = this.metricForDataset(dataset);
    if (!datasetId || !dataset || !metric) {
      return { blocked: this.statusModel("waiting", "等待資料合約", "目前圖層沒有可查詢指標", { selection: selected }) };
    }
    const aggregation = "sum";
    const start = dates[0];
    const end = dates[dates.length - 1];
    const key = [
      datasetId,
      metric,
      aggregation,
      start,
      end,
      bboxString || `${selected.identity.column}:${selected.identity.value}`,
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
      identityColumn: hasIdentity ? selected.identity.column : "",
      identityValue: hasIdentity ? selected.identity.value : "",
      start,
      end,
    };
  }

  model() {
    const request = this.requestForCurrentState();
    if (request.blocked) return request.blocked;
    const cached = this.cache.get(request.key);
    if (cached) return cached;
    this.fetch(request);
    return this.statusModel("loading", "載入時間序列", request.selected.tile_key || "等待資料", {
      metric: request.metric,
      yLabel: `${request.aggregation.toUpperCase()} ${request.metric}`,
      unit: request.metric,
      selection: request.selected,
    });
  }

  fetch(request) {
    if (this.inflight.has(request.key)) return this.inflight.get(request.key);
    const params = new URLSearchParams({
      start: request.start,
      end: request.end,
      metric: request.metric,
      aggregation: request.aggregation,
    });
    if (request.bboxString) {
      params.set("bbox", request.bboxString);
    } else {
      params.set("identity_column", request.identityColumn);
      params.set("identity_value", request.identityValue);
    }
    const url = `/api/datasets/${encodeURIComponent(request.datasetId)}/time-series?${params.toString()}`;
    const loader = fetchJson(url)
      .then((packet) => {
        this.cache.set(request.key, this.packetToModel(request, packet));
      })
      .catch((err) => {
        this.cache.set(request.key, this.statusModel("error", "查詢失敗", err.message || "time-series query failed", {
          metric: request.metric,
          yLabel: `${request.aggregation.toUpperCase()} ${request.metric}`,
          unit: request.metric,
          selection: request.selected,
        }));
      })
      .finally(() => {
        this.inflight.delete(request.key);
        window.dispatchEvent(new CustomEvent("rrkal:line-chart-data-changed", {
          detail: { key: request.key },
        }));
      });
    this.inflight.set(request.key, loader);
    return loader;
  }

  packetToModel(request, packet) {
    const pointByDate = new Map();
    for (const point of packet?.points || []) {
      pointByDate.set(lineChartDateKey(point.date), point);
    }
    const values = request.dates.map((date) => {
      const value = Number(pointByDate.get(lineChartDateKey(date))?.value ?? 0);
      return Number.isFinite(value) ? value : 0;
    });
    return {
      state: "ready",
      title: "網格時間序列",
      detail: request.selected.tile_key || "",
      metric: packet?.metric || request.metric,
      unit: packet?.metric || request.metric,
      xLabel: "時間",
      yLabel: `${String(packet?.aggregation || request.aggregation).toUpperCase()} ${packet?.metric || request.metric}`,
      labels: request.dates,
      compactLabels: request.dates.map(lineChartFormatDateLabel),
      series: [
        {
          key: "primary",
          label: request.selected.tile_key || "選取網格",
          color: "#43e28c",
          values,
        },
      ],
      selection: request.selected,
      rowCount: Number(packet?.row_count || 0),
      pointCount: Number(packet?.point_count || 0),
      timing: packet?.timing || {},
    };
  }
}

class LineChartWidget extends ChartWidget {
  chartModel() {
    return LineChartDataSource.shared().model();
  }

  primarySeries(model = this.chartModel()) {
    return model.series[0] || { label: "主要序列", values: [] };
  }

  latestValue(series) {
    return Array.isArray(series?.values) && series.values.length
      ? series.values[series.values.length - 1]
      : null;
  }

  averageValue(series) {
    const values = (series?.values || []).map(Number).filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  lineChartElementId() {
    return `${this.id}-line-chart`;
  }

  lineChartData(model) {
    return (model.series || []).map((series) => ({
      type: "scatter",
      mode: "lines+markers",
      name: series.label,
      x: model.labels,
      y: series.values,
      line: { color: series.color, width: 3, shape: "spline", smoothing: 0.45 },
      marker: { color: series.color, size: 7, line: { color: "rgba(15,23,42,0.86)", width: 1 } },
      hovertemplate:
        `${series.label}<br>` +
        `${model.xLabel}：%{x}<br>` +
        `${model.yLabel}：%{y:.1f} ${model.unit}<extra></extra>`,
    }));
  }

  lineChartLayout(model, { cinema = false } = {}) {
    const yTitle = model.unit ? `${model.yLabel} (${model.unit})` : model.yLabel;
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(5,10,16,0.5)",
      margin: cinema ? { l: 58, r: 28, t: 18, b: 46 } : { l: 48, r: 18, t: 10, b: 38 },
      autosize: true,
      font: { color: "#94a3b8", family: "Inter, system-ui, sans-serif", size: cinema ? 12 : 11 },
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: "#0f172a",
        bordercolor: "rgba(74, 222, 128, 0.72)",
        font: { color: "#e5eefb", family: "Inter, system-ui, sans-serif", size: 12 },
        align: "left",
      },
      legend: {
        orientation: "h",
        x: 0,
        y: 1.14,
        bgcolor: "rgba(0,0,0,0)",
        font: { color: "#cbd5e1" },
      },
      xaxis: {
        title: { text: model.xLabel, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
      },
      yaxis: {
        title: { text: yTitle, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
        rangemode: "tozero",
      },
    };
  }

  renderLinePlotlyWhenReady(container, model, options = {}, attempt = 0) {
    const chart = container.querySelector("[data-widget-line-plotly]");
    if (!chart) return;
    const rect = chart.getBoundingClientRect();
    const measurable = rect.width > 0 && rect.height > 0;
    if (!measurable && attempt < 6) {
      window.setTimeout(() => this.renderLinePlotlyWhenReady(container, model, options, attempt + 1), 60);
      return;
    }
    if (!window.Plotly?.react) {
      chart.textContent = "Plotly 尚未載入";
      chart.classList.add("pipeline-chart-empty");
      return;
    }
    chart.classList.remove("pipeline-chart-empty");
    chart.textContent = "";
    const data = this.lineChartData(model);
    const layout = this.lineChartLayout(model, options);
    const config = { responsive: true, displayModeBar: false, scrollZoom: false };
    Promise.resolve(window.Plotly.react(chart, data, layout, config)).then(() => {
      const resize = () => window.Plotly?.Plots?.resize?.(chart);
      window.requestAnimationFrame(() => {
        resize();
        window.requestAnimationFrame(resize);
      });
      window.setTimeout(resize, 120);
    }).catch((err) => {
      chart.textContent = err.message || "Plotly render failed";
      chart.classList.add("pipeline-chart-empty");
    });
  }

  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-line");
    if (expanded) container.classList.add("is-expanded");
    container.dataset.chartView = cinema ? "cinema" : expanded ? "expanded" : "compact";
    const model = this.chartModel();
    if (!this.isReadyModel(model)) {
      this.renderLineEmptyState(container, model);
      return;
    }
    if (expanded) {
      this.renderExpandedLineTemplate(container, model, { cinema });
      return;
    }
    this.renderCompactLineTemplate(container, model);
  }

  isReadyModel(model) {
    return model?.state === "ready" && Array.isArray(model.labels) && model.labels.length > 0;
  }

  renderLineEmptyState(container, model) {
    this.renderChartEmptyState(
      container,
      model,
      model?.state === "error" ? "time-series error" : "line chart source"
    );
  }

  renderCompactLineTemplate(container, model) {
    const primary = this.primarySeries(model);
    const primaryPoints = this.chartPoints(primary.values);
    const latest = this.latestValue(primary);
    const delta = this.seriesDelta(primary.values);
    const deltaText = `${delta >= 0 ? "+" : ""}${this.formatValue(delta)}`;
    const areaPoints = `${primaryPoints[0]?.x || 18},110 ${this.pointsAttribute(primaryPoints)} ${primaryPoints[primaryPoints.length - 1]?.x || 202},110`;
    const pointDots = primaryPoints.map((point) => (
      `<circle cx="${point.x}" cy="${point.y}" r="2.8" />`
    )).join("");
    const tickStep = Math.max(1, Math.ceil(model.labels.length / 4));
    const xTicks = model.labels.map((label, index) => {
      if (index !== 0 && index !== model.labels.length - 1 && index % tickStep !== 0) return "";
      const point = primaryPoints[index];
      const tickLabel = model.compactLabels?.[index] || lineChartFormatDateLabel(label);
      return point ? `<text x="${point.x}" y="122">${lineChartEscape(tickLabel)}</text>` : "";
    }).join("");
    const legend = (model.series || []).map((series, index) => `
      <span><i class="${index === 0 ? "legend-a" : "legend-b"}"></i>${lineChartEscape(series.label)}</span>
    `).join("");

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${this.formatValue(latest)}</strong>
        <em>${deltaText}</em>
      </div>
      <div class="widget-chart-shell">
        <div class="widget-axis-label widget-axis-y">${lineChartEscape(model.yLabel)}</div>
        <svg class="widget-line-chart" viewBox="0 0 220 124" role="img" aria-label="折線圖空白範本">
          <path class="widget-grid-line" d="M18 20H204M18 50H204M18 80H204M18 110H204" />
          <path class="widget-axis-line" d="M18 14V110H208" />
          <polygon class="widget-line-area" points="${areaPoints}" />
          <polyline class="widget-line-primary" points="${this.pointsAttribute(primaryPoints)}" />
          ${pointDots}
          ${xTicks}
        </svg>
        <div class="widget-axis-label widget-axis-x">${lineChartEscape(model.xLabel)}</div>
      </div>
      <div class="widget-chart-footer">
        ${legend}
      </div>
    `;
  }

  renderExpandedLineTemplate(container, model, { cinema = false } = {}) {
    const primary = this.primarySeries(model);
    const latest = this.latestValue(primary);
    const average = this.averageValue(primary);
    const delta = this.seriesDelta(primary.values);
    const deltaText = `${delta >= 0 ? "+" : ""}${this.formatValue(delta)}`;
    const statCards = [
      ["最新值", this.formatValue(latest), model.unit],
      ["平均值", this.formatValue(average, { maximumFractionDigits: 1 }), model.unit],
      ["變化量", deltaText, model.unit],
    ].map(([label, value, unit]) => `
      <span class="widget-line-stat-card">
        <b>${value}</b>
        <em>${label} / ${unit}</em>
      </span>
    `).join("");
    const seriesList = model.series.map((series) => `
      <span>
        <i style="--series-color: ${series.color}"></i>
        <b>${lineChartEscape(series.label)}</b>
        <em>${series.values.length} points</em>
      </span>
    `).join("");

    container.innerHTML = `
      <div class="widget-line-panel${cinema ? " is-cinema" : ""}">
        <div class="widget-line-summary">
          <div class="widget-chart-header">
            <span>${lineChartEscape(model.title)}</span>
            <strong>${this.formatValue(latest)}</strong>
            <em>${deltaText}</em>
          </div>
          <div class="widget-line-stat-grid">
            ${statCards}
          </div>
        </div>
        <div class="widget-line-plotly-stage" data-widget-interactive="1">
          <div id="${this.lineChartElementId()}" class="pipeline-plotly-chart widget-line-plotly-chart" data-widget-line-plotly aria-label="折線圖工具預覽"></div>
        </div>
        <div class="widget-line-binding-row">
          <span><b>X</b><em>${lineChartEscape(model.xLabel)}</em></span>
          <span><b>Y</b><em>${lineChartEscape(model.yLabel)}</em></span>
          <span><b>Tile</b><em>${lineChartEscape(model.detail || "-")}</em></span>
        </div>
        <div class="widget-chart-footer widget-line-series-list">
          ${seriesList}
        </div>
      </div>
    `;
    this.renderLinePlotlyWhenReady(container, model, { cinema });
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { LineChartDataSource, LineChartWidget });
})();
