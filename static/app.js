const state = {
  datasets: {},
  datasetId: null,
  schema: null,
  layer: null,
  queryPolicy: { default_limit: 1000, max_limit: 5000, table_preview_limit: 300 },
};

const map = L.map("map", { worldCopyJump: true, minZoom: 2 }).setView([18, 122], 3);
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

function renderMap(rows) {
  // Leaflet 在動態容器中需要刷新尺寸，否則 fitBounds 可能看似沒有生效。
  map.invalidateSize();
  if (state.layer) {
    map.removeLayer(state.layer);
  }
  const group = L.layerGroup();
  for (const row of rows) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const half = 0.0416667;
    const rect = L.rectangle(
      [[lat - half, lon - half], [lat + half, lon + half]],
      {
        color: cellColor(row),
        weight: 1,
        fillColor: cellColor(row),
        fillOpacity: 0.55,
      }
    );
    rect.bindTooltip(
      [
        `date: ${row.obs_date}`,
        `grid: ${row.grid_id}`,
        `fish: ${row.fish_sum}`,
        `vessels: ${row.vessels}`,
        `flag: ${row.dominant_flag ?? ""}`,
        `gear: ${row.dominant_gear ?? ""}`,
      ].join("<br>")
    );
    rect.addTo(group);
  }
  state.layer = group.addTo(map);
  if (rows.length) {
    const latLngs = rows
      .map((row) => [Number(row.lat), Number(row.lon)])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    if (latLngs.length) {
      map.fitBounds(L.latLngBounds(latLngs), { padding: [24, 24], maxZoom: 5 });
    }
  }
}

function renderTable(rows) {
  const columns = state.datasets[state.datasetId].display_columns;
  // 表格只預覽部分 rows；完整 rows 仍交給地圖渲染，避免 DOM 節點過多拖慢瀏覽器。
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
  // 從 Flask adapter 讀容量政策；前端不自己決定 5000/300 這類管線邊界。
  state.queryPolicy = packet.query_policy || state.queryPolicy;
  $("limit").value = state.queryPolicy.default_limit ?? 1000;
  $("limit").max = state.queryPolicy.max_limit ?? 5000;
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
  // 驗收口徑：從前端送出請求開始，到資料回來且地圖/表格更新完成為止。
  const started = performance.now();
  setStatus("loading");
  const params = new URLSearchParams();
  params.set("date", $("date").value);
  params.set("limit", $("limit").value);
  const packet = await fetchJson(`/api/datasets/${state.datasetId}/records?${params}`);
  renderMap(packet.rows);
  renderTable(packet.rows);
  const clientTotal = performance.now() - started;
  $("query-ms").textContent = ms(packet.timing.query_ms);
  $("serialize-ms").textContent = ms(packet.timing.serialize_ms);
  $("api-ms").textContent = ms(packet.timing.api_total_ms);
  $("client-ms").textContent = ms(clientTotal);
  $("row-count").textContent = packet.row_count.toLocaleString();
  setStatus("ready");
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

init();
