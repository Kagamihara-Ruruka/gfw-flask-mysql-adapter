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
      { padding: [20, 20], maxZoom: 3 }
    );
  }
}

async function reloadAisRecords() {
  return startAisWebSocket();
}

async function loadAisSettings() {
  const packet = await fetchJson("/api/live/ais/settings");
  state.aisSettings = packet;
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
    TimingMetrics.setText("query-ms", "stream warmup");
    TimingMetrics.setText("serialize-ms", "-");
    TimingMetrics.setText("api-ms", "websocket");
    TimingMetrics.setMs("client-ms", timing.elapsed());
    TimingMetrics.setCount("row-count", 0);
    TimingMetrics.updateSummary();
    setStatus(packet.message || "AIS stream warming");
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
  const stream = packet.stream
    ? `, ${Number(packet.stream.accepted_messages || 0).toLocaleString()} source rows`
    : "";
  if (packet.transport === "aisstream_websocket" && packet.stream && Number(packet.stream.accepted_messages || 0) === 0) {
    const age = Number(packet.stream.age_seconds || 0).toFixed(1);
    setStatus(`AISStream connected, waiting for upstream frames (${age}s, 0 received)`, true);
    return;
  }
  if (packet.transport === "aishub_polling") {
    const interval = Number(packet.stream?.poll_interval_seconds || 180);
    setStatus(`AISHub polling, ${rows.length.toLocaleString()} vessels${stream}, ${interval}s interval`);
    return;
  }
  setStatus(`AIS websocket, ${rows.length.toLocaleString()} vessels${stream}, ${bboxes.length} wrapped bbox`);
}

function startAisWebSocket() {
  const seq = ++state.aisLiveSeq;
  const timing = TimingMetrics.stopwatch();
  const bboxes = currentWrappedBboxes();
  closeAisSocket();
  setStatus("opening AIS websocket");

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
      setStatus("AIS websocket connected");
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
        setStatus(err.message, true);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
    };
    socket.onerror = () => {
      setStatus("AIS websocket failed, falling back to REST", true);
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
  setStatus("loading AIS REST fallback");
  const bboxes = currentWrappedBboxes();
  const packets = await Promise.all(bboxes.map((bbox) => {
    const params = new URLSearchParams();
    params.set("bbox", bbox);
    return fetchJson(`/api/live/ais?${params}`);
  }));
  if (seq !== state.aisLiveSeq || state.dataLayer !== "ais") return;
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
  setStatus(`AIS REST ok, ${rows.length.toLocaleString()} vessels, ${bboxes.length} wrapped bbox`);
}

async function reloadGfwRecords() {
  // Drop stale responses after pan/zoom/date changes.
  const seq = ++state.fetchSeq;
  const timing = TimingMetrics.stopwatch();
  setStatus("loading GFW");
  const params = new URLSearchParams();
  const requestedLimit = Number(state.queryPolicy.max_limit || state.queryPolicy.default_limit || 100000);
  params.set("date", $("date").value);
  params.set("limit", String(requestedLimit));
  params.set("bbox", currentBbox());
  const packet = await fetchJson(`/api/datasets/${state.datasetId}/records?${params}`);
  if (seq !== state.fetchSeq || state.dataLayer !== "gfw") return;
  renderGfwMap(packet.rows);
  renderTable(packet.rows, state.datasets[state.datasetId].display_columns, { layer: "gfw", date: $("date").value });
  TimingMetrics.setMs("query-ms", packet.timing.query_ms);
  TimingMetrics.setMs("serialize-ms", packet.timing.serialize_ms);
  TimingMetrics.setMs("api-ms", packet.timing.api_total_ms);
  TimingMetrics.setMs("client-ms", timing.elapsed());
  TimingMetrics.setCount("row-count", packet.row_count);
  TimingMetrics.updateSummary();
  setStatus(`GFW ready, ${$("date").value}, viewport max`);
}

function clearPrimaryLayerRecords() {
  state.fetchSeq += 1;
  state.aisLiveSeq += 1;
  closeAisSocket();
  removeGfwLayer();
  removeAisLayer();
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
