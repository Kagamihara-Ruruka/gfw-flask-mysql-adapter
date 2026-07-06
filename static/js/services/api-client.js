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
  state.datasets = packet.datasets;
  // Keep frontend limits aligned with the Flask adapter config.
  state.queryPolicy = packet.query_policy || state.queryPolicy;
  state.datasetId = Object.keys(state.datasets)[0];
  updateDataLayerMenu();
}

async function loadSchema() {
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
    RenderState.loading("ais", "warming");
    TimingMetrics.setText("query-ms", "stream warmup");
    TimingMetrics.setText("serialize-ms", "-");
    TimingMetrics.setText("api-ms", "websocket");
    TimingMetrics.setMs("client-ms", timing.elapsed());
    TimingMetrics.setCount("row-count", 0);
    TimingMetrics.updateSummary();
    setStatus(packet.message || "AIS stream warming");
    return;
  }
  if (packet.status === "locked") {
    const gate = packet.key_gate || packet.ingest?.key_gate || {};
    removeAisLayer();
    renderTable([], AIS_COLUMNS, { layer: "ais", wrappedBboxCount: bboxes.length });
    TimingMetrics.setText("query-ms", "-");
    TimingMetrics.setText("serialize-ms", "-");
    TimingMetrics.setText("api-ms", "locked");
    TimingMetrics.setMs("client-ms", timing.elapsed());
    TimingMetrics.setCount("row-count", 0);
    TimingMetrics.updateSummary();
    RenderState.error("ais", "key gate locked");
    setStatus(gate.message || packet.message || "AIS SQL read is locked by collector key gate.", true);
    return;
  }
  if (packet.status !== "ok") {
    throw new Error(packet.error || packet.message || "AIS live source failed");
  }
  const rows = packet.rows || [];
  renderAisMap(rows);
  renderTable(rows, AIS_COLUMNS, { layer: "ais", wrappedBboxCount: bboxes.length });
  TimingMetrics.setText("query-ms", `${Number(packet.timing?.query_ms || 0).toFixed(3)} ms`);
  TimingMetrics.setText("serialize-ms", "-");
  TimingMetrics.setText("api-ms", "websocket");
  TimingMetrics.setMs("client-ms", timing.elapsed());
  TimingMetrics.setCount("row-count", rows.length);
  TimingMetrics.updateSummary();
  RenderState.ready("ais", `${rows.length.toLocaleString()} rows`);
  const stream = packet.stream
    ? `, ${Number(packet.stream.accepted_messages || 0).toLocaleString()} source rows`
    : "";
  if (packet.transport === "sql_ingest_websocket") {
    const ingest = packet.ingest || {};
    const ingestState = ingest.connected ? "ingesting" : ingest.running ? "warming" : "idle";
    const accepted = Number(ingest.accepted_messages || 0).toLocaleString();
    const written = Number(ingest.written_rows || 0).toLocaleString();
    const skipped = Number(ingest.skipped_stale_rows || 0).toLocaleString();
    const store = ingest.store || {};
    const storeCount = Number(store.vessel_count || rows.length || 0).toLocaleString();
    const storeSuffix = store.status === "ok" ? `, SQL store ${storeCount}` : "";
    setStatus(
      `AIS SQL ingest ${ingestState}, ${rows.length.toLocaleString()} visible vessels${storeSuffix}, ${accepted} accepted, ${written} upserted, ${skipped} stale skipped`
    );
    return;
  }
  if (packet.transport === "aishub_polling") {
    const interval = Number(packet.stream?.poll_interval_seconds || 180);
    setStatus(`AISHub polling, ${rows.length.toLocaleString()} vessels${stream}, ${interval}s interval`);
    return;
  }
  setStatus(`AIS local SQL stream, ${rows.length.toLocaleString()} vessels${stream}, ${bboxes.length} wrapped bbox`);
}

