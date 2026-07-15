(() => {
const { ChartWidget, WidgetPlotlyLifecycle } = window.WidgetCore;
const {
  lineChartDateKey,
  lineChartFormatDateLabel,
  lineChartEscape,
  widgetMetricForDataset,
  WidgetQueryContext,
} = window.WidgetCapabilityShared;
class LineChartDataSource {
  static shared() {
    if (!LineChartDataSource.instance) {
      LineChartDataSource.instance = new LineChartDataSource();
    }
    return LineChartDataSource.instance;
  }

  constructor() {
    this.errors = new Map();
    this.inflight = new Map();
    this.generation = 0;
    this.windowDays = 30;
  }

  clear() {
    this.generation += 1;
    this.errors.clear();
    this.inflight.clear();
  }

  selectedCell() {
    return state?.tileSelection?.selected || window.TileSelectionLayer?.selected?.() || null;
  }

  scopeDates(selected = null) {
    const lockedAxis = selected?.time_binding?.kind === "locked_axis"
      ? selected.time_binding.axis
      : null;
    const available = Array.isArray(state?.availableDates) ? state.availableDates : [];
    if (!available.length) return [];
    if (!lockedAxis && typeof datesInSelectedRange === "function") {
      return datesInSelectedRange();
    }
    let start = lockedAxis?.start || $("start-date")?.value || available[0];
    let end = lockedAxis?.end || $("end-date")?.value || available[available.length - 1];
    if (start > end) [start, end] = [end, start];
    return available.filter((date) => date >= start && date <= end);
  }

  selectedDates(selected = null) {
    const scope = this.scopeDates(selected);
    if (!scope.length) return [];
    const anchor = WidgetQueryContext.currentDate(selected) || scope[0];
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
    const endIndex = startIndex + windowSize;
    return scope.slice(startIndex, endIndex);
  }

  anchorDate(selected, dates) {
    const requested = lineChartDateKey(WidgetQueryContext.currentDate(selected));
    if (requested && dates.includes(requested)) return requested;
    const later = dates.find((date) => date >= requested);
    return later || dates[dates.length - 1] || "";
  }

  displayDateRange(dates) {
    if (!dates.length) return [];
    return [dates[0], dates[dates.length - 1]];
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
    if (!bboxString) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 bbox", { selection: selected }) };
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
    const anchorDate = this.anchorDate(selected, dates);
    const xRange = this.displayDateRange(dates);
    const layer = {
      datasetId,
      layerId: dataset.layer_id || dataset.data_layer || datasetId,
      label: dataset.label || datasetId,
    };
    const resolution = WidgetQueryContext.resolutionFor(layer, selected);
    const zoom = typeof map !== "undefined" ? map?.getZoom?.() : null;
    const latitude = selected?.center?.lat ?? (typeof map !== "undefined" ? map?.getCenter?.().lat : null);
    const key = [
      datasetId,
      metric,
      aggregation,
      start,
      end,
      resolution ?? "auto",
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
      zoom,
      latitude,
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
    if (typeof DataFrameStore === "undefined") {
      return this.statusModel("error", "快取不可用", "canonical snapshot cache unavailable", {
        metric: request.metric,
        selection: request.selected,
      });
    }
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

  ensureCurrentWindow() {
    const request = this.requestForCurrentState();
    if (request.blocked || typeof DataFrameStore === "undefined") return null;
    const snapshots = this.snapshotSeries(request);
    return snapshots.missingDates.length ? this.fill(request) : null;
  }

  packetRequest(request, date) {
    return {
      datasetId: request.datasetId,
      layerId: request.dataset?.layer_id || request.datasetId,
      date,
      bbox: request.bboxString,
      limit: typeof RenderIntentService !== "undefined" ? RenderIntentService.unlimitedLimit() : "max",
      columns: "render",
      resolution: request.resolution,
      zoom: request.zoom,
      latitude: request.latitude,
      renderProfile: "widget.line.snapshot",
    };
  }

  packetValue(packet) {
    const rows = Array.isArray(packet?.rows) ? packet.rows : [];
    const values = rows
      .map((row) => row?.value)
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map(Number)
      .filter(Number.isFinite);
    return {
      value: values.length ? values.reduce((total, value) => total + value, 0) : null,
      rowCount: rows.length,
    };
  }

  snapshotSeries(request) {
    const points = new Map();
    const missingDates = [];
    const cachedDates = [];
    let rowCount = 0;
    let timing = {};
    for (const date of request.dates) {
      const cached = DataFrameStore.inspect(this.packetRequest(request, date));
      if (cached.status !== "ready" || !cached.packet) {
        missingDates.push(date);
        continue;
      }
      const point = this.packetValue(cached.packet);
      points.set(lineChartDateKey(date), point.value);
      rowCount += point.rowCount;
      timing = cached.packet.timing || timing;
      cachedDates.push(date);
    }
    return { points, missingDates, cachedDates, rowCount, timing };
  }

  cacheEventAffectsCurrent(event) {
    const request = this.requestForCurrentState();
    if (request.blocked) return false;
    const detail = event?.detail || {};
    return detail.datasetId === request.datasetId && request.dates.includes(String(detail.date || ""));
  }

  fill(request) {
    if (this.inflight.has(request.key)) return this.inflight.get(request.key);
    const generation = this.generation;
    const loader = FrameDemandService.demandRange({
      dates: request.dates,
      bbox: request.bboxString,
      datasetId: request.datasetId,
      limit: typeof RenderIntentService !== "undefined" ? RenderIntentService.unlimitedLimit() : "max",
      columns: "render",
      resolution: request.resolution,
      zoom: request.zoom,
      latitude: request.latitude,
    }, {
      lane: "widget",
      scopeId: `widget-line:${request.key}`,
    })
      .then(() => {
        if (generation !== this.generation) return;
        this.errors.delete(request.key);
      })
      .catch((err) => {
        if (err?.name === "AbortError" || generation !== this.generation) return;
        this.errors.set(request.key, err.message || "snapshot cache fill failed");
      })
      .finally(() => {
        if (this.inflight.get(request.key) === loader) {
          this.inflight.delete(request.key);
        }
        if (generation !== this.generation) return;
        window.dispatchEvent(new CustomEvent("rrkal:line-chart-data-changed", {
          detail: { key: request.key },
        }));
      });
    this.inflight.set(request.key, loader);
    return loader;
  }

  snapshotsToModel(request, snapshots) {
    const values = request.dates.map((date) => {
      const rawValue = snapshots.points.get(lineChartDateKey(date));
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
      compactLabels: request.dates.map(lineChartFormatDateLabel),
      anchorDate: request.anchorDate,
      xRange: request.xRange,
      windowDays: request.windowDays,
      series: [
        {
          key: "primary",
          label: request.selected.tile_key || "選取網格",
          color: "#43e28c",
          values,
        },
      ],
      selection: request.selected,
      rowCount: snapshots.rowCount,
      pointCount: snapshots.cachedDates.length,
      timing: snapshots.timing,
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

  currentValue(model, series) {
    const anchorIndex = model.labels.indexOf(model.anchorDate);
    return anchorIndex >= 0 ? series.values[anchorIndex] : this.latestValue(series);
  }

  averageValue(series) {
    const values = (series?.values || []).map(Number).filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  lineChartElementId() {
    return `${this.id}-line-chart`;
  }

  dateX(model, date, { width = 220, padX = 18 } = {}) {
    const [startDate, endDate] = model.xRange || [];
    const start = Date.parse(`${lineChartDateKey(startDate)}T00:00:00Z`);
    const end = Date.parse(`${lineChartDateKey(endDate)}T00:00:00Z`);
    const current = Date.parse(`${lineChartDateKey(date)}T00:00:00Z`);
    if (![start, end, current].every(Number.isFinite) || end <= start) {
      return Number((width / 2).toFixed(2));
    }
    const ratio = Math.max(0, Math.min(1, (current - start) / (end - start)));
    return Number((padX + ratio * (width - (padX * 2))).toFixed(2));
  }

  compactChartPoints(model, series, { width = 220, height = 124, padX = 18, padY = 14 } = {}) {
    const values = Array.isArray(series?.values) ? series.values : [];
    const numericValues = values
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map(Number)
      .filter(Number.isFinite);
    if (!numericValues.length) return values.map(() => null);
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const range = Math.max(max - min, 1);
    return values.map((rawValue, index) => {
      if (rawValue === null || rawValue === undefined || rawValue === "") return null;
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return null;
      return {
        x: this.dateX(model, model.labels[index], { width, padX }),
        y: Number((height - padY - ((value - min) / range) * (height - (padY * 2))).toFixed(2)),
        value,
        index,
      };
    });
  }

  compactChartSegments(points) {
    const segments = [];
    let current = [];
    for (const point of points) {
      if (point) {
        current.push(point);
      } else if (current.length) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length) segments.push(current);
    return segments;
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
    const hasAnchor = Boolean(model.anchorDate);
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
      shapes: hasAnchor ? [{
        type: "line",
        xref: "x",
        yref: "paper",
        x0: model.anchorDate,
        x1: model.anchorDate,
        y0: 0,
        y1: 1,
        line: { color: "rgba(226,232,240,0.72)", width: 1.5, dash: "dot" },
      }] : [],
      annotations: hasAnchor ? [{
        xref: "x",
        yref: "paper",
        x: model.anchorDate,
        y: 1,
        yshift: 8,
        text: `當下切片 ${lineChartFormatDateLabel(model.anchorDate)}`,
        showarrow: false,
        font: { color: "#cbd5e1", size: cinema ? 11 : 10 },
      }] : [],
      xaxis: {
        title: { text: model.xLabel, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
        ...(Array.isArray(model.xRange) && model.xRange.length === 2 ? { range: model.xRange } : {}),
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
    if (!WidgetPlotlyLifecycle.waitUntilDisplayed(
      chart,
      () => this.renderLinePlotlyWhenReady(container, model, options, attempt + 1),
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
    const data = this.lineChartData(model);
    const layout = this.lineChartLayout(model, options);
    const config = { responsive: true, displayModeBar: false, scrollZoom: false };
    Promise.resolve(window.Plotly.react(chart, data, layout, config)).then(() => {
      WidgetPlotlyLifecycle.scheduleResize(chart);
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
    const primaryPoints = this.compactChartPoints(model, primary);
    const segments = this.compactChartSegments(primaryPoints);
    const current = this.currentValue(model, primary);
    const delta = this.seriesDelta(primary.values);
    const deltaText = `${delta >= 0 ? "+" : ""}${this.formatValue(delta)}`;
    const areaPolygons = segments.filter((segment) => segment.length > 1).map((segment) => (
      `<polygon class="widget-line-area" points="${segment[0].x},110 ${this.pointsAttribute(segment)} ${segment[segment.length - 1].x},110" />`
    )).join("");
    const lineSegments = segments.filter((segment) => segment.length > 1).map((segment) => (
      `<polyline class="widget-line-primary" points="${this.pointsAttribute(segment)}" />`
    )).join("");
    const pointDots = primaryPoints.filter(Boolean).map((point) => (
      `<circle cx="${point.x}" cy="${point.y}" r="2.8" />`
    )).join("");
    const anchorX = this.dateX(model, model.anchorDate);
    const tickStep = Math.max(1, Math.ceil(model.labels.length / 4));
    const xTicks = model.labels.map((label, index) => {
      if (index !== 0 && index !== model.labels.length - 1 && index % tickStep !== 0) return "";
      const tickLabel = model.compactLabels?.[index] || lineChartFormatDateLabel(label);
      return `<text x="${this.dateX(model, label)}" y="122">${lineChartEscape(tickLabel)}</text>`;
    }).join("");
    const legend = (model.series || []).map((series, index) => `
      <span><i class="${index === 0 ? "legend-a" : "legend-b"}"></i>${lineChartEscape(series.label)}</span>
    `).join("");

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${this.formatValue(current)}</strong>
        <em>${deltaText}</em>
      </div>
      <div class="widget-chart-shell">
        <div class="widget-axis-label widget-axis-y">${lineChartEscape(model.yLabel)}</div>
        <svg class="widget-line-chart" viewBox="0 0 220 124" role="img" aria-label="折線圖空白範本">
          <path class="widget-grid-line" d="M18 20H204M18 50H204M18 80H204M18 110H204" />
          <path class="widget-axis-line" d="M18 14V110H208" />
          <path class="widget-current-slice-axis" d="M${anchorX} 14V110" />
          ${areaPolygons}
          ${lineSegments}
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
    const current = this.currentValue(model, primary);
    const average = this.averageValue(primary);
    const delta = this.seriesDelta(primary.values);
    const deltaText = `${delta >= 0 ? "+" : ""}${this.formatValue(delta)}`;
    const statCards = [
      ["當日值", this.formatValue(current), model.unit],
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
            <strong>${this.formatValue(current)}</strong>
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
