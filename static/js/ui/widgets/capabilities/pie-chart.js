(() => {
const { ChartWidget } = window.WidgetCore;
const { lineChartEscape, widgetMetricForDataset } = window.WidgetCapabilityShared;
class PieChartDataSource {
  static shared() {
    if (!PieChartDataSource.instance) {
      PieChartDataSource.instance = new PieChartDataSource();
    }
    return PieChartDataSource.instance;
  }

  clear() {}

  selectedCell() {
    return state?.tileSelection?.selected || window.TileSelectionLayer?.selected?.() || null;
  }

  currentDate(selected) {
    const lockedCursor = selected?.time_binding?.kind === "locked_axis"
      ? selected.time_binding.axis?.cursor
      : null;
    return lockedCursor || $("date")?.value || selected?.date || state?.renderedSampledGridDate || "";
  }

  metricForDataset(dataset, selected) {
    const selectedMetric = selected?.metric?.column;
    const declared = new Set([
      "value",
      ...(dataset?.metric_columns || []),
      ...(dataset?.display_columns || []),
    ]);
    if (selectedMetric && declared.has(selectedMetric)) return selectedMetric;
    return widgetMetricForDataset(dataset);
  }

  selectedBbox(selected) {
    return Array.isArray(selected?.bbox) && selected.bbox.length === 4 ? selected.bbox : null;
  }

  statusModel(stateName, title, detail, extra = {}) {
    return {
      state: stateName,
      title,
      detail,
      date: extra.date || "",
      metric: extra.metric || "指標值",
      totalLabel: extra.totalLabel || "Y 總量",
      valueRole: "y",
      total: 0,
      slices: [],
      selection: extra.selection || null,
      rowCount: 0,
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
    const hasBbox = Boolean(this.selectedBbox(selected));
    const hasIdentity = Boolean(selected.identity?.column && selected.identity?.value !== undefined && selected.identity?.value !== null);
    if (!hasBbox && !hasIdentity) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 bbox 或 identity", { selection: selected }) };
    }
    const date = this.currentDate(selected);
    if (!date) {
      return { blocked: this.statusModel("waiting", "等待時間切片", "尚未取得單日模式日期", { selection: selected }) };
    }
    const metric = this.metricForDataset(dataset, selected);
    if (!datasetId || !dataset || !metric) {
      return { blocked: this.statusModel("waiting", "等待資料合約", "目前圖層沒有可查詢指標", { date, selection: selected }) };
    }
    const recordsContext = state?.recordsContext || {};
    if (typeof isSampledGridLayer !== "function" || !isSampledGridLayer(state?.dataLayer)) {
      return { blocked: this.statusModel("waiting", "等待取樣網格圖層", "圓餅圖需要單日取樣網格資料", { date, metric, selection: selected }) };
    }
    if (
      recordsContext.loading ||
      recordsContext.layer !== state?.dataLayer ||
      recordsContext.date !== date ||
      (state?.renderedSampledGridDate && state.renderedSampledGridDate !== date)
    ) {
      return { blocked: this.statusModel("loading", "載入切片比例", `${date} / ${selected.tile_key || selected.label || ""}`, { date, metric, selection: selected }) };
    }
    return { datasetId, dataset, selected, date, metric };
  }

  rowMatchesIdentity(row, identity) {
    if (!row || !identity?.column) return false;
    return String(row[identity.column]) === String(identity.value);
  }

  rowMatchesBbox(row, bbox) {
    if (!row || !Array.isArray(bbox) || bbox.length !== 4) return false;
    const lat = Number(row.lat);
    const lon = normalizeLongitude(Number(row.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const [west, south, east, north] = bbox.map(Number);
    return lon >= west && lon <= east && lat >= south && lat <= north;
  }

  valueForSelection(rows, selected, metric) {
    const bbox = this.selectedBbox(selected);
    if (bbox) {
      const matchedRows = (rows || []).filter((row) => this.rowMatchesBbox(row, bbox));
      const value = matchedRows.reduce((sum, row) => {
        const next = Number(row?.[metric] ?? 0);
        return sum + (Number.isFinite(next) ? next : 0);
      }, 0);
      return {
        row: matchedRows[0] || null,
        value,
        rowCount: matchedRows.length,
      };
    }
    const row = (rows || []).find((item) => this.rowMatchesIdentity(item, selected.identity));
    const value = Number(row?.[metric] ?? 0);
    return {
      row,
      value: Number.isFinite(value) ? value : 0,
      rowCount: row ? Number(row.source_rows || 1) : 0,
    };
  }

  layerLabel(datasetId, dataset) {
    const layerId = dataset?.layer_id || dataset?.runtime?.layer_id || datasetId;
    return String(layerId || datasetId || "layer").toUpperCase();
  }

  model() {
    const request = this.requestForCurrentState();
    if (request.blocked) return request.blocked;

    const rows = Array.isArray(state?.rows) ? state.rows : [];
    const { value, rowCount } = this.valueForSelection(rows, request.selected, request.metric);
    const total = Math.max(0, value);
    const label = this.layerLabel(request.datasetId, request.dataset);
    const detail = `${request.date} / ${request.selected.tile_key || request.selected.label || ""}`;
    return {
      state: total > 0 ? "ready" : "zero",
      title: total > 0 ? "網格切片比例" : "切片總量為 0",
      detail,
      date: request.date,
      metric: request.metric,
      totalLabel: request.metric,
      valueRole: "y",
      total,
      slices: [{
        label,
        datasetId: request.datasetId,
        layerId: request.dataset?.layer_id || request.datasetId,
        datasetLabel: request.dataset?.label || request.datasetId,
        yKey: request.metric,
        aggregation: "sum",
        value: total,
        color: "rgba(63, 191, 131, 0.96)",
        className: "legend-a",
      }],
      selection: request.selected,
      rowCount,
      recordsRowCount: rows.length,
    };
  }
}

class PieChartWidget extends ChartWidget {
  chartModel() {
    return PieChartDataSource.shared().model();
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
    const rect = chart.getBoundingClientRect();
    const measurable = rect.width > 0 && rect.height > 0;
    if (!measurable && attempt < 6) {
      window.setTimeout(() => this.renderPiePlotlyWhenReady(container, model, segments, options, attempt + 1), 60);
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
