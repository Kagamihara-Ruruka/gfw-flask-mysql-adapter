(() => {
const { DashboardWidget } = window.WidgetCore;
class MetricsWidget extends DashboardWidget {
  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-metrics");
    if (expanded) container.classList.add("is-expanded");
    if (expanded && cinema) {
      this.renderCinemaMetricsTemplate(container);
    } else if (expanded) {
      this.renderExpandedMetricsTemplate(container);
    } else {
      this.renderCompactMetricsTemplate(container);
    }
    this.bindTelemetry(container);
  }

  renderCompactMetricsTemplate(container) {
    container.dataset.metricsView = "compact";
    container.innerHTML = `
      <div class="widget-metrics-hero">
        <span data-widget-metric-value="headlineLabel">等待資料</span>
        <strong data-widget-metric-value="headline">-</strong>
        <em data-widget-metric-value="headlineHint">最新測速</em>
      </div>
      <div class="widget-metrics-pipeline" aria-label="測速 pipeline">
        <span data-widget-metric-segment="query" style="--segment-share: 1"><i></i><b>SQL</b></span>
        <span data-widget-metric-segment="api" style="--segment-share: 1"><i></i><b>API</b></span>
        <span data-widget-metric-segment="draw" style="--segment-share: 1"><i></i><b>繪製</b></span>
      </div>
      <div class="widget-metrics-foot">
        <span data-widget-metric-value="rows">- rows</span>
        <span data-widget-metric-value="playback">等待播放事件</span>
      </div>
    `;
  }

  renderCinemaMetricsTemplate(container) {
    container.dataset.metricsView = "cinema";
    container.innerHTML = `
      <div class="widget-metrics-cinema-top">
        <div class="widget-metrics-cinema-head">
          <span data-widget-metric-value="headlineLabel">等待資料</span>
          <strong data-widget-metric-value="headline">-</strong>
          <em data-widget-metric-value="rows">- rows</em>
        </div>
        <div class="widget-metrics-pipeline is-expanded is-cinema" aria-label="測速 pipeline 詳細">
          <span data-widget-metric-segment="query" style="--segment-share: 1"><i></i><b>SQL</b></span>
          <span data-widget-metric-segment="api" style="--segment-share: 1"><i></i><b>API</b></span>
          <span data-widget-metric-segment="draw" style="--segment-share: 1"><i></i><b>繪製</b></span>
        </div>
        <div class="widget-metrics-detail-grid is-cinema">
          <span><b data-widget-metric-value="query">-</b><em>SQL</em></span>
          <span><b data-widget-metric-value="serialize">-</b><em>序列化</em></span>
          <span><b data-widget-metric-value="api">-</b><em>API</em></span>
          <span><b data-widget-metric-value="draw">-</b><em>繪製</em></span>
          <span><b data-widget-metric-value="interaction">-</b><em>互動延遲</em></span>
          <span><b data-widget-metric-value="eez">-</b><em>EEZ</em></span>
        </div>
      </div>
        <div class="widget-metrics-history-panel" data-widget-history-panel data-widget-interactive="1">
        <div class="widget-metrics-history-head">
          <div>
            <span>目標時間序列變化記錄</span>
            <em data-widget-metric-value="historyRange">等待快照</em>
          </div>
          <strong data-widget-metric-value="historySummary">0 records</strong>
        </div>
        <div class="widget-metrics-history-chart-wrap">
          <div id="${this.historyChartElementId()}" class="pipeline-plotly-chart widget-metrics-plotly-chart" data-widget-history-plotly aria-label="目標時間序列測速折線圖"></div>
        </div>
      </div>
    `;
  }

  renderExpandedMetricsTemplate(container) {
    container.dataset.metricsView = "expanded";
    container.innerHTML = `
      <div class="widget-metrics-expanded-head">
        <div>
          <span data-widget-metric-value="headlineLabel">等待資料</span>
          <strong data-widget-metric-value="headline">-</strong>
        </div>
        <em data-widget-metric-value="rows">- rows</em>
      </div>
      <div class="widget-metrics-pipeline is-expanded" aria-label="測速 pipeline 詳細">
        <span data-widget-metric-segment="query" style="--segment-share: 1"><i></i><b>SQL</b></span>
        <span data-widget-metric-segment="api" style="--segment-share: 1"><i></i><b>API</b></span>
        <span data-widget-metric-segment="draw" style="--segment-share: 1"><i></i><b>繪製</b></span>
      </div>
      <div class="widget-metrics-detail-grid">
        <span><b data-widget-metric-value="query">-</b><em>SQL</em></span>
        <span><b data-widget-metric-value="serialize">-</b><em>序列化</em></span>
        <span><b data-widget-metric-value="api">-</b><em>API</em></span>
        <span><b data-widget-metric-value="draw">-</b><em>繪製</em></span>
        <span><b data-widget-metric-value="interaction">-</b><em>互動延遲</em></span>
        <span><b data-widget-metric-value="eez">-</b><em>EEZ</em></span>
      </div>
      <div class="widget-metrics-expanded-foot">
        <span>播放事件</span>
        <strong data-widget-metric-value="playback">等待播放事件</strong>
      </div>
    `;
  }

  timingMetricsApi() {
    return this.services.timingMetricsProvider?.() || null;
  }

  metricText(packet, key) {
    return packet?.metrics?.[key]?.text || "-";
  }

  metricNumber(packet, key) {
    const value = Number(packet?.metrics?.[key]?.value);
    return Number.isFinite(value) ? value : 0;
  }

  latestPlaybackText(packet) {
    const events = packet?.details?.playbackEvents || [];
    const latest = events[events.length - 1];
    return latest?.text && latest.text !== "-" ? latest.text : this.metricText(packet, "playback");
  }

  primaryMetric(packet) {
    const candidates = [
      { key: "client", label: "到畫面", hint: "最新快照" },
      { key: "eez", label: "EEZ", hint: "靜態圖層" },
      { key: "draw", label: "繪製", hint: "renderer" },
      { key: "api", label: "API", hint: "傳輸" },
      { key: "query", label: "SQL", hint: "查詢" },
      { key: "interaction", label: "互動延遲", hint: "操作" },
    ];
    const found = candidates.find(({ key }) => {
      const metric = packet?.metrics?.[key];
      return metric?.text && metric.text !== "-";
    });
    if (!found) {
      return { label: "等待資料", value: "-", hint: "最新測速" };
    }
    return {
      label: found.label,
      value: this.metricText(packet, found.key),
      hint: found.hint,
    };
  }

  rowsText(packet) {
    const rows = packet?.details?.rows;
    if (rows === undefined || rows === null || rows === "" || rows === "-") return "- rows";
    return `${rows} rows`;
  }

  formatMsValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "-";
    return `${numeric.toFixed(1)} ms`;
  }

  historySamples(packet) {
    const history = Array.isArray(packet?.snapshotHistory) ? packet.snapshotHistory : [];
    return history.filter((sample) => (
      ["total", "query", "api", "draw"].some((key) => Number.isFinite(Number(sample?.[key])))
    ));
  }

  historyRangeText(samples) {
    if (!samples.length) return "等待快照";
    const first = samples[0]?.label || "#1";
    const last = samples[samples.length - 1]?.label || `#${samples.length}`;
    return first === last ? first : `${first} - ${last}`;
  }

  historySummaryText(samples) {
    if (!samples.length) return "0 records";
    const latest = samples[samples.length - 1];
    return `最近 ${samples.length} 張 / 最新 ${this.formatMsValue(latest?.total)}`;
  }

  historyChartElementId() {
    return `${this.id}-snapshot-performance-chart`;
  }

  statusText(packet) {
    const query = packet?.metrics?.query;
    if (query?.status === "pending") return "查詢中";
    if (query?.text && query.text !== "-" && !query.value) return query.text;
    if (this.metricNumber(packet, "client") > 0) return "已更新";
    if (this.metricNumber(packet, "eez") > 0) return "靜態圖層就緒";
    return "等待資料";
  }

  bindTelemetry(container) {
    const api = this.timingMetricsApi();
    const update = (packet) => this.updateTelemetryView(container, packet);
    if (!api?.subscribe) {
      update(api?.snapshot?.() || null);
      return;
    }
    let wasConnected = false;
    let unsubscribe = null;
    unsubscribe = api.subscribe((packet) => {
      if (container.isConnected) wasConnected = true;
      if (!container.isConnected && wasConnected) {
        unsubscribe?.();
        return;
      }
      update(packet);
    });
  }

  updateTelemetryView(container, packet) {
    const setText = (key, value) => {
      container.querySelectorAll(`[data-widget-metric-value="${key}"]`).forEach((node) => {
        node.textContent = value;
      });
    };
    const primary = this.primaryMetric(packet);
    const playback = this.latestPlaybackText(packet);
    setText("headlineLabel", primary.label);
    setText("headline", primary.value);
    setText("headlineHint", primary.hint);
    setText("client", this.metricText(packet, "client"));
    setText("status", this.statusText(packet));
    setText("query", this.metricText(packet, "query"));
    setText("serialize", this.metricText(packet, "serialize"));
    setText("api", this.metricText(packet, "api"));
    setText("draw", this.metricText(packet, "draw"));
    setText("eez", this.metricText(packet, "eez"));
    setText("rows", this.rowsText(packet));
    setText("playback", playback && playback !== "-" ? playback : "等待播放事件");
    setText("interaction", this.metricText(packet, "interaction"));
    this.updateHistoryChart(container, packet, setText);

    const values = ["query", "api", "draw"].map((key) => this.metricNumber(packet, key));
    const scale = Math.max(...values, 1);
    ["query", "api", "draw"].forEach((key) => {
      const segments = container.querySelectorAll(`[data-widget-metric-segment="${key}"]`);
      const value = this.metricNumber(packet, key);
      const share = value > 0 ? Math.max(0.12, value / scale) : 0.12;
      segments.forEach((segment) => {
        segment.style.setProperty("--segment-share", String(share));
        segment.dataset.metricStatus = packet?.metrics?.[key]?.status || "idle";
      });
    });
  }

  updateHistoryChart(container, packet, setText) {
    const panel = container.querySelector("[data-widget-history-panel]");
    if (!panel) return;
    const samples = this.historySamples(packet);
    setText("historyRange", this.historyRangeText(samples));
    setText("historySummary", this.historySummaryText(samples));

    const chart = panel.querySelector("[data-widget-history-plotly]");
    if (!chart) return;
    const createChart = window.createSnapshotPerformanceChart;
    if (typeof createChart !== "function") {
      chart.textContent = "Plotly 測速元件尚未載入";
      chart.classList.add("pipeline-chart-empty");
      return;
    }
    if (!chart.__snapshotPerformanceChart) {
      chart.__snapshotPerformanceChart = createChart({ elementId: chart.id });
    }
    chart.__snapshotPerformanceChart.renderWhenReady(samples);
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { MetricsWidget });
})();
