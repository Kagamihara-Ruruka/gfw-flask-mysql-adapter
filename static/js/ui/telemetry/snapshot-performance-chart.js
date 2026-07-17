class SnapshotPerformanceChart {
  constructor(options = {}) {
    this.elementId = options.elementId || "snapshot-performance-chart";
    this.lastSamples = [];
    this.resizeObserver = null;
    this.observedElement = null;
    this.retryTimer = null;
    this.series = options.series || [
      { key: "total", name: "總耗時", color: "#43e28c" },
      { key: "query", name: "SQL", color: "#27c2ad" },
      { key: "api", name: "API / 傳輸", color: "#4b8fff" },
      { key: "draw", name: "繪製", color: "#e1a34d" },
    ];
  }

  numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  formatMs(value) {
    const parsed = this.numberOrNull(value);
    return parsed === null ? "-" : `${formatDisplayNumber(parsed, { maximumFractionDigits: 1 })} ms`;
  }

  displayDetail(sample, item) {
    return String(sample?.sources?.[item.key] || item.name || "").trim();
  }

  getElement() {
    return document.getElementById(this.elementId);
  }

  observeElement(chart) {
    if (!window.ResizeObserver || this.observedElement === chart) return;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.observedElement = chart;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.lastSamples.length) return;
      this.scheduleResize(chart);
    });
    this.resizeObserver.observe(chart);
  }

  scheduleResize(chart) {
    const resize = () => {
      if (!chart.isConnected || !window.Plotly?.Plots?.resize) return;
      window.Plotly.Plots.resize(chart);
    };
    window.requestAnimationFrame(() => {
      resize();
      window.requestAnimationFrame(resize);
    });
    window.setTimeout(resize, 80);
    window.setTimeout(resize, 240);
  }

  isMeasurable(chart) {
    if (!chart || !chart.isConnected) return false;
    const rect = chart.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  refresh() {
    const chart = this.getElement();
    if (!chart || !this.lastSamples.length) return;
    this.scheduleResize(chart);
  }

  renderWhenReady(samples = [], attempt = 0) {
    const chart = this.getElement();
    if (!chart) return;
    if (this.isMeasurable(chart) || attempt >= 6) {
      this.render(samples);
      return;
    }
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.renderWhenReady(samples, attempt + 1);
    }, 60);
  }

  drawPlot(chart, data, layout, config) {
    const hasRenderedSvg = Boolean(chart.querySelector(".main-svg"));
    if (!hasRenderedSvg && window.Plotly?.newPlot) {
      return window.Plotly.newPlot(chart, data, layout, config);
    }
    return window.Plotly.react(chart, data, layout, config);
  }

  recoverEmptyPlot(chart, data, layout, config) {
    if (!chart.isConnected || chart.querySelector(".main-svg") || !window.Plotly?.newPlot) return;
    if (window.Plotly?.purge) {
      window.Plotly.purge(chart);
    }
    Promise.resolve(window.Plotly.newPlot(chart, data, layout, config))
      .then(() => {
        chart.dataset.snapshotStatus = "rendered";
        this.scheduleResize(chart);
      })
      .catch((err) => {
        chart.dataset.snapshotStatus = "error";
        this.setEmpty(err.message || "Plotly render failed");
      });
  }

  trace(samples, item) {
    return {
      type: "scatter",
      mode: samples.length > 1 ? "lines+markers" : "markers",
      name: item.name,
      x: samples.map((sample) => sample.index),
      y: samples.map((sample) => this.numberOrNull(sample[item.key])),
      customdata: samples.map((sample) => [
        sample.label,
        sample.rows,
        this.displayDetail(sample, item),
        this.formatMs(sample[item.key]),
      ]),
      connectgaps: false,
      line: { color: item.color, width: 2.5, shape: "spline", smoothing: 0.55 },
      marker: { color: item.color, size: samples.length > 1 ? 6 : 8 },
      hovertemplate:
        "%{fullData.name}<br>" +
        "顯示細項：%{customdata[2]}<br>" +
        "快照：%{customdata[0]}<br>" +
        "資料列：%{customdata[1]}<br>" +
        "耗時：%{customdata[3]}<extra></extra>",
    };
  }

  layout(samples) {
    const xRange = samples.length === 1
      ? [Math.max(0, samples[0].index - 1), samples[0].index + 1]
      : undefined;
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(5,10,16,0.58)",
      margin: { l: 48, r: 18, t: 8, b: 38 },
      autosize: true,
      font: { color: "#94a3b8", family: "Inter, system-ui, sans-serif", size: 11 },
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
        y: 1.18,
        bgcolor: "rgba(0,0,0,0)",
        font: { color: "#cbd5e1" },
      },
      xaxis: {
        title: { text: "snapshot", font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
        dtick: Math.max(1, Math.ceil(samples.length / 8)),
        range: xRange,
      },
      yaxis: {
        title: { text: "ms", font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
        rangemode: "tozero",
      },
    };
  }

  setEmpty(text) {
    const chart = this.getElement();
    if (!chart) return;
    this.lastSamples = [];
    chart.dataset.snapshotCount = "0";
    chart.textContent = text;
    chart.classList.add("pipeline-chart-empty");
  }

  render(samples = []) {
    const chart = this.getElement();
    if (!chart) return;
    this.observeElement(chart);
    if (!samples.length) {
      this.setEmpty("等待第一張快照");
      return;
    }
    if (!window.Plotly?.react) {
      this.setEmpty("Plotly 尚未載入");
      return;
    }

    this.lastSamples = samples.slice();
    chart.classList.remove("pipeline-chart-empty");
    chart.dataset.snapshotCount = String(samples.length);
    chart.textContent = "";
    const data = this.series.map((item) => this.trace(samples, item));
    const config = { responsive: true, displayModeBar: false, scrollZoom: false };
    chart.dataset.snapshotStatus = "rendering";
    const layout = this.layout(samples);
    Promise.resolve(this.drawPlot(chart, data, layout, config))
      .then(() => {
        chart.dataset.snapshotStatus = "rendered";
        this.scheduleResize(chart);
        window.setTimeout(() => {
          this.recoverEmptyPlot(chart, data, layout, config);
        }, 180);
      })
      .catch((err) => {
        chart.dataset.snapshotStatus = "error";
        this.setEmpty(err.message || "Plotly render failed");
      });
  }

  purge() {
    const chart = this.getElement();
    this.lastSamples = [];
    window.clearTimeout(this.retryTimer);
    if (chart && window.Plotly?.purge) {
      window.Plotly.purge(chart);
    }
  }
}

window.createSnapshotPerformanceChart = (options = {}) => new SnapshotPerformanceChart(options);
window.SnapshotPerformanceChart = new SnapshotPerformanceChart();
