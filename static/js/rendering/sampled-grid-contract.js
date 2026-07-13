function sampledGridNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

class SampledGridContractModel {
  constructor(dataset = {}) {
    this.dataset = dataset || {};
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

  resolutionKm(row = null) {
    const rowResolution = sampledGridNumberOrNull(row?.resolution_km);
    if (Number.isFinite(rowResolution) && rowResolution > 0) return rowResolution;
    const actual = sampledGridNumberOrNull(state.sampledGridMeta?.actual_resolution_km);
    if (Number.isFinite(actual) && actual > 0) return actual;
    return this.availableResolutionsKm.length === 1 ? this.availableResolutionsKm[0] : null;
  }

  cellAt(latValue, lonValue, resolutionValue = null) {
    const lat = sampledGridNumberOrNull(latValue);
    const lon = sampledGridNumberOrNull(lonValue);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const resolution = sampledGridNumberOrNull(resolutionValue ?? this.resolutionKm());
    const geometry = this.contract.geometry || {};
    const alignment = this.contract.alignment || {};
    const encoding = String(geometry.encoding || "center").toLowerCase();
    if (encoding === "global_index") {
      const available = this.availableResolutionsKm;
      const baseResolution = Number(geometry.base_resolution_km || available[0]);
      const units = Number(geometry.index_units_per_degree || alignment.index_units_per_degree);
      const originLat = Number(geometry.origin_lat ?? alignment.origin_lat);
      const originLon = Number(geometry.origin_lon ?? alignment.origin_lon);
      if (![resolution, baseResolution, units, originLat, originLon].every(Number.isFinite)
        || resolution <= 0 || baseResolution <= 0 || units <= 0) return null;
      const factor = resolution / baseResolution;
      const row = Math.floor(((originLat - lat) * units) / factor) * factor;
      const column = Math.floor(((normalizeLongitude(lon) - originLon) * units) / factor) * factor;
      const north = originLat - (row / units);
      const west = originLon + (column / units);
      const span = factor / units;
      return this.cellFromBounds({ west, south: north - span, east: west + span, north }, resolution);
    }
    const width = Number(geometry.cell_width_degrees || geometry.cell_size_degrees);
    const height = Number(geometry.cell_height_degrees || geometry.cell_size_degrees);
    const originLon = Number(geometry.origin_lon ?? alignment.origin_lon);
    const originLat = Number(geometry.origin_lat ?? alignment.origin_lat);
    if (![width, height, originLon, originLat].every(Number.isFinite)
      || width <= 0 || height <= 0) return null;
    const normalizedLon = normalizeLongitude(lon);
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
  static WEB_MERCATOR_KM_PER_CSS_PIXEL_AT_ZOOM_ZERO = 156.54303392804097;

  static groundResolutionKm({ zoom, latitude }) {
    const zoomValue = sampledGridNumberOrNull(zoom);
    const latitudeNumber = sampledGridNumberOrNull(latitude);
    const latitudeValue = Math.max(-85, Math.min(85, latitudeNumber ?? 0));
    if (!Number.isFinite(zoomValue)) return null;
    return this.WEB_MERCATOR_KM_PER_CSS_PIXEL_AT_ZOOM_ZERO
      * Math.cos(latitudeValue * Math.PI / 180)
      / (2 ** zoomValue);
  }

  static requestedResolutionKm(model, { zoom, latitude }) {
    const available = model.availableResolutionsKm;
    if (!available.length) return null;
    const groundResolution = this.groundResolutionKm({ zoom, latitude });
    if (!Number.isFinite(groundResolution)) return available[available.length - 1];
    return available.find((value) => value >= groundResolution) || available[available.length - 1];
  }
}

const SampledGridContract = (() => {
  function dataset(datasetId = state.datasetId) {
    return state.datasets?.[datasetId] || {};
  }

  function model(datasetId = state.datasetId) {
    return new SampledGridContractModel(dataset(datasetId));
  }

  function requestResolution({ datasetId = state.datasetId, zoom = map?.getZoom?.(), latitude = map?.getCenter?.().lat } = {}) {
    return SampledGridResolutionPlanner.requestedResolutionKm(model(datasetId), { zoom, latitude });
  }

  return {
    Model: SampledGridContractModel,
    ResolutionPlanner: SampledGridResolutionPlanner,
    dataset,
    model,
    requestResolution,
  };
})();

window.SampledGridContract = SampledGridContract;
