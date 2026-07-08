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
    draw: { label: "渲染繪製", value: null, text: "-", status: "idle", source: "" },
    eez: { label: "EEZ 靜態圖層", value: null, text: "-", status: "idle" },
  };

  const details = {
    rows: "-",
    persistentScaleMs: 0,
  };

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
        stages.push(stage("前端排程 / 狀態更新", browserTail, metrics.client.status, "", "browser"));
      }
    }

    return stages.filter((item) => item.value !== null && item.value >= 0);
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
      browser: "扣除 API 與繪製後仍留在前端的未歸因時間，通常是事件排程、快取整理、狀態機同步與 DOM 更新；它不是一個獨立資料圖層。",
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
        <span class="pipeline-segment is-${item.status || "ok"} kind-${item.kind || "generic"}${compactClass}" style="--segment-width: ${width}%" title="${tooltip}" data-tooltip="${tooltip}">
          <b>${label}</b>
          <em>${item.text}</em>
          <i class="pipeline-boundary" title="${checkpoint}" data-tooltip="${checkpoint}" aria-label="${checkpoint}"></i>
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

  function renderTimeline() {
    const root = document.getElementById("pipeline-timeline");
    if (!root) return;
    const dynamicStages = buildDynamicStages();
    const persistentStages = buildPersistentStages();
    const scaleTotal = Math.max(
      dynamicStages.reduce((sum, item) => sum + Math.max(item.value || 0, 0), 0),
      persistentStages.reduce((sum, item) => sum + Math.max(item.value || 0, 0), 0),
      details.persistentScaleMs || 0,
      1
    );
    const rows = [
      renderRow("動態資料流", "本張快照需要查詢、序列化、傳輸與繪製", dynamicStages, scaleTotal),
    ];
    if (persistentStages.length) {
      rows.push(renderRow("持久圖層快取", "本張快照通常沿用；啟動或縮放階梯變更時更新", persistentStages, scaleTotal));
    }
    root.innerHTML = rows.join("");
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
    updateSummary,
    stopwatch,
    waitForLayers,
  };
})();
