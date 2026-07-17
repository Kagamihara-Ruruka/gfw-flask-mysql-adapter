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
          <span><b data-widget-metric-value="consumptionRate">-</b><em>消耗 / 秒</em></span>
          <span><b data-widget-metric-value="supplyRate">-</b><em>補給 / 秒</em></span>
          <span><b data-widget-metric-value="cacheReadyP95">-</b><em>Cache Ready P95</em></span>
          <span><b data-widget-metric-value="readyAheadSlices">-</b><em>前方影格</em></span>
          <span><b data-widget-metric-value="readyAheadSeconds">-</b><em>前方秒數</em></span>
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
        <span><b data-widget-metric-value="consumptionRate">-</b><em>消耗 / 秒</em></span>
        <span><b data-widget-metric-value="supplyRate">-</b><em>補給 / 秒</em></span>
        <span><b data-widget-metric-value="cacheReadyP95">-</b><em>Cache Ready P95</em></span>
        <span><b data-widget-metric-value="readyAheadSlices">-</b><em>前方影格</em></span>
        <span><b data-widget-metric-value="readyAheadSeconds">-</b><em>前方秒數</em></span>
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

  runtimeMetrics() {
    return this.services.runtimeMetricsProvider?.() || null;
  }

  metricText(packet, key) {
    return packet?.metrics?.[key]?.text || "-";
  }

  metricNumber(packet, key) {
    const value = Number(packet?.metrics?.[key]?.value);
    return Number.isFinite(value) ? value : 0;
  }

  formatNumber(value, maximumFractionDigits = 2) {
    return formatDisplayNumber(value, { maximumFractionDigits });
  }

  latestPlaybackText(runtime) {
    if (!runtime) return "等待播放事件";
    const ready = Number(runtime.ready_ahead_slices || 0);
    const seconds = Number(runtime.ready_ahead_seconds || 0);
    const supply = Number(runtime.supply_rate || 0);
    const watermark = runtime.watermark_policy || {};
    const policy = Number(watermark.high_watermark || 0) > 0
      ? ` · 水位 ${Number(watermark.low_watermark || 0)}→${Number(watermark.target_watermark || watermark.high_watermark || 0)}`
      : "";
    const degradation = watermark.degradation_reason ? ` · ${watermark.degradation_reason}` : "";
    return `${runtime.playback_status || "IDLE"} · 前方 ${this.formatNumber(ready, 0)} 張 / ${this.formatNumber(seconds, 1)} s · 補給 ${this.formatNumber(supply, 2)} /s${policy}${degradation}`;
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
    return `${this.formatNumber(rows, 0)} rows`;
  }

  formatMsValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "-";
    return `${this.formatNumber(numeric, 1)} ms`;
  }

  formatRate(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${this.formatNumber(numeric, 2)} /s` : "-";
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
    const eventLog = this.services.eventLog;
    let latestPacket = api?.snapshot?.() || null;
    let wasConnected = false;
    let timer = 0;
    const unsubscribers = [];
    const dispose = () => {
      this.services.cancelSchedule?.(timer);
      timer = 0;
      unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe?.());
    };
    const update = () => {
      timer = 0;
      if (container.isConnected) wasConnected = true;
      if (!container.isConnected && wasConnected) {
        dispose();
        return;
      }
      this.updateTelemetryView(container, latestPacket);
    };
    const scheduleUpdate = () => {
      if (timer) return;
      timer = this.services.schedule?.(update, 160) || 0;
      if (!timer) update();
    };
    if (api?.subscribe) {
      unsubscribers.push(api.subscribe((packet) => {
        latestPacket = packet;
        scheduleUpdate();
      }));
    }
    if (eventLog?.subscribe) unsubscribers.push(eventLog.subscribe(scheduleUpdate, { emitCurrent: false }));
    update();
  }

  updateTelemetryView(container, packet) {
    const setText = (key, value) => {
      container.querySelectorAll(`[data-widget-metric-value="${key}"]`).forEach((node) => {
        node.textContent = value;
      });
    };
    const primary = this.primaryMetric(packet);
    const runtime = this.runtimeMetrics();
    const playback = this.latestPlaybackText(runtime);
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
    setText("consumptionRate", this.formatRate(runtime?.consumption_rate));
    setText("supplyRate", this.formatRate(runtime?.supply_rate));
    setText("cacheReadyP95", this.formatMsValue(runtime?.cache_ready_latency_p95));
    setText("readyAheadSlices", `${this.formatNumber(runtime?.ready_ahead_slices || 0, 0)} 張`);
    setText("readyAheadSeconds", `${this.formatNumber(runtime?.ready_ahead_seconds || 0, 1)} s`);
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
