const TimingMetrics = (() => {
  const metricById = {
    "query-ms": "query",
    "serialize-ms": "serialize",
    "api-ms": "api",
    "client-ms": "client",
    "eez-ms": "eez",
  };

  const metrics = {
    query: { label: "SQL 查詢", value: null, text: "-", status: "idle" },
    serialize: { label: "序列化", value: null, text: "-", status: "idle" },
    api: { label: "API / 傳輸", value: null, text: "-", status: "idle" },
    client: { label: "前端到畫面", value: null, text: "-", status: "idle" },
    playback: { label: "播放時間軸", value: null, text: "-", status: "idle", source: "" },
    interaction: { label: "按鍵到渲染開始", value: null, text: "-", status: "idle", source: "" },
    draw: { label: "渲染繪製", value: null, text: "-", status: "idle", source: "" },
    eez: { label: "EEZ 靜態圖層", value: null, text: "-", status: "idle" },
  };

  const details = {
    rows: "-",
    persistentScaleMs: 0,
  };
  const snapshotHistory = [];
  const snapshotHistoryLimit = 48;
  let lastSnapshotSignature = "";
  let activeInteraction = null;

  function formatMs(value) {
    if (value === undefined || value === null || !Number.isFinite(Number(value))) {
      return "-";
    }
    return `${Number(value).toFixed(1)} ms`;
  }

  function numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function setDomText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setMetricText(key, value, options = {}) {
    if (!metrics[key]) return;
    metrics[key] = {
      ...metrics[key],
      value: null,
      text: String(value ?? "-"),
      status: options.status || "text",
      source: options.source || metrics[key].source || "",
      label: options.label || metrics[key].label,
    };
    if (options.render !== false) renderTimeline();
  }

  function setMetricMs(key, value, options = {}) {
    if (!metrics[key]) return;
    const parsed = numberOrNull(value);
    metrics[key] = {
      ...metrics[key],
      value: parsed,
      text: formatMs(parsed),
      status: options.status || "ok",
      source: options.source || metrics[key].source || "",
      label: options.label || metrics[key].label,
    };
    if (key === "eez" && parsed !== null) {
      details.persistentScaleMs = Math.max(0, parsed);
    }
    if (key === "client" && parsed !== null) {
      rememberSnapshotSample(parsed);
    }
    if (options.render !== false) renderTimeline();
  }

  function resetSnapshotPersistent(options = {}) {
    metrics.eez = {
      ...metrics.eez,
      value: null,
      text: "-",
      status: "idle",
      source: "",
    };
    if (options.updateDom !== false) {
      setDomText("eez-ms", "-");
    }
    if (options.render !== false) renderTimeline();
  }

  function markInteraction(label = "使用者操作") {
    activeInteraction = {
      label,
      startedAt: performance.now(),
    };
    metrics.interaction = {
      ...metrics.interaction,
      value: null,
      text: `${label} 等待渲染`,
      status: "pending",
      source: label,
    };
    renderTimeline();
  }

  function markRenderStart(source = "渲染") {
    if (!activeInteraction) return;
    const elapsed = performance.now() - activeInteraction.startedAt;
    metrics.interaction = {
      ...metrics.interaction,
      value: elapsed,
      text: formatMs(elapsed),
      status: "ok",
      source: `${activeInteraction.label} -> ${source}`,
    };
    activeInteraction = null;
    renderTimeline();
  }

  function setText(id, value) {
    setDomText(id, value);
    const key = metricById[id];
    if (key) setMetricText(key, value, { render: false });
  }

  function setMs(id, value) {
    setDomText(id, formatMs(value));
    const key = metricById[id];
    if (key) setMetricMs(key, value, { render: false });
  }

  function currentSnapshotLabel() {
    const candidates = [
      document.getElementById("date")?.value,
      document.getElementById("single-date")?.value,
      document.getElementById("time-current-date")?.textContent,
      document.getElementById("start-date")?.value,
    ];
    return candidates.find((value) => String(value || "").trim()) || `#${snapshotHistory.length + 1}`;
  }

  function rememberSnapshotSample(totalMs) {
    const sample = {
      index: snapshotHistory.length + 1,
      label: currentSnapshotLabel(),
      rows: details.rows || "-",
      total: totalMs,
      query: metrics.query.value,
      serialize: metrics.serialize.value,
      api: metrics.api.value,
      draw: metrics.draw.value,
      recordedAt: performance.now(),
    };
    const signature = [
      sample.label,
      sample.rows,
      Math.round(sample.total || 0),
      Math.round(sample.query || 0),
      Math.round(sample.api || 0),
      Math.round(sample.draw || 0),
    ].join("|");
    const previous = snapshotHistory[snapshotHistory.length - 1];
    if (signature === lastSnapshotSignature && previous) {
      snapshotHistory[snapshotHistory.length - 1] = { ...previous, ...sample, index: previous.index };
      return;
    }
    lastSnapshotSignature = signature;
    snapshotHistory.push(sample);
    while (snapshotHistory.length > snapshotHistoryLimit) {
      snapshotHistory.shift();
    }
    snapshotHistory.forEach((item, idx) => {
      item.index = idx + 1;
    });
  }

  function resetSnapshotHistory(reason = "") {
    window.SnapshotPerformanceChart?.purge?.();
    snapshotHistory.length = 0;
    lastSnapshotSignature = "";
    if (reason) {
      metrics.client = {
        ...metrics.client,
        source: reason,
      };
    }
    renderTimeline();
  }

  function setCount(id, value) {
    const formatted = Number(value || 0).toLocaleString();
    setDomText(id, formatted);
    if (id === "row-count") {
      details.rows = formatted;
    }
  }

  function stage(label, value, status = "ok", source = "", kind = "generic") {
    const parsed = numberOrNull(value);
    return {
      label,
      value: parsed,
      text: parsed === null ? "-" : formatMs(parsed),
      status,
      source,
      kind,
    };
  }

  function textStage(label, value, kind = "generic") {
    const text = String(value || "").trim();
    if (!text || text === "-") return null;
    return stage(`${label}: ${text}`, 1, "text", "", kind);
  }

  function buildDynamicStages() {
    const query = metrics.query.value;
    const serialize = metrics.serialize.value;
    const api = metrics.api.value;
    const client = metrics.client.value;
    const draw = metrics.draw.value;
    const stages = [];

    if (query !== null) stages.push(stage("SQL 查詢", query, metrics.query.status, "", "query"));
    else {
      const fallback = textStage("SQL", metrics.query.text, "query");
      if (fallback) stages.push(fallback);
    }

    if (serialize !== null) stages.push(stage("序列化", serialize, metrics.serialize.status, "", "serialize"));
    else {
      const fallback = textStage("序列化", metrics.serialize.text, "serialize");
      if (fallback) stages.push(fallback);
    }

    if (api !== null) {
      const knownServer = Math.max(0, (query || 0) + (serialize || 0));
      const overhead = Math.max(0, api - knownServer);
      stages.push(stage("API / 傳輸", overhead || api, metrics.api.status, "", "transport"));
    } else {
      const fallback = textStage("API", metrics.api.text, "transport");
      if (fallback) stages.push(fallback);
    }

    if (draw !== null) {
      stages.push(stage(metrics.draw.label || "渲染繪製", draw, metrics.draw.status, metrics.draw.source, "draw"));
    }

    if (client !== null && api !== null) {
      const knownBeforeClient = Math.max(0, api + (draw || 0));
      const browserTail = Math.max(0, client - knownBeforeClient);
      if (browserTail > 0.5) {
        stages.push(stage("前端收尾 / DOM 同步", browserTail, metrics.client.status, "", "browser"));
      }
    }

    return stages.filter((item) => item.value !== null && item.value >= 0);
  }

  function buildInteractionStages() {
    if (metrics.interaction.value !== null) {
      return [
        stage(
          metrics.interaction.label || "按鍵到渲染開始",
          metrics.interaction.value,
          metrics.interaction.status,
          metrics.interaction.source,
          "interaction"
        ),
      ];
    }
    return [];
  }

  function recordPlaybackEvent(event = {}) {
    const payload = typeof event === "string" ? { text: event } : event;
    const parsed = numberOrNull(payload.valueMs ?? payload.ms);
    metrics.playback = {
      ...metrics.playback,
      value: parsed,
      text: parsed === null ? String(payload.text || payload.detail || "-") : formatMs(parsed),
      status: payload.status || (parsed === null ? "text" : "ok"),
      source: payload.source || "",
      label: payload.label || metrics.playback.label,
    };
    renderTimeline();
  }

  function buildPlaybackStages() {
    if (!metrics.playback || !metrics.playback.text || metrics.playback.text === "-") {
      return [];
    }
    return [
      {
        label: metrics.playback.label || "播放時間軸",
        value: metrics.playback.value === null ? 1 : metrics.playback.value,
        text: metrics.playback.text,
        status: metrics.playback.status,
        source: metrics.playback.source,
        kind: "playback",
      },
    ];
  }

  function buildPersistentStages() {
    if (metrics.eez.value !== null) {
      return [stage("EEZ 瓦片就緒", metrics.eez.value, metrics.eez.status, "", "eez")];
    }
    const fallback = textStage("EEZ", metrics.eez.text, "eez");
    return fallback ? [fallback] : [];
  }

  function stageTooltip(item, rowTitle) {
    const rows = details.rows || document.getElementById("row-count")?.textContent || "-";
    const source = item.source ? `\n渲染來源：${item.source}` : "";
    const row = rowTitle ? `\n管線：${rowTitle}` : "";
    const explain = {
      query: "資料庫執行查詢並回傳符合視窗、日期、LOD 條件的資料。",
      serialize: "後端把查詢結果整理成 API 可以回傳的 JSON payload。",
      transport: "API 總耗時扣除 SQL 與序列化後的傳輸、Flask 包裝與路由開銷。",
      draw: "前端把資料畫到 WebGL 或 Canvas 圖層上的實際繪製耗時。",
      browser: "快照已開始處理後，扣除 API 與繪製仍留在前端的未歸因時間，通常是快取整理、狀態機同步與 DOM 更新；它不是按鍵到渲染開始的等待時間。",
      playback: "播放器時間軸事件，例如播放開始、等待 frame buffer、顯示 snapshot 或停止；它是控制面觀測，不與資料快照耗時相加。",
      interaction: "使用者按下播放、回到開始日期、前後一日等控制後，到第一個實際渲染函式被呼叫前的等待時間。",
      eez: "持久圖層的瓦片或快取準備時間；通常不會每張快照都重新查詢。",
      generic: "未分類的資料流階段。",
    }[item.kind || "generic"];
    return `${item.label}\n耗時：${item.text}\n資料列：${rows}${row}${source}\n${explain}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function boundaryTooltip(item, rowTitle, cumulative, total, scale) {
    const rows = details.rows || document.getElementById("row-count")?.textContent || "-";
    const ratio = scale > 0 ? ((cumulative / scale) * 100).toFixed(1) : "0.0";
    return [
      `Checkpoint：${item.label} 結束`,
      `左側累計：${formatMs(cumulative)}`,
      `本段耗時：${item.text}`,
      `本列合計：${formatMs(total)}`,
      `快照比例：${ratio}%`,
      `資料列：${rows}`,
      `管線：${rowTitle}`,
    ].join("\n");
  }

  function eventTooltip(item, rowTitle) {
    const rows = details.rows || document.getElementById("row-count")?.textContent || "-";
    const source = item.source ? `\n來源：${item.source}` : "";
    return [
      item.label,
      `事件：${item.text}`,
      `資料列：${rows}`,
      `管線：${rowTitle}`,
      source.trim(),
    ].filter(Boolean).join("\n");
  }

  function renderEventRow(title, subtitle, stages) {
    if (!stages.length) {
      return `
        <div class="pipeline-row">
          <div class="pipeline-row-label">
            <strong>${title}</strong>
            <span>${subtitle}</span>
          </div>
          <div class="pipeline-track is-empty">沒有本輪資料</div>
        </div>
      `;
    }
    const events = stages.map((item) => {
      const label = item.source ? `${item.label} · ${item.source}` : item.label;
      const tooltip = escapeHtml(eventTooltip(item, title));
      return `
        <span class="pipeline-segment pipeline-event is-${item.status || "text"} kind-${item.kind || "generic"}" title="${tooltip}">
          <b>${label}</b>
          <em>${item.text}</em>
        </span>
      `;
    }).join("");
    return `
      <div class="pipeline-row">
        <div class="pipeline-row-label">
          <strong>${title}</strong>
          <span>${subtitle}</span>
        </div>
        <div class="pipeline-event-track">${events}</div>
      </div>
    `;
  }

  function renderRow(title, subtitle, stages, scaleTotal) {
    const total = stages.reduce((sum, item) => sum + Math.max(item.value || 0, 0), 0);
    if (!stages.length || total <= 0) {
      return `
        <div class="pipeline-row">
          <div class="pipeline-row-label">
            <strong>${title}</strong>
            <span>${subtitle}</span>
          </div>
          <div class="pipeline-track is-empty">沒有本輪資料</div>
        </div>
      `;
    }
    const scale = Math.max(scaleTotal || total, total, 1);
    const offset = Math.max(0, ((scale - total) / scale) * 100);
    let cumulative = 0;
    const segments = stages.map((item) => {
      const width = Math.max(0.5, (item.value / scale) * 100);
      const label = item.source ? `${item.label} · ${item.source}` : item.label;
      const compactClass = width < 10 ? " is-compact" : "";
      cumulative += Math.max(item.value || 0, 0);
      const tooltip = escapeHtml(stageTooltip(item, title));
      const checkpoint = escapeHtml(boundaryTooltip(item, title, cumulative, total, scale));
      return `
        <span class="pipeline-segment is-${item.status || "ok"} kind-${item.kind || "generic"}${compactClass}" style="--segment-width: ${width}%" title="${tooltip}">
          <b>${label}</b>
          <em>${item.text}</em>
          <i class="pipeline-boundary" title="${checkpoint}" aria-label="${checkpoint}"></i>
        </span>
      `;
    }).join("");
    const offsetHtml = offset > 0.05
      ? `<span class="pipeline-offset" style="--offset-width: ${offset}%"></span>`
      : "";
    return `
      <div class="pipeline-row">
        <div class="pipeline-row-label">
          <strong>${title}</strong>
          <span>${subtitle} / 快照共用比例尺 / 合計 ${formatMs(total)}</span>
        </div>
        <div class="pipeline-track">${offsetHtml}${segments}</div>
      </div>
    `;
  }

  function renderPerformancePlotly() {
    window.SnapshotPerformanceChart?.renderWhenReady?.(snapshotHistory.slice());
  }

  function renderPerformanceChart() {
    const samples = snapshotHistory.slice();
    const latest = samples[samples.length - 1];
    const summary = samples.length >= 2 && latest
      ? `最近 ${samples.length} 張 / 最新 ${formatMs(latest.total)}`
      : "播放或回到開始日期後重新累積";
    return `
      <section class="pipeline-chart-card">
        <div class="pipeline-chart-header">
          <strong>快照耗時線圖</strong>
          <span>${summary}</span>
        </div>
        <div id="snapshot-performance-chart" class="pipeline-plotly-chart" aria-label="每張快照耗時折線圖"></div>
      </section>
    `;
  }

  function renderTimeline() {
    const root = document.getElementById("pipeline-timeline");
    if (!root) return;
    const playbackStages = buildPlaybackStages();
    const interactionStages = buildInteractionStages();
    const dynamicStages = buildDynamicStages();
    const persistentStages = buildPersistentStages();
    const scaleTotal = Math.max(
      interactionStages.reduce((sum, item) => sum + Math.max(item.value || 0, 0), 0),
      dynamicStages.reduce((sum, item) => sum + Math.max(item.value || 0, 0), 0),
      persistentStages.reduce((sum, item) => sum + Math.max(item.value || 0, 0), 0),
      details.persistentScaleMs || 0,
      1
    );
    const rows = [];
    if (playbackStages.length) {
      rows.push(renderEventRow("播放時間軸", "控制事件；不擁有查詢、渲染或模糊時間", playbackStages));
    }
    if (interactionStages.length) {
      rows.push(renderRow("互動延遲", "使用者操作到第一個渲染呼叫；不與快照耗時相加", interactionStages, scaleTotal));
    }
    rows.push(renderRow("動態資料流", "本張快照需要查詢、序列化、傳輸與繪製", dynamicStages, scaleTotal));
    if (persistentStages.length) {
      rows.push(renderRow("持久圖層快取", "本張快照通常沿用；啟動或縮放階梯變更時更新", persistentStages, scaleTotal));
    }
    root.innerHTML = rows.join("") + renderPerformanceChart();
    window.requestAnimationFrame(() => {
      renderPerformancePlotly();
      window.requestAnimationFrame(() => {
        window.SnapshotPerformanceChart?.refresh?.();
      });
    });
  }

  function updateSummary() {
    const rows = details.rows || "-";
    const client = metrics.client.text || "-";
    const eez = metrics.eez.text || "-";
    setDomText("metrics-summary", `資料列 ${rows} / 到畫面 ${client} / EEZ ${eez}`);
    renderTimeline();
  }

  function stopwatch() {
    const started = performance.now();
    return {
      elapsed() {
        return performance.now() - started;
      },
    };
  }

  function waitForLayerLoad(layer, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        layer.off?.("load", onLoad);
        layer.off?.("tileerror", onError);
      };
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("圖層載入錯誤"));
      };
      layer.once?.("load", onLoad);
      layer.once?.("tileerror", onError);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("圖層載入逾時"));
      }, timeoutMs);
    });
  }

  async function waitForLayers(layers, timeoutMs) {
    await Promise.all(layers.map((layer) => waitForLayerLoad(layer, timeoutMs)));
  }

  return {
    formatMs,
    setText,
    setMs,
    setCount,
    setMetricMs,
    setMetricText,
    resetSnapshotPersistent,
    resetSnapshotHistory,
    recordPlaybackEvent,
    markInteraction,
    markRenderStart,
    updateSummary,
    stopwatch,
    waitForLayers,
  };
})();
