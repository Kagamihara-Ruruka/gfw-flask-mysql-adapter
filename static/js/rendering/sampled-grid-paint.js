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

  function normalizedMaximum(value, datasetId) {
    const maximum = numberOrNull(value);
    if (maximum == null) return null;
    const minimum = SampledGridContract.model(datasetId).valueDomain.min;
    return Number.isFinite(minimum) && maximum <= minimum ? null : maximum;
  }

  function createProfile(targetLayerId, datasetId = state.datasetId) {
    const configured = contract(datasetId);
    const configuredDomain = configured.domain || {};
    const fallback = state.sampledGridPaint || {};
    const interpolation = window.LayerRuntimeContractRegistry?.spatialInterpolation?.(targetLayerId) || {};
    return {
      layerId: targetLayerId,
      datasetId,
      mode: normalizeMode(configured.mode || fallback.scaleMode),
      colorStops: normalizeSampledGridColorStops(configured.stops, fallback.colorStops),
      maxValue: normalizedMaximum(configured.max_value ?? fallback.maxValue, datasetId),
      spatialInterpolation: interpolation.default_method === "linear" ? "linear" : "nearest",
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
    if (existing && existing.datasetId === datasetId) {
      existing.spatialInterpolation = existing.spatialInterpolation === "nearest" ? "nearest" : "linear";
      existing.colorStops = normalizeSampledGridColorStops(existing.colorStops);
      existing.maxValue = normalizedMaximum(existing.maxValue, datasetId);
      return existing;
    }
    const created = createProfile(id, datasetId);
    state.sampledGridPaintProfiles[id] = created;
    return created;
  }

  function domain(targetProfile = profile(), targetModel = null) {
    const modelDomain = (targetModel || SampledGridContract.model(targetProfile.datasetId)).valueDomain;
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

  function compileStops(stops) {
    return stops.map((stop) => ({
      position: stop.position,
      channels: parseHexColor(stop.color, [45, 130, 150]),
    }));
  }

  function interpolateCompiled(stops, ratio, target = [0, 0, 0]) {
    const position = clampUnit(ratio);
    let rightIndex = stops.findIndex((stop) => stop.position >= position);
    if (rightIndex <= 0) {
      target[0] = stops[0].channels[0];
      target[1] = stops[0].channels[1];
      target[2] = stops[0].channels[2];
      return target;
    }
    if (rightIndex < 0) rightIndex = stops.length - 1;
    const left = stops[rightIndex - 1];
    const right = stops[rightIndex];
    const width = Math.max(Number.EPSILON, right.position - left.position);
    const localRatio = clampUnit((position - left.position) / width);
    for (let index = 0; index < 3; index += 1) {
      target[index] = Math.round(
        left.channels[index] * (1 - localRatio) + right.channels[index] * localRatio,
      );
    }
    return target;
  }

  function interpolate(stops, ratio) {
    return interpolateCompiled(compileStops(stops), ratio);
  }

  function zeroOpacity(targetProfile) {
    const configured = contract(targetProfile.datasetId);
    const configuredOpacity = numberOrNull(configured.zero_opacity);
    return configuredOpacity == null ? 0 : clampUnit(configuredOpacity);
  }

  function opacityForValue(value, configuredZeroOpacity) {
    return value === 0 ? configuredZeroOpacity : 1;
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
    return opacityForValue(value, zeroOpacity(targetProfile));
  }

  function frame(canonicalFrame, targetProfile = profile()) {
    if (!CanonicalGridFrame.isFrame(canonicalFrame)) {
      throw new TypeError("Sampled-grid paint requires CanonicalGridFrame");
    }
    const model = SampledGridContract.model(targetProfile.datasetId);
    const configuredZeroOpacity = zeroOpacity(targetProfile);
    const validIndices = [];
    const renderIndices = [];
    let minimum = null;
    let maximum = null;
    let nonzeroMinimum = null;
    let nonzeroMaximum = null;
    const boundsScratch = {};
    for (let index = 0; index < canonicalFrame.rowCount; index += 1) {
      const bounds = canonicalFrame.boundsAt(index, boundsScratch);
      const rawValue = canonicalFrame.valueAt("value", index);
      const value = rawValue === null || rawValue === undefined || rawValue === "" ? null : Number(rawValue);
      const status = String(canonicalFrame.valueAt("data_status", index) || "").trim().toLowerCase();
      if (!model.renderableValues({ bounds, value, dataStatus: status })) continue;
      if (value === 0 && !model.zeroIsData) continue;
      validIndices.push(index);
      minimum = minimum == null ? value : Math.min(minimum, value);
      maximum = maximum == null ? value : Math.max(maximum, value);
      if (value !== 0) {
        nonzeroMinimum = nonzeroMinimum == null ? value : Math.min(nonzeroMinimum, value);
        nonzeroMaximum = nonzeroMaximum == null ? value : Math.max(nonzeroMaximum, value);
      }
      if (opacityForValue(value, configuredZeroOpacity) <= 0) continue;
      renderIndices.push(index);
    }
    if (minimum != null && maximum != null) {
      targetProfile.observedMin = minimum;
      targetProfile.observedMax = maximum;
      targetProfile.observedNonzeroMin = nonzeroMinimum;
      targetProfile.observedNonzeroMax = nonzeroMaximum;
    }
    const activeDomain = domain(targetProfile, model);
    const compiledStops = compileStops(targetProfile.colorStops);
    const colorPartsForValue = (value, target = [0, 0, 0]) => {
      const ratio = value == null || (activeDomain.mode === "nonzero_extent" && value === 0)
        ? 0
        : (value - activeDomain.min) / (activeDomain.max - activeDomain.min);
      return interpolateCompiled(compiledStops, ratio, target);
    };
    return {
      frame: canonicalFrame,
      validIndices,
      indices: renderIndices,
      model,
      domain: activeDomain,
      zeroOpacity: configuredZeroOpacity,
      compiledStops,
      opacityForValue: (value) => opacityForValue(value, configuredZeroOpacity),
      colorPartsForValue,
      colorCssForValue(value) {
        const [red, green, blue] = colorPartsForValue(value);
        return `rgb(${red},${green},${blue})`;
      },
    };
  }

  function spatialInterpolationMethod(targetProfile = profile()) {
    const capability = window.LayerRuntimeContractRegistry?.spatialInterpolation?.(targetProfile.layerId) || {};
    const methods = Array.isArray(capability.methods) ? capability.methods : [];
    if (capability.status !== "supported" || !methods.includes("linear")) return "nearest";
    return targetProfile.spatialInterpolation === "nearest" ? "nearest" : "linear";
  }

  function spatialSurface(canonicalFrame, paintFrame = frame(canonicalFrame), validityMask = null) {
    if (!CanonicalGridFrame.isFrame(canonicalFrame)) {
      throw new TypeError("Sampled-grid spatial surface requires CanonicalGridFrame");
    }
    const cornerIds = new Map();
    const cornerSums = [];
    const cornerCounts = [];
    const landSegmentSampleRatios = [0.25, 0.5, 0.75];
    const capacity = paintFrame.validIndices.length;
    const indices = new Uint32Array(capacity);
    const cellCorners = new Uint32Array(capacity * 4);
    const boundsScratch = {};
    const keyFor = (longitude, latitude) => `${Number(longitude).toFixed(10)}:${Number(latitude).toFixed(10)}`;
    const cornerIdFor = (key, value) => {
      let cornerId = cornerIds.get(key);
      if (cornerId === undefined) {
        cornerId = cornerSums.length;
        cornerIds.set(key, cornerId);
        cornerSums.push(0);
        cornerCounts.push(0);
      }
      cornerSums[cornerId] += value;
      cornerCounts[cornerId] += 1;
      return cornerId;
    };
    const segmentTouchesLand = (centerLongitude, centerLatitude, cornerLongitude, cornerLatitude) => {
      if (!validityMask?.ready || typeof validityMask.sampleLand !== "function") return false;
      if (typeof validityMask.sampleSegmentLand === "function") {
        return validityMask.sampleSegmentLand(
          centerLongitude,
          centerLatitude,
          cornerLongitude,
          cornerLatitude,
        ) === true;
      }
      for (const ratio of landSegmentSampleRatios) {
        const longitude = centerLongitude * (1 - ratio) + cornerLongitude * ratio;
        const latitude = centerLatitude * (1 - ratio) + cornerLatitude * ratio;
        if (validityMask.sampleLand(longitude, latitude) === true) return true;
      }
      return false;
    };
    let count = 0;
    for (const index of paintFrame.validIndices) {
      const bounds = canonicalFrame.boundsAt(index, boundsScratch);
      const value = Number(canonicalFrame.valueAt("value", index));
      if (!bounds || !Number.isFinite(value)) continue;
      const centerLongitude = (bounds.west + bounds.east) / 2;
      const centerLatitude = (bounds.south + bounds.north) / 2;
      const corners = [
        [bounds.west, bounds.north],
        [bounds.east, bounds.north],
        [bounds.west, bounds.south],
        [bounds.east, bounds.south],
      ];
      const offset = count * 4;
      indices[count] = index;
      for (let cornerOffset = 0; cornerOffset < 4; cornerOffset += 1) {
        const [cornerLongitude, cornerLatitude] = corners[cornerOffset];
        const key = segmentTouchesLand(
          centerLongitude,
          centerLatitude,
          cornerLongitude,
          cornerLatitude,
        )
          ? `land:${index}:${cornerOffset}`
          : keyFor(cornerLongitude, cornerLatitude);
        cellCorners[offset + cornerOffset] = cornerIdFor(key, value);
      }
      count += 1;
    }
    const values = new Float32Array(count * 4);
    for (let cellIndex = 0; cellIndex < count; cellIndex += 1) {
      const offset = cellIndex * 4;
      for (let cornerOffset = 0; cornerOffset < 4; cornerOffset += 1) {
        const cornerId = cellCorners[offset + cornerOffset];
        values[offset + cornerOffset] = cornerSums[cornerId] / cornerCounts[cornerId];
      }
    }
    return Object.freeze({ count, indices: indices.subarray(0, count), values });
  }

  return {
    defaults: DEFAULT_SAMPLED_GRID_COLOR_STOPS,
    normalizeStops: normalizeSampledGridColorStops,
    datasetIdForLayer,
    layerId,
    profile,
    domain,
    colorParts,
    opacity,
    frame,
    spatialInterpolationMethod,
    spatialSurface,
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

function sampledGridPaintFrame(frame) {
  return SampledGridColorScale.frame(frame);
}

function reconstructContinuousField(frame, paintFrame, validityMask = null) {
  return SampledGridColorScale.spatialSurface(frame, paintFrame, validityMask);
}

function immutableRenderGridProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  return Object.freeze({
    ...profile,
    participants: Object.freeze((profile.participants || []).map((item) => Object.freeze({ ...item }))),
    baseGeometry: profile.baseGeometry ? Object.freeze({ ...profile.baseGeometry }) : null,
    geometry: profile.geometry ? Object.freeze({ ...profile.geometry }) : null,
  });
}

function createSampledGridRenderContext(canonicalFrame, {
  layerId = state.dataLayer,
  datasetId = null,
  alpha = null,
  renderGridProfile = state.renderGridProfile,
  requestContext = null,
  frameIdentity = typeof FrameIdentity !== "undefined" ? FrameIdentity : null,
  validityMask = null,
  renderEpoch = 0,
} = {}) {
  if (!CanonicalGridFrame.isFrame(canonicalFrame)) {
    throw new TypeError("Sampled-grid RenderContext requires CanonicalGridFrame");
  }
  if (canonicalFrame.rowCount > 0 && (!requestContext || !frameIdentity)) {
    throw new TypeError("Non-empty sampled-grid RenderContext requires request identity");
  }
  const resolvedLayerId = String(layerId || "sampled-grid").trim().toLowerCase();
  const resolvedDatasetId = String(
    datasetId || SampledGridColorScale.datasetIdForLayer(resolvedLayerId) || state.datasetId || "",
  ).trim();
  const requestedLayerId = String(requestContext?.layerId || "").trim().toLowerCase();
  const requestedDatasetId = String(
    requestContext?.datasetId || requestContext?.dataset_id || "",
  ).trim();
  if (requestedLayerId && requestedLayerId !== resolvedLayerId) {
    throw new Error("Sampled-grid RenderContext layer identity mismatch");
  }
  if (requestedDatasetId && requestedDatasetId !== resolvedDatasetId) {
    throw new Error("Sampled-grid RenderContext dataset identity mismatch");
  }
  const normalizedRequest = requestContext && frameIdentity
    ? frameIdentity.normalizeRequest({
      ...requestContext,
      layerId: resolvedLayerId,
      datasetId: resolvedDatasetId,
    })
    : null;
  const immutableRequest = normalizedRequest ? Object.freeze({ ...normalizedRequest }) : null;
  if (canonicalFrame.rowCount > 0 && (!immutableRequest?.date || !immutableRequest?.bbox)) {
    throw new TypeError("Non-empty sampled-grid RenderContext requires date and bbox identity");
  }
  const scopeKey = immutableRequest ? frameIdentity.scopeKey(immutableRequest) : "";
  const frameKey = immutableRequest
    ? frameIdentity.frameKey(immutableRequest, { frame: canonicalFrame })
    : "";
  const paintProfile = SampledGridColorScale.profile(resolvedLayerId, resolvedDatasetId);
  const paintFrame = Object.freeze(SampledGridColorScale.frame(canonicalFrame, paintProfile));
  const profile = immutableRenderGridProfile(renderGridProfile);
  const interpolation = SampledGridColorScale.spatialInterpolationMethod(paintProfile);
  const resolvedAlpha = Math.max(0, Math.min(1, Number(
    alpha ?? state.layerAlpha?.[resolvedLayerId] ?? state.sampledGridPaint?.alpha ?? 1,
  )));
  const smoothInterpolation = interpolation === "linear"
    && Number(profile?.aggregationFactor || 1) <= 1;
  const maskRequired = Boolean(validityMask?.enabled);
  const maskReady = !maskRequired || Boolean(
    validityMask?.ready
    && validityMask?.canvas
    && validityMask?.scopeSignature,
  );
  const maskSnapshot = maskReady && maskRequired ? validityMask : null;
  const resolvedRenderEpoch = Math.max(0, Math.floor(Number(renderEpoch) || 0));
  const continuousFieldSignature = JSON.stringify({
    layerId: resolvedLayerId,
    datasetId: resolvedDatasetId,
    spatialInterpolation: interpolation,
    zeroIsData: paintFrame.model?.zeroIsData !== false,
  });
  return Object.freeze({
    schema: "rrkal.sampled_grid_render_context.v2",
    layerId: resolvedLayerId,
    datasetId: resolvedDatasetId,
    date: immutableRequest?.date || "",
    bbox: immutableRequest?.bbox || "",
    scopeKey,
    frameKey,
    requestContext: immutableRequest,
    alpha: resolvedAlpha,
    paintFrame,
    renderGridProfile: profile,
    spatialInterpolation: interpolation,
    smoothInterpolation,
    continuousFieldSignature,
    renderEpoch: resolvedRenderEpoch,
    maskRequired,
    maskReady,
    maskId: maskSnapshot?.maskId || "",
    maskVersion: maskSnapshot?.maskVersion || "",
    maskRevision: Number(maskSnapshot?.revision || 0),
    maskScopeSignature: maskSnapshot?.scopeSignature || "",
    validityMask: maskSnapshot,
    signature: JSON.stringify({
      layerId: resolvedLayerId,
      datasetId: resolvedDatasetId,
      frameKey,
      alpha: resolvedAlpha,
      renderGridProfile: profile?.signature || null,
      spatialInterpolation: interpolation,
      renderEpoch: resolvedRenderEpoch,
      maskId: maskSnapshot?.maskId || "",
      maskVersion: maskSnapshot?.maskVersion || "",
      maskRevision: Number(maskSnapshot?.revision || 0),
      maskScopeSignature: maskSnapshot?.scopeSignature || "",
    }),
  });
}

function isSampledGridRenderContext(value) {
  return value?.schema === "rrkal.sampled_grid_render_context.v2"
    && value.paintFrame
    && typeof value.layerId === "string"
    && typeof value.scopeKey === "string"
    && typeof value.frameKey === "string"
    && Number.isInteger(value.renderEpoch)
    && typeof value.maskRequired === "boolean"
    && typeof value.maskReady === "boolean";
}

function sampledGridRenderContextMatchesMask(context, currentMask) {
  if (!isSampledGridRenderContext(context)) return false;
  if (!context.maskRequired) return true;
  return Boolean(
    context.maskReady
    && currentMask?.ready
    && context.maskId === currentMask.maskId
    && context.maskVersion === currentMask.maskVersion
    && context.maskRevision === Number(currentMask.revision || 0)
    && context.maskScopeSignature === currentMask.scopeSignature
  );
}

function sampledGridHitCellAt(targetMap, frame, containerPoint) {
  if (!targetMap || !containerPoint) return null;
  if (!CanonicalGridFrame.isFrame(frame)) return null;
  const latLng = targetMap.containerPointToLatLng(L.point(containerPoint));
  const latitude = Number(latLng?.lat);
  const longitude = normalizeLongitude(Number(latLng?.lng));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const boundsScratch = {};
  for (let index = frame.rowCount - 1; index >= 0; index -= 1) {
    const bounds = frame.boundsAt(index, boundsScratch);
    if (!bounds || latitude < bounds.south || latitude > bounds.north) continue;
    const west = normalizeLongitude(bounds.west);
    const east = normalizeLongitude(bounds.east);
    const longitudeMatches = west <= east
      ? longitude >= west && longitude <= east
      : longitude >= west || longitude <= east;
    if (!longitudeMatches) continue;

    const nw = targetMap.latLngToContainerPoint([bounds.north, bounds.west]);
    const se = targetMap.latLngToContainerPoint([bounds.south, bounds.east]);
    const x = Math.floor(Math.min(nw.x, se.x));
    const y = Math.floor(Math.min(nw.y, se.y));
    const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
    const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
    return {
      row: frame.rowAt(index),
      rect: { x, y, w, h },
      bounds: {
        ...bounds,
        leaflet: L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]),
      },
      center: {
        lat: (bounds.south + bounds.north) / 2,
        lon: normalizeLongitude((bounds.west + bounds.east) / 2),
      },
    };
  }
  return null;
}

window.SampledGridColorScale = SampledGridColorScale;
window.createSampledGridRenderContext = createSampledGridRenderContext;
window.isSampledGridRenderContext = isSampledGridRenderContext;
window.sampledGridRenderContextMatchesMask = sampledGridRenderContextMatchesMask;
window.reconstructContinuousField = reconstructContinuousField;
