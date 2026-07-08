async function fetchJson(url) {
  const res = await fetch(url);
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || res.statusText);
  }
  return payload;
}

async function loadDatasets() {
  const packet = await fetchJson("/api/datasets");
  state.datasets = packet.datasets || {};
  const imported = new Set(packet.imported_layers || ["gfw", "ais", "eez"]);
  state.importedLayerIds = Array.from(imported);
  state.importedLayers = {
    gfw: imported.has("gfw"),
    ais: imported.has("ais"),
    eez: imported.has("eez"),
  };
  // Keep frontend limits aligned with the Flask adapter config.
  state.queryPolicy = packet.query_policy || state.queryPolicy;
  const datasetIds = Object.keys(state.datasets);
  state.datasetId = packet.default_dataset && state.datasets[packet.default_dataset]
    ? packet.default_dataset
    : (datasetIds[0] || null);
  renderDatasetSelect();
  updateDataLayerMenu();
}

function renderDatasetSelect() {
  const select = $("dataset-select");
  if (!select) return;
  select.innerHTML = "";
  const entries = Object.entries(state.datasets || {});
  if (!entries.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "尚未導入資料圖層";
    select.appendChild(option);
    select.value = "";
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const [datasetId, dataset] of entries) {
    const option = document.createElement("option");
    option.value = datasetId;
    option.textContent = dataset.label || datasetId;
    const route = [dataset.source_config, dataset.connection_ref].filter(Boolean).join(" / ");
    option.title = route || datasetId;
    select.appendChild(option);
  }
  select.value = state.datasetId || "";
}

async function selectDataset(datasetId) {
  if (!datasetId || !state.datasets[datasetId] || datasetId === state.datasetId) return;
  stopPlayback();
  state.datasetId = datasetId;
  state.rows = [];
  state.columns = [];
  state.renderedGfwDate = null;
  if (typeof GfwRecordCache !== "undefined") {
    GfwRecordCache.clear();
  }
  if (typeof PlaybackCacheService !== "undefined") {
    PlaybackCacheService.clear();
  }
  await loadSchema();
  if (state.dataLayer === "gfw") {
    await reloadGfwRecords();
  } else {
    renderTable([], state.datasets[state.datasetId].display_columns, { layer: "none" });
    updatePlaybackControls();
  }
}

async function loadSchema() {
  if (!state.datasetId || !state.datasets[state.datasetId]) {
    state.schema = null;
    setAvailableDates([]);
    return null;
  }
  const packet = await fetchJson(`/api/datasets/${state.datasetId}/schema`);
  state.schema = packet;
  setAvailableDates(packet.dates || []);
  if (packet.bounds) {
    map.fitBounds(
      L.latLngBounds(
        [Number(packet.bounds.min_lat), Number(packet.bounds.min_lon)],
        [Number(packet.bounds.max_lat), Number(packet.bounds.max_lon)]
      ),
      { padding: [20, 20], maxZoom: 3, animate: false }
    );
  }
}

async function reloadAisRecords() {
  return startAisWebSocket();
}

async function loadAisSettings() {
  const packet = await fetchJson("/api/live/ais/settings");
  state.aisSettings = packet;
  try {
    state.aisIngestStatus = await fetchJson("/api/live/ais/ingest/status");
  } catch (err) {
    state.aisIngestStatus = { status: "error", error: err.message };
  }
  updateAisSettingsPanel();
  return packet;
}

async function saveAisApiKey(apiKey) {
  const res = await fetch("/api/live/ais/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || res.statusText);
  }
  state.aisSettings = payload;
  updateAisSettingsPanel();
  return payload;
}

async function disconnectAisApiKey() {
  const res = await fetch("/api/live/ais/settings", { method: "DELETE" });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || res.statusText);
  }
  state.aisSettings = payload;
  updateAisSettingsPanel();
  return payload;
}

async function runAisDiagnostics() {
  const params = new URLSearchParams();
  params.set("duration_seconds", "12");
  return fetchJson(`/api/live/ais/diagnostics?${params}`);
}

async function saveAishubUsername(username) {
  const res = await fetch("/api/live/ais/aishub/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || res.statusText);
  }
  state.aisSettings = { ...(state.aisSettings || {}), ...payload };
  updateAisSettingsPanel();
  return payload;
}

