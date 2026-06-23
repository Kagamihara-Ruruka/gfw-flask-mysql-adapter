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
  const seq = ++state.aisLiveSeq;
  const timing = TimingMetrics.stopwatch();
  setStatus("loading AIS");
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
  TimingMetrics.setText("api-ms", "-");
  TimingMetrics.setMs("client-ms", timing.elapsed());
  TimingMetrics.setCount("row-count", rows.length);
  TimingMetrics.updateSummary();
  setStatus(`AIS ok, ${rows.length.toLocaleString()} vessels, ${bboxes.length} wrapped bbox`);
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
