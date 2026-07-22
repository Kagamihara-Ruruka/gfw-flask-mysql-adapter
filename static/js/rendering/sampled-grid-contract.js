function sampledGridNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

class SampledGridContractModel {
  constructor(dataset = {}, datasetId = null) {
    this.dataset = dataset || {};
    this.datasetId = String(datasetId || "").trim();
    this.contract = this.dataset.sampled_grid || {};
  }

  get enabled() {
    return this.contract.contract_version === "rrkal.sampled_grid.v1"
      || Array.isArray(this.contract.available_resolutions_km)
      || Boolean(this.contract.geometry);
  }

  get availableResolutionsKm() {
    return [...new Set((this.contract.available_resolutions_km || [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0))]
      .sort((left, right) => left - right);
  }

  get defaultResolutionKm() {
    const declared = sampledGridNumberOrNull(this.contract.default_resolution_km);
    return this.availableResolutionsKm.find((value) => Math.abs(value - declared) <= 1e-9) ?? null;
  }

  get valueDomain() {
    const domain = this.contract.value_domain || {};
    return {
      min: sampledGridNumberOrNull(domain.min),
      max: sampledGridNumberOrNull(domain.max),
      unit: String(domain.unit || ""),
    };
  }

  value(row) {
    return sampledGridNumberOrNull(row?.value);
  }

  get zeroIsData() {
    return this.contract.zero_is_data !== false;
  }

  coverageRatio(row) {
    return sampledGridNumberOrNull(row?.coverage_ratio);
  }

  dataStatus(row) {
    return String(row?.data_status || "").trim().toLowerCase();
  }

  bounds(row) {
    const bounds = row?.bounds || {};
    const normalized = {
      west: sampledGridNumberOrNull(bounds.west),
      south: sampledGridNumberOrNull(bounds.south),
      east: sampledGridNumberOrNull(bounds.east),
      north: sampledGridNumberOrNull(bounds.north),
    };
    return Object.values(normalized).every(Number.isFinite) ? normalized : null;
  }

  renderable(row) {
    if (!this.bounds(row) || this.value(row) == null) return false;
    return this.dataStatus(row) !== "no_data";
  }

  renderableValues({ bounds, value, dataStatus = "" } = {}) {
    if (!bounds || sampledGridNumberOrNull(value) == null) return false;
    return String(dataStatus || "").trim().toLowerCase() !== "no_data";
  }

  resolutionKm(row = null) {
    const rowResolution = sampledGridNumberOrNull(row?.resolution_km);
    if (Number.isFinite(rowResolution) && rowResolution > 0) return rowResolution;
    const datasetMeta = state.sampledGridMetaByDataset?.[this.datasetId];
    const activeMeta = this.datasetId && this.datasetId === state.datasetId
      ? state.sampledGridMeta
      : null;
    const actual = sampledGridNumberOrNull(
      datasetMeta?.actual_resolution_km ?? activeMeta?.actual_resolution_km,
    );
    if (Number.isFinite(actual) && actual > 0) return actual;
    return this.availableResolutionsKm.length === 1 ? this.availableResolutionsKm[0] : null;
  }

  gridGeometry(resolutionValue = null) {
    const resolution = sampledGridNumberOrNull(resolutionValue ?? this.resolutionKm());
    const geometry = this.contract.geometry || {};
    const alignment = this.contract.alignment || {};
    const encoding = String(geometry.encoding || "center").toLowerCase();
    const originLon = Number(geometry.origin_lon ?? alignment.origin_lon);
    const originLat = Number(geometry.origin_lat ?? alignment.origin_lat);
    if (encoding === "global_index") {
      const available = this.availableResolutionsKm;
      const baseResolution = Number(geometry.base_resolution_km || available[0]);
      const units = Number(geometry.index_units_per_degree || alignment.index_units_per_degree);
      if (![resolution, baseResolution, units, originLat, originLon].every(Number.isFinite)
        || resolution <= 0 || baseResolution <= 0 || units <= 0) return null;
      const span = (resolution / baseResolution) / units;
      return {
        encoding,
        origin_lon: originLon,
        origin_lat: originLat,
        cell_width_degrees: span,
        cell_height_degrees: span,
        resolution_km: resolution,
        index_units_per_degree: units,
        resolution_factor: resolution / baseResolution,
      };
    }
    const width = Number(geometry.cell_width_degrees || geometry.cell_size_degrees);
    const height = Number(geometry.cell_height_degrees || geometry.cell_size_degrees);
    if (![width, height, originLon, originLat].every(Number.isFinite)
      || width <= 0 || height <= 0) return null;
    return {
      encoding,
      origin_lon: originLon,
      origin_lat: originLat,
      cell_width_degrees: width,
      cell_height_degrees: height,
      resolution_km: resolution,
    };
  }

  coverageIdForBbox(bboxValue) {
    const bbox = sampledGridBboxOrNull(bboxValue);
    if (!bbox) return "";
    const areas = (this.contract.coverage_areas || [])
      .map((area) => ({
        id: String(area?.id || "").trim(),
        bounds: sampledGridBboxOrNull(area?.bounds),
      }))
      .filter(({ id, bounds }) => id && bounds);
    const containing = areas.filter(({ bounds }) => (
      bounds.west <= bbox.west
      && bounds.south <= bbox.south
      && bounds.east >= bbox.east
      && bounds.north >= bbox.north
    ));
    containing.sort((left, right) => {
      const leftArea = (left.bounds.east - left.bounds.west) * (left.bounds.north - left.bounds.south);
      const rightArea = (right.bounds.east - right.bounds.west) * (right.bounds.north - right.bounds.south);
      return leftArea - rightArea;
    });
    if (containing.length) return containing[0].id;
    const intersecting = areas
      .map((area) => {
        const width = Math.min(area.bounds.east, bbox.east) - Math.max(area.bounds.west, bbox.west);
        const height = Math.min(area.bounds.north, bbox.north) - Math.max(area.bounds.south, bbox.south);
        return { ...area, overlapArea: Math.max(0, width) * Math.max(0, height) };
      })
      .filter(({ overlapArea }) => overlapArea > 0)
      .sort((left, right) => right.overlapArea - left.overlapArea);
    return intersecting[0]?.id || "";
  }

  cellAt(latValue, lonValue, resolutionValue = null) {
    const lat = sampledGridNumberOrNull(latValue);
    const lon = sampledGridNumberOrNull(lonValue);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const grid = this.gridGeometry(resolutionValue);
    if (!grid) return null;
    const resolution = grid.resolution_km;
    const width = grid.cell_width_degrees;
    const height = grid.cell_height_degrees;
    const originLon = grid.origin_lon;
    const originLat = grid.origin_lat;
    const normalizedLon = normalizeLongitude(lon);
    if (grid.encoding === "global_index") {
      const units = grid.index_units_per_degree;
      const factor = grid.resolution_factor;
      const row = Math.floor(((originLat - lat) * units) / factor) * factor;
      const column = Math.floor(((normalizedLon - originLon) * units) / factor) * factor;
      const north = originLat - (row / units);
      const west = originLon + (column / units);
      return this.cellFromBounds({
        west,
        south: north - height,
        east: west + width,
        north,
      }, resolution);
    }
    const west = originLon + Math.floor((normalizedLon - originLon) / width) * width;
    const south = originLat + Math.floor((lat - originLat) / height) * height;
    return this.cellFromBounds({ west, south, east: west + width, north: south + height }, resolution);
  }

  cellFromBounds(bounds, resolutionKm = null) {
    return {
      bounds,
      center: {
        lat: (bounds.south + bounds.north) / 2,
        lon: normalizeLongitude((bounds.west + bounds.east) / 2),
      },
      resolution_km: sampledGridNumberOrNull(resolutionKm),
    };
  }
}

class SampledGridResolutionPlanner {
  static requestedResolutionKm(model, { preferredResolutionKm = null } = {}) {
    const available = model.availableResolutionsKm;
    if (!available.length) return null;
    const preferred = sampledGridNumberOrNull(preferredResolutionKm);
    const declared = available.find((value) => Math.abs(value - preferred) <= 1e-9);
    return declared ?? model.defaultResolutionKm ?? available[0];
  }
}

function sampledGridBboxOrNull(value) {
  let parts = null;
  if (typeof value === "string") parts = value.split(",").map(Number);
  else if (Array.isArray(value)) parts = value.map(Number);
  else if (value && typeof value === "object") {
    parts = [value.west, value.south, value.east, value.north].map(Number);
  }
  if (!parts || parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

const SampledGridContract = (() => {
  function dataset(datasetId = state.datasetId) {
    return state.datasets?.[datasetId] || {};
  }

  function model(datasetId = state.datasetId) {
    return new SampledGridContractModel(dataset(datasetId), datasetId);
  }

  function requestResolution({ datasetId = state.datasetId } = {}) {
    return SampledGridResolutionPlanner.requestedResolutionKm(model(datasetId), {
      preferredResolutionKm: state.sampledGridResolutionByDataset?.[datasetId],
    });
  }

  function sameResolution(left, right) {
    const leftNumber = sampledGridNumberOrNull(left);
    const rightNumber = sampledGridNumberOrNull(right);
    return Number.isFinite(leftNumber)
      && Number.isFinite(rightNumber)
      && Math.abs(leftNumber - rightNumber) <= 1e-9;
  }

  function queryResolution({ datasetId = state.datasetId, bbox = null, coverageId = "" } = {}) {
    void bbox;
    void coverageId;
    return requestResolution({ datasetId });
  }

  function resolutionState(datasetId = state.datasetId, scope = {}) {
    const requestedResolutionKm = requestResolution({ datasetId });
    const meta = state.sampledGridMetaByDataset?.[datasetId] || null;
    const metaRequested = sampledGridNumberOrNull(meta?.requested_resolution_km);
    const metaActual = sampledGridNumberOrNull(meta?.actual_resolution_km);
    const actualResolutionKm = sameResolution(metaRequested, requestedResolutionKm) ? metaActual : null;
    const queryResolutionKm = requestedResolutionKm;
    return {
      datasetId,
      requestedResolutionKm,
      actualResolutionKm,
      selectionResolutionKm: requestedResolutionKm,
      queryResolutionKm,
      degraded: Number.isFinite(actualResolutionKm)
        && Number.isFinite(requestedResolutionKm)
        && actualResolutionKm > requestedResolutionKm,
      resolved: Number.isFinite(actualResolutionKm),
    };
  }

  function emitResolutionChange(datasetId, reason, scope = {}) {
    window.dispatchEvent(new CustomEvent("rrkal:sampled-grid-resolution-changed", {
      detail: { reason, ...resolutionState(datasetId, scope) },
    }));
  }

  function setRequestedResolution(datasetId = state.datasetId, resolutionKm) {
    const id = String(datasetId || "").trim();
    if (!id) return null;
    const available = model(id).availableResolutionsKm;
    const selected = available.find((value) => sameResolution(value, resolutionKm));
    if (!Number.isFinite(selected)) return null;
    state.sampledGridResolutionByDataset = state.sampledGridResolutionByDataset || {};
    state.sampledGridMetaByDataset = state.sampledGridMetaByDataset || {};
    state.sampledGridResolutionByDataset[id] = selected;
    delete state.sampledGridMetaByDataset[id];
    if (id === state.datasetId) state.sampledGridMeta = null;
    emitResolutionChange(id, "requested_resolution_changed");
    return selected;
  }

  function recordResolvedResolution(datasetId = state.datasetId, grid = null, { bbox = null } = {}) {
    const id = String(datasetId || "").trim();
    if (!id || !grid || typeof grid !== "object") return resolutionState(id);
    state.sampledGridMetaByDataset = state.sampledGridMetaByDataset || {};
    const coverageId = String(grid.coverage_id || "").trim();
    state.sampledGridMetaByDataset[id] = { ...grid };
    if (id === state.datasetId) state.sampledGridMeta = state.sampledGridMetaByDataset[id];
    emitResolutionChange(id, "actual_resolution_resolved", { bbox, coverageId });
    return resolutionState(id, { bbox, coverageId });
  }

  return {
    Model: SampledGridContractModel,
    ResolutionPlanner: SampledGridResolutionPlanner,
    dataset,
    model,
    queryResolution,
    requestResolution,
    recordResolvedResolution,
    resolutionState,
    setRequestedResolution,
  };
})();

window.SampledGridContract = SampledGridContract;