async function disconnectAishubUsername() {
  const res = await fetch("/api/live/ais/aishub/settings", { method: "DELETE" });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || res.statusText);
  }
  state.aisSettings = { ...(state.aisSettings || {}), ...payload };
  updateAisSettingsPanel();
  return payload;
}

function aisWebSocketUrl(bboxes) {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams();
  for (const bbox of bboxes) {
    params.append("bbox", bbox);
  }
  params.set("interval_ms", "3000");
  return `${scheme}://${window.location.host}/ws/live/ais?${params}`;
}

function closeAisSocket() {
  if (!state.aisSocket) return;
  const socket = state.aisSocket;
  state.aisSocket = null;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  socket.close();
}

function applyAisPacket(packet, bboxes, timing) {
  if (packet.status === "warming") {
    RenderState.loading("ais", "預熱中");
    TimingMetrics.setText("query-ms", "串流預熱");
    TimingMetrics.setText("serialize-ms", "-");
    TimingMetrics.setText("api-ms", "WebSocket");
    TimingMetrics.setMs("client-ms", timing.elapsed());
    TimingMetrics.setCount("row-count", 0);
    TimingMetrics.updateSummary();
    setStatus(packet.message || "AIS 串流預熱中");
    return;
  }
  if (packet.status === "locked") {
    const gate = packet.key_gate || packet.ingest?.key_gate || {};
    removeAisLayer();
    renderTable([], AIS_COLUMNS, { layer: "ais", wrappedBboxCount: bboxes.length });
    TimingMetrics.setText("query-ms", "-");
    TimingMetrics.setText("serialize-ms", "-");
    TimingMetrics.setText("api-ms", "已鎖定");
    TimingMetrics.setMs("client-ms", timing.elapsed());
    TimingMetrics.setCount("row-count", 0);
    TimingMetrics.updateSummary();
    RenderState.error("ais", "金鑰門檻鎖定");
    setStatus(gate.message || packet.message || "AIS SQL 讀取被收集器金鑰門檻鎖定。", true);
    return;
  }
  if (packet.status !== "ok") {
    throw new Error(packet.error || packet.message || "AIS 即時來源失敗");
  }
  const rows = packet.rows || [];
  renderAisMap(rows);
  renderTable(rows, AIS_COLUMNS, { layer: "ais", wrappedBboxCount: bboxes.length });
  TimingMetrics.setText("query-ms", `${Number(packet.timing?.query_ms || 0).toFixed(3)} ms`);
  TimingMetrics.setText("serialize-ms", "-");
  TimingMetrics.setText("api-ms", "WebSocket");
  TimingMetrics.setMs("client-ms", timing.elapsed());
  TimingMetrics.setCount("row-count", rows.length);
  TimingMetrics.updateSummary();
  RenderState.ready("ais", `${rows.length.toLocaleString()} 筆`);
  const stream = packet.stream
    ? `，來源 ${Number(packet.stream.accepted_messages || 0).toLocaleString()} 筆`
    : "";
  if (packet.transport === "sql_ingest_websocket") {
    const ingest = packet.ingest || {};
    const ingestState = ingest.connected ? "寫入中" : ingest.running ? "預熱中" : "閒置";
    const accepted = Number(ingest.accepted_messages || 0).toLocaleString();
    const written = Number(ingest.written_rows || 0).toLocaleString();
    const skipped = Number(ingest.skipped_stale_rows || 0).toLocaleString();
    const store = ingest.store || {};
    const storeCount = Number(store.vessel_count || rows.length || 0).toLocaleString();
    const storeSuffix = store.status === "ok" ? `，SQL 庫存 ${storeCount}` : "";
    setStatus(
      `AIS SQL 收集器${ingestState}，可見船舶 ${rows.length.toLocaleString()} 艘${storeSuffix}，接收 ${accepted} 筆，寫入 ${written} 筆，略過過期 ${skipped} 筆`
    );
    return;
  }
  if (packet.transport === "aishub_polling") {
    const interval = Number(packet.stream?.poll_interval_seconds || 180);
    setStatus(`AISHub 輪詢，可見船舶 ${rows.length.toLocaleString()} 艘${stream}，間隔 ${interval} 秒`);
    return;
  }
  setStatus(`AIS 本機 SQL 串流，可見船舶 ${rows.length.toLocaleString()} 艘${stream}，${bboxes.length} 個循環邊界框`);
}

