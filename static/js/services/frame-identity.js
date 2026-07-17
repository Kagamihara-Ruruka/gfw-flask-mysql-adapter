function createFrameIdentity({ datasetResolver } = {}) {
  if (typeof datasetResolver !== "function") {
    throw new TypeError("FrameIdentity requires a datasetResolver");
  }
  const BBOX_PRECISION = 6;

  function finiteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function parseBbox(value) {
    if (Array.isArray(value)) {
      const parts = value.map(finiteNumber);
      if (parts.length === 4 && parts.every((part) => part !== null)) return parts;
      return null;
    }
    if (value && typeof value === "object") {
      const parts = [value.west, value.south, value.east, value.north].map(finiteNumber);
      if (parts.every((part) => part !== null)) return parts;
      const alternate = [value.min_lon, value.min_lat, value.max_lon, value.max_lat].map(finiteNumber);
      if (alternate.every((part) => part !== null)) return alternate;
      return null;
    }
    const parts = String(value || "").split(",").map(finiteNumber);
    return parts.length === 4 && parts.every((part) => part !== null) ? parts : null;
  }

  function normalizedBbox(value, { precision = BBOX_PRECISION } = {}) {
    const parts = parseBbox(value);
    if (!parts) return null;
    let [west, south, east, north] = parts;
    west = Math.max(-180, Math.min(180, west));
    east = Math.max(-180, Math.min(180, east));
    south = Math.max(-90, Math.min(90, south));
    north = Math.max(-90, Math.min(90, north));
    if (west > east || south > north) return null;
    const factor = 10 ** Math.max(0, precision);
    const rounded = [west, south, east, north].map((number) => Math.round(number * factor) / factor);
    return Object.freeze({
      west: rounded[0],
      south: rounded[1],
      east: rounded[2],
      north: rounded[3],
    });
  }

  function bboxSignature(value, options = {}) {
    const box = normalizedBbox(value, options);
    if (!box) return "outside";
    const precision = Math.max(0, Number(options.precision ?? BBOX_PRECISION));
    return [box.west, box.south, box.east, box.north]
      .map((number) => number.toFixed(precision))
      .join(",");
  }

  function datasetNamespace(request = {}) {
    const datasetId = String(request.datasetId || request.dataset_id || "");
    const dataset = datasetResolver(datasetId) || {};
    const sampledGrid = dataset.sampled_grid || {};
    const gridProfile = sampledGrid.grid_profile || {};
    return String(request.cacheNamespace || dataset.cache_namespace || [
      datasetId,
      dataset.backend || "",
      dataset.source_config || "",
      dataset.connection_ref || "",
      sampledGrid.contract_version || "",
      sampledGrid.mapping_version || request.mappingVersion || "",
      gridProfile.signature || "",
    ].join("~"));
  }

  function transportKey(request = {}) {
    const datasetId = String(request.datasetId || request.dataset_id || "");
    const dataset = datasetResolver(datasetId) || {};
    return String(
      request.transportKey
      || request.queryTransportKey
      || request.query_transport_key
      || dataset.query_transport_key
      || dataset.runtime?.query_transport_key
      || `dataset:${datasetId}`
    );
  }

  function requestedResolution(request = {}) {
    return request.resolution ?? request.requestedResolutionKm ?? request.requested_resolution_km ?? null;
  }

  function queryResolution(request = {}) {
    return request.queryResolution
      ?? request.effectiveQueryResolutionKm
      ?? request.effective_query_resolution_km
      ?? requestedResolution(request);
  }

  function requestParts(request = {}, { actualResolution = undefined } = {}) {
    const requested = requestedResolution(request);
    const resolution = actualResolution === undefined ? requested : actualResolution;
    const autoContext = resolution == null
      ? `${request.zoom ?? "auto"}@${request.latitude ?? "auto"}`
      : "fixed";
    return [
      datasetNamespace(request),
      String(request.date || ""),
      bboxSignature(request.bbox),
      request.limit == null ? "max" : String(request.limit),
      String(request.columns || "render"),
      resolution == null ? "auto" : String(resolution),
      autoContext,
    ];
  }

  function intentKey(request = {}) {
    return `intent|${requestParts(request).join("|")}`;
  }

  function actualResolutionFrom(packet, request = {}) {
    const candidates = [
      packet?.grid?.actual_resolution_km,
      packet?.grid?.resolution_km,
      packet?.actual_resolution_km,
      packet?.rows?.[0]?.resolution_km,
      queryResolution(request),
    ];
    for (const candidate of candidates) {
      const numeric = finiteNumber(candidate);
      if (numeric !== null && numeric > 0) return numeric;
    }
    return null;
  }

  function frameKey(request = {}, packet = null) {
    const actualResolution = actualResolutionFrom(packet, request);
    return `frame|${requestParts(request, { actualResolution }).join("|")}`;
  }

  function scopeKey(request = {}) {
    const parts = requestParts({ ...request, date: "" });
    return `scope|${parts.join("|")}`;
  }

  function normalizeRequest(request = {}) {
    const box = normalizedBbox(request.bbox);
    const resolution = requestedResolution(request);
    const effectiveQueryResolution = queryResolution(request);
    return Object.freeze({
      ...request,
      datasetId: String(request.datasetId || request.dataset_id || ""),
      date: String(request.date || ""),
      bbox: box ? bboxSignature(box) : "",
      columns: String(request.columns || "render"),
      limit: request.limit == null ? "max" : request.limit,
      resolution,
      requestedResolutionKm: resolution,
      queryResolution: effectiveQueryResolution,
      effectiveQueryResolutionKm: effectiveQueryResolution,
      cacheNamespace: datasetNamespace(request),
      transportKey: transportKey(request),
    });
  }

  return Object.freeze({
    actualResolutionFrom,
    bboxSignature,
    datasetNamespace,
    frameKey,
    intentKey,
    normalizeRequest,
    normalizedBbox,
    parseBbox,
    queryResolution,
    requestParts,
    scopeKey,
    transportKey,
  });
}

if (typeof globalThis !== "undefined") globalThis.createFrameIdentity = createFrameIdentity;
