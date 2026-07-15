const DEFAULT_SAMPLED_GRID_COLOR_STOPS = Object.freeze([
  Object.freeze({ position: 0, color: "#163b4a" }),
  Object.freeze({ position: 0.25, color: "#2d8296" }),
  Object.freeze({ position: 0.5, color: "#4dbb9b" }),
  Object.freeze({ position: 0.75, color: "#e2bd52" }),
  Object.freeze({ position: 1, color: "#d85a30" }),
]);

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

function normalizedHexColor(value, fallback = "#2d8296") {
  const channels = parseHexColor(value, parseHexColor(fallback, [45, 130, 150]));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeSampledGridColorStops(value, fallback = DEFAULT_SAMPLED_GRID_COLOR_STOPS) {
  const source = Array.isArray(value) && value.length >= 2 ? value : fallback;
  const stops = source
    .map((stop, index) => ({
      position: clampUnit(stop?.position ?? (index / Math.max(1, source.length - 1))),
      color: normalizedHexColor(stop?.color, fallback[Math.min(index, fallback.length - 1)]?.color),
    }))
    .sort((left, right) => left.position - right.position);
  if (stops[0].position > 0) {
    stops.unshift({ position: 0, color: stops[0].color });
  }
  if (stops[stops.length - 1].position < 1) {
    stops.push({ position: 1, color: stops[stops.length - 1].color });
  }
  return stops;
}

const SampledGridColorScale = (() => {
  function datasetIdForLayer(targetLayerId) {
    const id = String(targetLayerId || "").trim().toLowerCase();
    const match = Object.entries(state.datasets || {}).find(([, dataset]) => (
      String(dataset?.layer_id || "").trim().toLowerCase() === id
    ));
    return match?.[0] || state.datasetId;
  }

  function layerId(datasetId = state.datasetId) {
    const dataset = state.datasets?.[datasetId] || {};
    return String(state.dataLayer || dataset.layer_id || datasetId || "sampled-grid").trim().toLowerCase();
  }

  function contract(datasetId = state.datasetId) {
    return state.datasets?.[datasetId]?.sampled_grid?.visualization?.color_scale || {};
  }

  function normalizeMode(value) {
    return value === "nonzero_extent" || value === "positive_extent" ? "nonzero_extent" : "contract";
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function createProfile(targetLayerId, datasetId = state.datasetId) {
    const configured = contract(datasetId);
    const configuredDomain = configured.domain || {};
    const fallback = state.sampledGridPaint || {};
    return {
      layerId: targetLayerId,
      datasetId,
      mode: normalizeMode(configured.mode || fallback.scaleMode),
      colorStops: normalizeSampledGridColorStops(configured.stops, fallback.colorStops),
      maxValue: numberOrNull(configured.max_value ?? fallback.maxValue),
      fixedDomainMin: numberOrNull(configuredDomain.min),
      fixedDomainMax: numberOrNull(configuredDomain.max),
      observedMin: null,
      observedMax: null,
      observedNonzeroMin: null,
      observedNonzeroMax: null,
    };
  }

  function profile(targetLayerId = layerId(), datasetId = datasetIdForLayer(targetLayerId)) {
    state.sampledGridPaintProfiles = state.sampledGridPaintProfiles || {};
    const id = String(targetLayerId || layerId(datasetId)).trim().toLowerCase();
    const existing = state.sampledGridPaintProfiles[id];
    if (existing && existing.datasetId === datasetId) return existing;
    const created = createProfile(id, datasetId);
    state.sampledGridPaintProfiles[id] = created;
    return created;
  }

  function prepare(rows, targetProfile = profile()) {
    const model = SampledGridContract.model(targetProfile.datasetId);
    let minimum = null;
    let maximum = null;
    let nonzeroMinimum = null;
    let nonzeroMaximum = null;
    for (const row of rows || []) {
      const value = model.value(row);
      if (!Number.isFinite(value)) continue;
      minimum = minimum == null ? value : Math.min(minimum, value);
      maximum = maximum == null ? value : Math.max(maximum, value);
      if (value !== 0) {
        nonzeroMinimum = nonzeroMinimum == null ? value : Math.min(nonzeroMinimum, value);
        nonzeroMaximum = nonzeroMaximum == null ? value : Math.max(nonzeroMaximum, value);
      }
    }
    if (minimum == null || maximum == null) return targetProfile;
    targetProfile.observedMin = minimum;
    targetProfile.observedMax = maximum;
    if (nonzeroMinimum != null && nonzeroMaximum != null) {
      targetProfile.observedNonzeroMin = nonzeroMinimum;
      targetProfile.observedNonzeroMax = nonzeroMaximum;
    } else {
      targetProfile.observedNonzeroMin = null;
      targetProfile.observedNonzeroMax = null;
    }
    return targetProfile;
  }

  function domain(targetProfile = profile()) {
    const modelDomain = SampledGridContract.model(targetProfile.datasetId).valueDomain;
    let minimum;
    let maximum;
    if (targetProfile.mode === "nonzero_extent") {
      minimum = targetProfile.fixedDomainMin ?? targetProfile.observedNonzeroMin;
      maximum = targetProfile.fixedDomainMax ?? targetProfile.observedNonzeroMax;
    } else {
      minimum = targetProfile.fixedDomainMin ?? modelDomain.min ?? targetProfile.observedMin ?? 0;
      maximum = targetProfile.maxValue
        ?? targetProfile.fixedDomainMax
        ?? modelDomain.max
        ?? targetProfile.observedMax;
    }
    if (!Number.isFinite(minimum)) minimum = 0;
    if (!Number.isFinite(maximum) || maximum <= minimum) maximum = minimum + 1;
    return { min: minimum, max: maximum, mode: targetProfile.mode };
  }

  function interpolate(stops, ratio) {
    const position = clampUnit(ratio);
    let rightIndex = stops.findIndex((stop) => stop.position >= position);
    if (rightIndex <= 0) return parseHexColor(stops[0].color, [45, 130, 150]);
    if (rightIndex < 0) rightIndex = stops.length - 1;
    const left = stops[rightIndex - 1];
    const right = stops[rightIndex];
    const width = Math.max(Number.EPSILON, right.position - left.position);
    const localRatio = clampUnit((position - left.position) / width);
    const leftColor = parseHexColor(left.color, [45, 130, 150]);
    const rightColor = parseHexColor(right.color, leftColor);
    return leftColor.map((channel, index) => (
      Math.round(channel * (1 - localRatio) + rightColor[index] * localRatio)
    ));
  }

  function colorParts(row, targetProfile = profile()) {
    const model = SampledGridContract.model(targetProfile.datasetId);
    const value = model.value(row);
    const activeDomain = domain(targetProfile);
    const ratio = value == null || (activeDomain.mode === "nonzero_extent" && value === 0)
      ? 0
      : (value - activeDomain.min) / (activeDomain.max - activeDomain.min);
    return interpolate(targetProfile.colorStops, ratio);
  }

  function opacity(row, targetProfile = profile()) {
    const value = SampledGridContract.model(targetProfile.datasetId).value(row);
    const configured = contract(targetProfile.datasetId);
    const zeroOpacity = numberOrNull(configured.zero_opacity);
    if (value === 0) return zeroOpacity == null ? 0 : clampUnit(zeroOpacity);
    return 1;
  }

  return {
    defaults: DEFAULT_SAMPLED_GRID_COLOR_STOPS,
    normalizeStops: normalizeSampledGridColorStops,
    datasetIdForLayer,
    layerId,
    profile,
    prepare,
    domain,
    colorParts,
    opacity,
  };
})();

function sampledGridCellColorParts(row) {
  return SampledGridColorScale.colorParts(row);
}

function sampledGridCellColorCss(row) {
  const [red, green, blue] = sampledGridCellColorParts(row);
  return `rgb(${red},${green},${blue})`;
}

function sampledGridCellOpacity(row) {
  return SampledGridColorScale.opacity(row);
}

function sampledGridRowsForRender(rows) {
  const targetProfile = SampledGridColorScale.profile();
  const model = SampledGridContract.model(targetProfile.datasetId);
  const renderRows = (rows || []).filter((row) => (
    model.renderable(row) && SampledGridColorScale.opacity(row, targetProfile) > 0
  ));
  SampledGridColorScale.prepare(renderRows, targetProfile);
  return renderRows;
}

function gfwCellColorParts(row) {
  return sampledGridCellColorParts(row);
}

function gfwCellColorCss(row) {
  return sampledGridCellColorCss(row);
}

function aggregateGfwRowsForRender(rows) {
  return sampledGridRowsForRender(rows);
}

window.SampledGridColorScale = SampledGridColorScale;