function startAisWebSocket() {
  const seq = ++state.aisLiveSeq;
  const timing = TimingMetrics.stopwatch();
  TimingMetrics.resetSnapshotPersistent?.({ render: false });
  const bboxes = currentWrappedBboxes();
  closeAisSocket();
  RenderState.loading("ais", "連線中");
  setStatus("正在開啟本機 AIS SQL 串流");

  return new Promise((resolve) => {
    let resolved = false;
    let fallbackStarted = false;
    const socket = new WebSocket(aisWebSocketUrl(bboxes));
    state.aisSocket = socket;

    const fallbackToRest = () => {
      if (fallbackStarted || seq !== state.aisLiveSeq || state.dataLayer !== "ais") return;
      fallbackStarted = true;
      if (!resolved) {
        resolved = true;
        reloadAisRecordsRest().finally(resolve);
      }
    };

    socket.onopen = () => {
      if (seq !== state.aisLiveSeq || state.dataLayer !== "ais") {
        closeAisSocket();
        return;
      }
      setStatus("AIS SQL 串流已連線");
    };
    socket.onmessage = (event) => {
      if (seq !== state.aisLiveSeq || state.dataLayer !== "ais") return;
      try {
        const packet = JSON.parse(event.data);
        applyAisPacket(packet, bboxes, timing);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      } catch (err) {
        console.error(err);
        RenderState.error("ais", "封包失敗");
        setStatus(err.message, true);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
    };
    socket.onerror = () => {
      RenderState.loading("ais", "切換備援");
      setStatus("AIS 本機串流失敗，切換到 REST 備援", true);
      fallbackToRest();
    };
    socket.onclose = () => {
      if (seq === state.aisLiveSeq && state.dataLayer === "ais" && !resolved) {
        fallbackToRest();
      }
    };
  });
}

async function reloadAisRecordsRest() {
  const seq = ++state.aisLiveSeq;
  const timing = TimingMetrics.stopwatch();
  TimingMetrics.resetSnapshotPersistent?.({ render: false });
  RenderState.loading("ais", "REST 備援");
  setStatus("正在載入 AIS REST 備援");
  const bboxes = currentWrappedBboxes();
  const packets = await Promise.all(bboxes.map((bbox) => {
    const params = new URLSearchParams();
    params.set("bbox", bbox);
    return fetchJson(`/api/live/ais?${params}`).catch((err) => ({
      status: "error",
      error: err.message,
      rows: [],
      row_count: 0,
      timing: { query_ms: 0 },
    }));
  }));
  if (seq !== state.aisLiveSeq || state.dataLayer !== "ais") return;
  const locked = packets.find((packet) => packet.status === "locked");
  if (locked) {
    applyAisPacket(locked, bboxes, timing);
    return;
  }
  const failed = packets.find((packet) => packet.status !== "ok");
  if (failed) {
    throw new Error(failed.error || failed.message || "AIS REST 備援失敗");
  }
  const seen = new Set();
  const rows = [];
  let queryMs = 0;
  for (const packet of packets) {
    queryMs += Number(packet.timing?.query_ms || 0);
    for (const row of packet.rows || []) {
      const key = `${row.mmsi}|${row.event_time}|${row.lat}|${row.lon}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  renderAisMap(rows);
  renderTable(rows, AIS_COLUMNS, { layer: "ais", wrappedBboxCount: bboxes.length });
  TimingMetrics.setText("query-ms", `${queryMs.toFixed(3)} ms`);
  TimingMetrics.setText("serialize-ms", "-");
  TimingMetrics.setText("api-ms", "REST");
  TimingMetrics.setMs("client-ms", timing.elapsed());
  TimingMetrics.setCount("row-count", rows.length);
  TimingMetrics.updateSummary();
  RenderState.ready("ais", `${rows.length.toLocaleString()} 筆`);
  setStatus(`AIS REST 完成，可見船舶 ${rows.length.toLocaleString()} 艘，${bboxes.length} 個循環邊界框`);
}

async function reloadGfwRecords() {
  if (!state.datasetId || !state.datasets[state.datasetId]) {
    clearPrimaryLayerRecords();
    RenderState.off("gfw", "未導入");
    setStatus("尚未導入可查詢的 GFW 資料圖層");
    return;
  }
  // Drop stale responses after pan/zoom/date changes.
  const seq = ++state.fetchSeq;
  const timing = TimingMetrics.stopwatch();
  TimingMetrics.resetSnapshotPersistent?.({ render: false });
  RenderState.loading("gfw", "查詢中");
  setStatus("正在載入 GFW");
  const requestedLimit = Number(state.queryPolicy.max_limit || state.queryPolicy.default_limit || 100000);
  const requestedDate = $("date").value;
  const requestContext = {
    datasetId: state.datasetId,
    date: requestedDate,
    bbox: currentBbox(),
    limit: requestedLimit,
    columns: "render",
    center: map.getCenter(),
    zoom: map.getZoom(),
  };
  const dateChanged = state.renderedGfwDate && state.renderedGfwDate !== requestedDate;
  if (dateChanged) {
    fadeOutGfwLayer();
  }
  renderTable([], state.datasets[state.datasetId].display_columns, { layer: "gfw", date: requestedDate, loading: true });
  const { packet, cacheHit } = await GfwRecordCache.fetchPacket(requestContext);
  if (state.dataLayer !== "gfw") return;
  if (seq !== state.fetchSeq) {
    RenderState.loading("gfw", "重新整理");
    schedulePrimaryReload(80);
    return;
  }
  const renderResult = renderGfwMap(packet.rows);
  renderTable(packet.rows, state.datasets[state.datasetId].display_columns, { layer: "gfw", date: requestedDate });
  const serverCacheHit = Boolean(packet.timing?.cache_hit);
  if (cacheHit || serverCacheHit) {
    TimingMetrics.setText("query-ms", "快取命中");
    TimingMetrics.setText("serialize-ms", "快取命中");
    TimingMetrics.setMs("api-ms", timing.elapsed());
  } else {
    TimingMetrics.setMs("query-ms", packet.timing.query_ms);
    TimingMetrics.setMs("serialize-ms", packet.timing.serialize_ms);
    TimingMetrics.setMs("api-ms", packet.timing.api_total_ms);
  }
  TimingMetrics.setMs("client-ms", timing.elapsed());
  TimingMetrics.setCount("row-count", packet.row_count);
  TimingMetrics.updateSummary();
  const sourceDetail = cacheHit ? "瀏覽器快取" : serverCacheHit ? "伺服器快取" : "SQL";
  RenderState.ready(
    "gfw",
    `${Number(packet.row_count || 0).toLocaleString()} 筆，z${currentLodZoom()}，${sourceDetail}，${renderResult.detail}`
  );
  setStatus(`GFW 就緒，${requestedDate}，視窗最大量，z${currentLodZoom()}，${sourceDetail}，${renderResult.detail}`);
  GfwRecordCache.schedulePrewarm(requestContext);
}

function clearPrimaryLayerRecords() {
  clearTimeout(state.primaryReloadTimer);
  state.primaryReloadTimer = null;
  if (typeof GfwRecordCache !== "undefined") {
    GfwRecordCache.cancelPrewarm();
  }
  state.fetchSeq += 1;
  state.aisLiveSeq += 1;
  closeAisSocket();
  removeGfwLayer();
  removeAisLayer();
  RenderState.off("gfw", "關閉");
  RenderState.off("ais", "關閉");
  renderTable([], [], { layer: "none" });
  TimingMetrics.setText("query-ms", "-");
  TimingMetrics.setText("serialize-ms", "-");
  TimingMetrics.setText("api-ms", "-");
  TimingMetrics.setText("client-ms", "-");
  TimingMetrics.setCount("row-count", 0);
  TimingMetrics.updateSummary();
  setStatus($("eez-toggle").checked ? "主要資料圖層已關閉，僅顯示 EEZ" : "沒有啟用中的地圖圖層");
}

function reloadActiveLayer() {
  if (state.dataLayer === "ais") {
    return reloadAisRecords();
  }
  if (state.dataLayer === "gfw") {
    return reloadGfwRecords();
  }
  clearPrimaryLayerRecords();
  return Promise.resolve();
}
