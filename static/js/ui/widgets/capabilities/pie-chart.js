(() => {
const { ChartWidget, WidgetPlotlyLifecycle } = window.WidgetCore;
const { lineChartEscape, SampledGridWidgetLayerFilter } = window.WidgetCapabilityShared;
class PieChartWidget extends ChartWidget {
  layerFilter() {
    if (!this.sampledGridLayerFilter) this.sampledGridLayerFilter = new SampledGridWidgetLayerFilter({ queryContext: this.services.queryContext });
    return this.sampledGridLayerFilter;
  }

  chartModel() {
    return this.services.dataSource.model({
      excludedLayerIds: [...this.layerFilter().excludedLayerIds],
    });
  }

  renderCapabilitySettings({ pane } = {}) {
    pane?.append(this.layerFilter().render({
      title: "比例來源圖層",
      onChange: () => {
        this.services.dataSource.clear();
        this.services.emit?.("rrkal:pie-chart-data-changed", { reason: "settings_changed", widgetId: this.id });
      },
    }));
  }

  usePlotlyRenderer({ expanded = false } = {}) {
    return expanded;
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

  semiDonutPath(startPercent, endPercent) {
    const centerX = 100;
    const centerY = 100;
    const outerRadius = 92;
    const innerRadius = 56;
    const pointAt = (radius, percent) => {
      const angle = Math.PI + (Math.PI * Number(percent || 0)) / 100;
      return {
        x: Number((centerX + radius * Math.cos(angle)).toFixed(3)),
        y: Number((centerY + radius * Math.sin(angle)).toFixed(3)),
      };
    };
    const outerStart = pointAt(outerRadius, startPercent);
    const outerEnd = pointAt(outerRadius, endPercent);
    const innerEnd = pointAt(innerRadius, endPercent);
    const innerStart = pointAt(innerRadius, startPercent);
    const largeArc = Number(endPercent) - Number(startPercent) > 50 ? 1 : 0;
    return [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      `L ${innerEnd.x} ${innerEnd.y}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
      "Z",
    ].join(" ");
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
    const arcs = segments.map((slice) => (
      `<path d="${this.semiDonutPath(slice.start, slice.end)}" fill="${slice.color}"></path>`
    )).join("");

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${dominant.percent}%</strong>
        <em>${lineChartEscape(dominant.label)}</em>
      </div>
      <div class="widget-pie-shape" aria-label="半圓比例圖">
        <svg viewBox="0 0 200 108" role="img" aria-hidden="true">${arcs}</svg>
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


Object.assign(window.WidgetCapabilities ||= {}, { PieChartWidget });
})();
