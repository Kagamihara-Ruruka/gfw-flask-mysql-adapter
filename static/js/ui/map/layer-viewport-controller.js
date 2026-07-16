function normalizeCoverageBounds(value) {
  const bounds = {
    west: Number(value?.west),
    south: Number(value?.south),
    east: Number(value?.east),
    north: Number(value?.north),
  };
  if (!Object.values(bounds).every(Number.isFinite)) return null;
  if (bounds.west >= bounds.east || bounds.south >= bounds.north) return null;
  return bounds;
}

function parseCoverageBbox(value) {
  const values = String(value || "").split(",").map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) return null;
  return normalizeCoverageBounds({
    west: values[0],
    south: values[1],
    east: values[2],
    north: values[3],
  });
}

function createDatasetCoverageModel(dataset = {}) {
  const areas = (dataset?.sampled_grid?.coverage_areas || [])
    .map((coverage) => ({
      id: String(coverage?.id || "").trim(),
      label: String(coverage?.label || "").trim(),
      bounds: normalizeCoverageBounds(coverage?.bounds),
    }))
    .filter((coverage) => coverage.bounds);
  const bounded = areas.length > 0;
  const unionBounds = bounded
    ? areas.reduce((union, area) => ({
      west: Math.min(union.west, area.bounds.west),
      south: Math.min(union.south, area.bounds.south),
      east: Math.max(union.east, area.bounds.east),
      north: Math.max(union.north, area.bounds.north),
    }), { ...areas[0].bounds })
    : null;

  function contains(latValue, lonValue) {
    if (!bounded) return true;
    const lat = Number(latValue);
    const lon = Number(lonValue);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    return areas.some(({ bounds }) => (
      lon >= bounds.west && lon <= bounds.east
      && lat >= bounds.south && lat <= bounds.north
    ));
  }

  function clipBbox(value) {
    const requested = parseCoverageBbox(value);
    if (!requested || !bounded) return requested;
    const intersections = areas.map(({ bounds }) => normalizeCoverageBounds({
      west: Math.max(requested.west, bounds.west),
      south: Math.max(requested.south, bounds.south),
      east: Math.min(requested.east, bounds.east),
      north: Math.min(requested.north, bounds.north),
    })).filter(Boolean);
    if (!intersections.length) return null;
    return intersections.reduce((union, bounds) => ({
      west: Math.min(union.west, bounds.west),
      south: Math.min(union.south, bounds.south),
      east: Math.max(union.east, bounds.east),
      north: Math.max(union.north, bounds.north),
    }), { ...intersections[0] });
  }

  function clipBboxString(value) {
    const clipped = clipBbox(value);
    return clipped
      ? [clipped.west, clipped.south, clipped.east, clipped.north]
        .map((number) => number.toFixed(6))
        .join(",")
      : null;
  }

  return Object.freeze({
    areas: Object.freeze(areas.map((area) => Object.freeze({ ...area, bounds: Object.freeze(area.bounds) }))),
    bounded,
    unionBounds: unionBounds ? Object.freeze(unionBounds) : null,
    contains,
    clipBbox,
    clipBboxString,
  });
}

class DatasetViewportController {
  constructor({ targetMap, targetState, eventTarget }) {
    if (!targetMap || !targetState || !eventTarget?.dispatchEvent) {
      throw new TypeError("DatasetViewportController requires map, state and event target");
    }
    this.map = targetMap;
    this.state = targetState;
    this.eventTarget = eventTarget;
    this.baseMinZoom = Number(targetMap.getMinZoom?.() ?? 2);
    this.activeDatasetId = null;
    this.disposed = false;
  }

  model(datasetId = this.state.datasetId) {
    return createDatasetCoverageModel(this.state.datasets?.[datasetId] || {});
  }

  minimumInsideZoom(bounds) {
    const candidate = Number(this.map.getBoundsZoom(bounds, true));
    const maximum = Number(this.map.getMaxZoom?.());
    const resolved = Number.isFinite(candidate)
      ? Math.max(this.baseMinZoom, Math.ceil(candidate))
      : this.baseMinZoom;
    return Number.isFinite(maximum) ? Math.min(resolved, maximum) : resolved;
  }

  syncForDataset(datasetId = this.state.datasetId, { focus = false } = {}) {
    const normalizedDatasetId = String(datasetId || "").trim();
    const model = this.model(normalizedDatasetId);
    if (!normalizedDatasetId || !model.bounded) {
      return this.release();
    }

    const union = model.unionBounds;
    const leafletBounds = L.latLngBounds(
      [union.south, union.west],
      [union.north, union.east],
    );
    const minZoom = this.minimumInsideZoom(leafletBounds);
    const changed = this.activeDatasetId !== normalizedDatasetId
      || this.state.layerViewport?.signature !== JSON.stringify(union);

    this.activeDatasetId = normalizedDatasetId;
    this.map.setMinZoom(minZoom);
    this.map.setMaxBounds(leafletBounds);
    if (focus || changed || !leafletBounds.contains(this.map.getCenter())) {
      this.map.setView(leafletBounds.getCenter(), minZoom, { animate: false });
    } else if (this.map.getZoom() < minZoom) {
      this.map.setZoom(minZoom, { animate: false });
    }
    this.map.panInsideBounds(leafletBounds, { animate: false });

    this.state.layerViewport = {
      mode: "coverage",
      datasetId: normalizedDatasetId,
      signature: JSON.stringify(union),
      bounds: union,
      minZoom,
      coverageIds: model.areas.map((area) => area.id).filter(Boolean),
    };
    this.dispatch();
    return this.state.layerViewport;
  }

  settleForQuery(datasetId = this.state.datasetId, { focus = false } = {}) {
    if (this.disposed) return this.state.layerViewport;
    // Layer labels and controls can resize the map shell during activation.
    // Leaflet's size read forces current layout, so this must not depend on a
    // requestAnimationFrame that browsers throttle in background tabs.
    this.map.invalidateSize?.({ animate: false, pan: false });
    return this.syncForDataset(datasetId, { focus });
  }

  release() {
    this.activeDatasetId = null;
    this.map.setMinZoom(this.baseMinZoom);
    this.map.setMaxBounds(null);
    this.state.layerViewport = {
      mode: "unbounded",
      datasetId: null,
      signature: "",
      bounds: null,
      minZoom: this.baseMinZoom,
      coverageIds: [],
    };
    this.dispatch();
    return this.state.layerViewport;
  }

  queryBbox(value, datasetId = this.state.datasetId) {
    const model = this.model(datasetId);
    return model.bounded ? model.clipBboxString(value) : value;
  }

  filterRows(rows, datasetId = this.state.datasetId) {
    const model = this.model(datasetId);
    if (!model.bounded) return Array.isArray(rows) ? rows : [];
    const contract = SampledGridContract.model(datasetId);
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      const bounds = contract.bounds(row);
      if (!bounds) return false;
      return model.contains(
        (bounds.south + bounds.north) / 2,
        normalizeLongitude((bounds.west + bounds.east) / 2),
      );
    });
  }

  dispatch() {
    this.eventTarget.dispatchEvent(new CustomEvent("rrkal:layer-viewport-changed", {
      detail: { ...this.state.layerViewport },
    }));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.activeDatasetId = null;
    this.map.setMinZoom(this.baseMinZoom);
    this.map.setMaxBounds(null);
  }
}

window.createDatasetCoverageModel = createDatasetCoverageModel;
window.normalizeCoverageBounds = normalizeCoverageBounds;
window.parseCoverageBbox = parseCoverageBbox;
window.DatasetViewportController = DatasetViewportController;