function startAisWebSocket() {
  const seq = ++state.aisLiveSeq;
  const timing = TimingMetrics.stopwatch();
  const bboxes = currentWrappedBboxes();
  closeAisSocket();
  RenderState.loading("ais", "connecting");
  setStatus("opening local AIS SQL stream");

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
      setStatus("AIS SQL stream connected");
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
        RenderState.error("ais", "packet failed");
        setStatus(err.message, true);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
    };
    socket.onerror = () => {
      RenderState.loading("ais", "fallback");
      setStatus("AIS local stream failed, falling back to REST", true);
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
  RenderState.loading("ais", "REST");
  setStatus("loading AIS REST fallback");
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
    throw new Error(failed.error || failed.message || "AIS REST fallback failed");
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
  RenderState.ready("ais", `${rows.length.toLocaleString()} rows`);
  setStatus(`AIS REST ok, ${rows.length.toLocaleString()} vessels, ${bboxes.length} wrapped bbox`);
}

async function reloadGfwRecords() {
  // Drop stale responses after pan/zoom/date changes.
  const seq = ++state.fetchSeq;
  const timing = TimingMetrics.stopwatch();
  RenderState.loading("gfw", "querying");
  setStatus("loading GFW");
  const requestedLimit = Number(state.queryPolicy.max_limit || state.queryPolicy.default_limit || 100000);
  const requestedDate = $("date").value;
  const requestContext = {
    datasetId: state.datasetId,
    date: requestedDate,
    bbox: currentBbox(),
    limit: requestedLimit,
    center: map.getCenter(),
    zoom: map.getZoom(),
  };
  if (state.renderedGfwDate && state.renderedGfwDate !== requestedDate) {
    removeGfwLayer();
  }
  renderTable([], state.datasets[state.datasetId].display_columns, { layer: "gfw", date: requestedDate, loading: true });
  const { packet, cacheHit } = await GfwRecordCache.fetchPacket(requestContext);
  if (state.dataLayer !== "gfw") return;
  if (seq !== state.fetchSeq) {
    RenderState.loading("gfw", "refreshing");
    schedulePrimaryReload(80);
    return;
  }
  const renderResult = renderGfwMap(packet.rows);
  renderTable(packet.rows, state.datasets[state.datasetId].display_columns, { layer: "gfw", date: requestedDate });
  if (cacheHit) {
    TimingMetrics.setText("query-ms", "cache hit");
    TimingMetrics.setText("serialize-ms", "cache hit");
    TimingMetrics.setMs("api-ms", timing.elapsed());
  } else {
    TimingMetrics.setMs("query-ms", packet.timing.query_ms);
    TimingMetrics.setMs("serialize-ms", packet.timing.serialize_ms);
    TimingMetrics.setMs("api-ms", packet.timing.api_total_ms);
  }
  TimingMetrics.setMs("client-ms", timing.elapsed());
  TimingMetrics.setCount("row-count", packet.row_count);
  TimingMetrics.updateSummary();
  const sourceDetail = cacheHit ? "cache hit" : "SQL";
  RenderState.ready(
    "gfw",
    `${Number(packet.row_count || 0).toLocaleString()} rows, z${currentLodZoom()}, ${sourceDetail}, ${renderResult.detail}`
  );
  setStatus(`GFW ready, ${requestedDate}, viewport max, z${currentLodZoom()}, ${sourceDetail}, ${renderResult.detail}`);
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
  RenderState.off("gfw", "off");
  RenderState.off("ais", "off");
  renderTable([], [], { layer: "none" });
  TimingMetrics.setText("query-ms", "-");
  TimingMetrics.setText("serialize-ms", "-");
  TimingMetrics.setText("api-ms", "-");
  TimingMetrics.setText("client-ms", "-");
  TimingMetrics.setCount("row-count", 0);
  TimingMetrics.updateSummary();
  setStatus($("eez-toggle").checked ? "primary layer off, EEZ only" : "no active map layer");
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
