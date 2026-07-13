(() => {
const { ChartWidget } = window.WidgetCore;
const { lineChartEscape } = window.WidgetCapabilityShared;
const HorizontalBarChartTemplateModel = Object.freeze({
  state: "template",
  title: "等待資料綁定",
  detail: "空白範本",
  xLabel: "指標",
  yLabel: "分類",
  categories: Object.freeze(["Y1", "Y2", "Y3", "Y4", "Y5"]),
  values: Object.freeze([46, 72, 38, 88, 58]),
  colors: Object.freeze([
    "rgba(96, 165, 250, 0.82)",
    "rgba(63, 191, 131, 0.9)",
    "rgba(245, 158, 11, 0.84)",
    "rgba(56, 189, 248, 0.84)",
    "rgba(167, 139, 250, 0.82)",
  ]),
});

class HorizontalBarChartWidget extends ChartWidget {
  chartModel() {
    return HorizontalBarChartTemplateModel;
  }

  horizontalBarChartElementId() {
    return `${this.id}-horizontal-bar-plotly`;
  }

  compactBars(model) {
    const values = model.values.map(Number).filter((value) => Number.isFinite(value));
    const max = Math.max(...values, 1);
    const plotLeft = 45;
    const plotRight = 280;
    const plotTop = 6;
    const plotBottom = 64;
    const step = (plotBottom - plotTop) / Math.max(values.length, 1);
    const barHeight = Math.min(8, step * 0.64);
    return values.map((value, index) => {
      const width = Math.max(5, ((plotRight - plotLeft) * value) / max);
      const y = plotTop + step * index + (step - barHeight) / 2;
      return {
        x: plotLeft,
        y: Number(y.toFixed(2)),
        width: Number(width.toFixed(2)),
        height: Number(barHeight.toFixed(2)),
        label: model.categories[index] || `Y${index + 1}`,
        color: model.colors[index] || model.colors[0],
      };
    });
  }

  horizontalBarChartData(model) {
    return [{
      type: "bar",
      orientation: "h",
      x: [...model.values],
      y: [...model.categories],
      marker: {
        color: [...model.colors],
        line: { color: "rgba(226, 232, 240, 0.18)", width: 1 },
      },
      hoverinfo: "skip",
    }];
  }

  horizontalBarChartLayout(model, { cinema = false } = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(5,10,16,0.5)",
      margin: cinema ? { l: 62, r: 30, t: 18, b: 54 } : { l: 54, r: 22, t: 12, b: 48 },
      autosize: true,
      bargap: 0.38,
      showlegend: false,
      font: { color: "#94a3b8", family: "Inter, system-ui, sans-serif", size: cinema ? 12 : 11 },
      xaxis: {
        title: { text: `X / ${model.xLabel}`, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
        rangemode: "tozero",
      },
      yaxis: {
        title: { text: `Y / ${model.yLabel}`, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.08)",
        zeroline: false,
        autorange: "reversed",
      },
    };
  }

  renderHorizontalBarPlotlyWhenReady(container, model, options = {}, attempt = 0) {
    const chart = container.querySelector("[data-widget-horizontal-bar-plotly]");
    if (!chart) return;
    const rect = chart.getBoundingClientRect();
    if ((rect.width <= 0 || rect.height <= 0) && attempt < 6) {
      window.setTimeout(() => this.renderHorizontalBarPlotlyWhenReady(container, model, options, attempt + 1), 60);
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
      config
    )).then(() => {
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

  renderCompactHorizontalBarTemplate(container, model) {
    const bars = this.compactBars(model);
    const barShapes = bars.map((bar) => `
      <text x="39" y="${bar.y + bar.height / 2 + 2.5}">${lineChartEscape(bar.label)}</text>
      <rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="3" style="--widget-horizontal-bar-color: ${bar.color}" />
    `).join("");
    container.innerHTML = `
      <div class="widget-horizontal-bar-summary">
        <span>空白範本</span>
        <strong>X</strong>
        <em>${lineChartEscape(model.title)}</em>
      </div>
      <div class="widget-horizontal-bar-chart-shell">
        <span class="widget-horizontal-bar-axis widget-horizontal-bar-axis-y">Y</span>
        <svg class="widget-horizontal-bar-chart" viewBox="0 0 286 76" role="img" aria-label="橫條圖空白範本">
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
          <div id="${this.horizontalBarChartElementId()}" class="pipeline-plotly-chart widget-horizontal-bar-plotly-chart" data-widget-horizontal-bar-plotly aria-label="橫條圖工具預覽"></div>
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
    if (expanded) {
      this.renderExpandedHorizontalBarTemplate(container, model, { cinema });
      return;
    }
    this.renderCompactHorizontalBarTemplate(container, model);
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { HorizontalBarChartWidget });
})();
