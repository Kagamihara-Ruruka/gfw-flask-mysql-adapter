const state = {
  datasets: {},
  datasetId: null,
  schema: null,
  layer: null,
  requestSeq: 0,
  reloadTimer: null,
  queryPolicy: { default_limit: 1000, max_limit: null, table_preview_limit: 300 },
};

const canvasRenderer = L.canvas({ padding: 0.5, tolerance: 6 });
const map = L.map("map", {
  worldCopyJump: true,
  minZoom: 2,
  renderer: canvasRenderer,
}).setView([23.7, 121], 6);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
  attribution: "OpenStreetMap, CARTO",
  subdomains: "abcd",
}).addTo(map);

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function ms(value) {
  if (value === undefined || value === null) return "-";
  return `${Number(value).toFixed(1)} ms`;
}

function cellColor(row) {
  const fish = Number(row.fish_sum ?? 0);
  const ratio = Math.min(1, Math.max(0, fish / 40));
  const red = Math.round(216 * ratio + 45 * (1 - ratio));
  const green = Math.round(90 * ratio + 130 * (1 - ratio));
  const blue = Math.round(48 * ratio + 150 * (1 - ratio));
  return `rgb(${red},${green},${blue})`;
}

function mapBbox() {
  const bounds = map.getBounds();
  const west = Math.max(-180, bounds.getWest());
  const south = Math.max(-90, bounds.getSouth());
  const east = Math.min(180, bounds.getEast());
  const north = Math.min(90, bounds.getNorth());
  return [west, south, east, north].map((value) => value.toFixed(6)).join(",");
}

function renderMap(rows) {
  map.invalidateSize();
  if (state.layer) {
    map.removeLayer(state.layer);
  }

  const group = L.layerGroup();
  const enableTooltips = rows.length <= 8000;
  for (const row of rows) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const half = 0.0833334 / 2;
    const color = cellColor(row);
    const rect = L.rectangle(
      [[lat - half, lon - half], [lat + half, lon + half]],
      {
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.55,
        renderer: canvasRenderer,
        interactive: enableTooltips,
      }
    );
    if (enableTooltips) {
      rect.bindTooltip(
        [
          `date: ${row.obs_date}`,
          `grid: ${row.grid_id ?? "LOD"}`,
          `fish avg: ${row.fish_sum}`,
          `vessels: ${row.vessels}`,
          row.source_rows ? `source rows: ${row.source_rows}` : null,
          row.sample_cell_size ? `sample bucket: ${row.sample_cell_size} deg` : null,
          `flag: ${row.dominant_flag ?? ""}`,
          `gear: ${row.dominant_gear ?? ""}`,
        ].filter(Boolean).join("<br>")
      );
    }
    rect.addTo(group);
  }
  state.layer = group.addTo(map);
}

function renderTable(rows) {
  const extraColumns = rows.some((row) => row.source_rows !== undefined)
    ? ["source_rows", "sample_cell_size"]
    : [];
  const columns = [...state.datasets[state.datasetId].display_columns, ...extraColumns];
  const previewLimit = state.queryPolicy.table_preview_limit ?? 300;

  $("records").querySelector("thead").innerHTML = `<tr>${columns
    .map((column) => `<th>${column}</th>`)
    .join("")}</tr>`;
  $("records").querySelector("tbody").innerHTML = rows
    .slice(0, previewLimit)
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => `<td>${row[column] ?? ""}</td>`)
          .join("")}</tr>`
    )
    .join("");
  $("table-note").textContent = `${Math.min(rows.length, previewLimit)} displayed`;
}

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
  state.queryPolicy = packet.query_policy || state.queryPolicy;
  $("limit").value = state.queryPolicy.default_limit ?? 1000;
  if (state.queryPolicy.max_limit === null || state.queryPolicy.max_limit === undefined) {
    $("limit").removeAttribute("max");
  } else {
    $("limit").max = state.queryPolicy.max_limit;
  }

  const select = $("dataset");
  select.innerHTML = Object.entries(state.datasets)
    .map(([id, dataset]) => `<option value="${id}">${dataset.label}</option>`)
    .join("");
  state.datasetId = select.value;
}

async function loadSchema() {
  const packet = await fetchJson(`/api/datasets/${state.datasetId}/schema`);
  state.schema = packet;
  $("date").innerHTML = packet.dates
    .map((date) => `<option value="${date}">${date}</option>`)
    .join("");
}

async function reloadRecords() {
  if (!state.datasetId || !$("date").value) return;

  const started = performance.now();
  const seq = ++state.requestSeq;
  setStatus("loading");

  const params = new URLSearchParams();
  params.set("date", $("date").value);
  params.set("bbox", mapBbox());
  params.set("zoom", Math.round(map.getZoom()));
  params.set("lod", "1");

  try {
    const packet = await fetchJson(`/api/datasets/${state.datasetId}/records?${params}`);
    if (seq !== state.requestSeq) return;

    renderMap(packet.rows);
    renderTable(packet.rows);
    const clientTotal = performance.now() - started;
    $("query-ms").textContent = ms(packet.timing.query_ms);
    $("serialize-ms").textContent = ms(packet.timing.serialize_ms);
    $("api-ms").textContent = ms(packet.timing.api_total_ms);
    $("client-ms").textContent = ms(clientTotal);
    $("row-count").textContent = packet.row_count.toLocaleString();
    setStatus(packet.lod?.enabled ? `ready: sample ${packet.lod.sample_cell_size} deg` : "ready: 1:1");
  } catch (err) {
    if (seq !== state.requestSeq) return;
    console.error(err);
    setStatus(err.message, true);
  }
}

function scheduleReload() {
  window.clearTimeout(state.reloadTimer);
  state.reloadTimer = window.setTimeout(reloadRecords, 180);
}

async function init() {
  try {
    await loadDatasets();
    await loadSchema();
    await reloadRecords();
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

$("dataset").addEventListener("change", async (event) => {
  state.datasetId = event.target.value;
  await loadSchema();
  await reloadRecords();
});
$("date").addEventListener("change", reloadRecords);
$("reload").addEventListener("click", reloadRecords);
map.on("moveend", scheduleReload);

init();
