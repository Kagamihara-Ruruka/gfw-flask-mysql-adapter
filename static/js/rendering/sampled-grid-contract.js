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
    if (this.dataStatus(row) === "no_data") return false;
    const coverageRatio = this.coverageRatio(row);
    return coverageRatio == null || coverageRatio > 0;
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
    const configuredDefault = sampledGridNumberOrNull(model.contract.default_resolution_km);
    const declared = available.find((value) => Math.abs(value - preferred) <= 1e-9);
    const fallback = available.find((value) => Math.abs(value - configuredDefault) <= 1e-9);
    return declared ?? fallback ?? available[0];
  }
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

  function queryRoute(datasetId, configuredResolutionKm) {
    const route = state.sampledGridQueryResolutionByDataset?.[datasetId] || null;
    const effective = sampledGridNumberOrNull(route?.effective_resolution_km);
    if (!route
      || !sameResolution(route.configured_resolution_km, configuredResolutionKm)
      || !Number.isFinite(effective)
      || effective <= 0) return null;
    return route;
  }

  function queryResolution({ datasetId = state.datasetId } = {}) {
    const configuredResolutionKm = requestResolution({ datasetId });
    const route = queryRoute(datasetId, configuredResolutionKm);
    return sampledGridNumberOrNull(route?.effective_resolution_km) ?? configuredResolutionKm;
  }

  function resolutionState(datasetId = state.datasetId) {
    const requestedResolutionKm = requestResolution({ datasetId });
    const route = queryRoute(datasetId, requestedResolutionKm);
    const meta = state.sampledGridMetaByDataset?.[datasetId] || null;
    const metaRequested = sampledGridNumberOrNull(meta?.requested_resolution_km);
    const metaActual = sampledGridNumberOrNull(meta?.actual_resolution_km);
    const actualResolutionKm = sampledGridNumberOrNull(route?.effective_resolution_km)
      ?? (sameResolution(metaRequested, requestedResolutionKm) ? metaActual : null);
    return {
      datasetId,
      requestedResolutionKm,
      actualResolutionKm,
      effectiveResolutionKm: actualResolutionKm ?? requestedResolutionKm,
      queryResolutionKm: actualResolutionKm ?? requestedResolutionKm,
      degraded: Number.isFinite(actualResolutionKm)
        && Number.isFinite(requestedResolutionKm)
        && actualResolutionKm > requestedResolutionKm,
      resolved: Number.isFinite(actualResolutionKm),
    };
  }

  function emitResolutionChange(datasetId, reason) {
    window.dispatchEvent(new CustomEvent("rrkal:sampled-grid-resolution-changed", {
      detail: { reason, ...resolutionState(datasetId) },
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
    state.sampledGridQueryResolutionByDataset = state.sampledGridQueryResolutionByDataset || {};
    state.sampledGridResolutionByDataset[id] = selected;
    delete state.sampledGridMetaByDataset[id];
    delete state.sampledGridQueryResolutionByDataset[id];
    if (id === state.datasetId) state.sampledGridMeta = null;
    emitResolutionChange(id, "requested_resolution_changed");
    return selected;
  }

  function recordResolvedResolution(datasetId = state.datasetId, grid = null) {
    const id = String(datasetId || "").trim();
    if (!id || !grid || typeof grid !== "object") return resolutionState(id);
    state.sampledGridMetaByDataset = state.sampledGridMetaByDataset || {};
    state.sampledGridQueryResolutionByDataset = state.sampledGridQueryResolutionByDataset || {};
    const configuredResolutionKm = requestResolution({ datasetId: id });
    const sourceRequestedResolutionKm = sampledGridNumberOrNull(grid.requested_resolution_km);
    const actualResolutionKm = sampledGridNumberOrNull(grid.actual_resolution_km);
    const previousRoute = queryRoute(id, configuredResolutionKm);
    const continuesResolvedRoute = previousRoute
      && sameResolution(sourceRequestedResolutionKm, previousRoute.effective_resolution_km);
    if (Number.isFinite(actualResolutionKm)
      && actualResolutionKm > 0
      && (sameResolution(sourceRequestedResolutionKm, configuredResolutionKm) || continuesResolvedRoute)) {
      state.sampledGridQueryResolutionByDataset[id] = {
        configured_resolution_km: configuredResolutionKm,
        effective_resolution_km: actualResolutionKm,
        source_requested_resolution_km: sourceRequestedResolutionKm,
      };
    }
    state.sampledGridMetaByDataset[id] = { ...grid };
    if (id === state.datasetId) state.sampledGridMeta = state.sampledGridMetaByDataset[id];
    emitResolutionChange(id, "actual_resolution_resolved");
    return resolutionState(id);
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
