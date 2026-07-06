const DEFAULT_GFW_LOW_COLOR = [45, 130, 150];
const DEFAULT_GFW_HIGH_COLOR = [216, 90, 48];

function parseHexColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) return fallback;
  const hex = match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function gfwCellColorParts(row) {
  const paint = state.gfwPaint || {};
  const low = parseHexColor(paint.lowColor, DEFAULT_GFW_LOW_COLOR);
  const high = parseHexColor(paint.highColor, DEFAULT_GFW_HIGH_COLOR);
  const maxFish = Math.max(1, Number(paint.maxFish || 40));
  const fish = Number(row.fish_sum ?? 0);
  const ratio = Math.min(1, Math.max(0, fish / maxFish));
  const red = Math.round(high[0] * ratio + low[0] * (1 - ratio));
  const green = Math.round(high[1] * ratio + low[1] * (1 - ratio));
  const blue = Math.round(high[2] * ratio + low[2] * (1 - ratio));
  return [red, green, blue];
}

function gfwCellColorCss(row) {
  const [red, green, blue] = gfwCellColorParts(row);
  return `rgb(${red},${green},${blue})`;
}

function aggregateGfwRowsForRender(rows) {
  const buckets = new Map();
  for (const row of rows || []) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const latCenter = gfwRenderCellCenter(lat);
    const lonCenter = gfwRenderCellCenter(normalizeLongitude(lon));
    const key = `${latCenter.toFixed(6)}:${lonCenter.toFixed(6)}`;
    const fish = Number(row.fish_sum ?? 0);
    const previous = buckets.get(key);
    if (previous) {
      previous.fish_sum += Number.isFinite(fish) ? fish : 0;
      previous.source_rows += 1;
      continue;
    }
    buckets.set(key, {
      ...row,
      lat: latCenter,
      lon: lonCenter,
      fish_sum: Number.isFinite(fish) ? fish : 0,
      source_rows: 1,
      render_cell_km: gfwRenderCellKm(),
    });
  }
  return [...buckets.values()];
}
