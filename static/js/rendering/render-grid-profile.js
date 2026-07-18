const RENDER_GRID_PROFILE_SCHEMA = "rrkal.render_grid_profile.v1";

function renderGridPositiveInteger(value, fallback = 1, maximum = 64) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

function resolveRenderGridZoomBucket(zoom, previousBucket = null, hysteresis = 0.2) {
  const current = Number(zoom);
  if (!Number.isFinite(current)) return Number.isFinite(previousBucket) ? previousBucket : null;
  if (!Number.isFinite(previousBucket)) return Math.round(current);
  const margin = Math.max(0, Math.min(0.49, Number(hysteresis) || 0));
  if (current > previousBucket + 0.5 + margin) return Math.round(current);
  if (current < previousBucket - 0.5 - margin) return Math.round(current);
  return previousBucket;
}

function resolveZoomAggregationFactor({
  geometry,
  zoomBucket,
  minCellPixels = 1.5,
  maximumFactor = 64,
} = {}) {
  const widthDegrees = Number(geometry?.cell_width_degrees);
  const zoom = Number(zoomBucket);
  if (!Number.isFinite(widthDegrees) || widthDegrees <= 0 || !Number.isFinite(zoom)) return 1;
  const baseCellPixels = widthDegrees * ((256 * (2 ** zoom)) / 360);
  const targetPixels = Math.max(0.5, Number(minCellPixels) || 1.5);
  let factor = 1;
  while (baseCellPixels * factor < targetPixels && factor < maximumFactor) factor *= 2;
  return Math.min(maximumFactor, factor);
}

function renderAggregationContract(participants, datasetProvider) {
  const declarations = (participants || []).map((participant) => {
    const dataset = datasetProvider(participant.dataset_id) || {};
    const contract = dataset.sampled_grid?.visualization?.aggregation || {};
    return {
      reducer: String(contract.reducer || "").trim().toLowerCase(),
      nullPolicy: String(contract.null_policy || "").trim().toLowerCase(),
      minCellPixels: Number(contract.min_cell_pixels),
      maximumFactor: Number(contract.max_factor),
      hysteresis: Number(contract.zoom_hysteresis),
    };
  });
  if (!declarations.length) return null;
  const first = declarations[0];
  const compatible = declarations.every((item) => (
    item.reducer === first.reducer && item.nullPolicy === first.nullPolicy
  ));
  if (!compatible || first.reducer !== "mean" || first.nullPolicy !== "ignore") return null;
  return {
    reducer: first.reducer,
    nullPolicy: first.nullPolicy,
    minCellPixels: Number.isFinite(first.minCellPixels) ? first.minCellPixels : 1.5,
    maximumFactor: renderGridPositiveInteger(first.maximumFactor, 64, 64),
    hysteresis: Number.isFinite(first.hysteresis) ? first.hysteresis : 0.2,
  };
}

function renderGridProfileSignature(profile) {
  return JSON.stringify({
    status: profile.status,
    participants: profile.participants,
    baseGeometry: profile.baseGeometry,
    geometry: profile.geometry,
    aggregationFactor: profile.aggregationFactor,
    zoomBucket: profile.zoomBucket,
    reducer: profile.reducer,
    nullPolicy: profile.nullPolicy,
    gpuAggregation: profile.gpuAggregation,
  });
}

function buildRenderGridProfile({
  baseGrid,
  zoom,
  previousProfile = null,
  requestedMultiplier = 1,
  gpuAggregationAvailable = false,
  datasetProvider = () => null,
} = {}) {
  const participants = (baseGrid?.participants || []).map((item) => ({ ...item }));
  const baseGeometry = baseGrid?.geometry ? { ...baseGrid.geometry } : null;
  if (!baseGeometry || baseGrid?.status === "unavailable") {
    const unavailable = {
      schema: RENDER_GRID_PROFILE_SCHEMA,
      status: "unavailable",
      participants,
      baseGeometry: null,
      geometry: null,
      baseResolutionKm: null,
      renderResolutionKm: null,
      requestedMultiplier: renderGridPositiveInteger(requestedMultiplier),
      aggregationFactor: 1,
      zoomFactor: 1,
      zoomBucket: null,
      reducer: null,
      nullPolicy: null,
      gpuAggregation: false,
      overrideReason: "base_grid_unavailable",
      detail: baseGrid?.detail || "No compatible sampled-grid layer",
    };
    return Object.freeze({ ...unavailable, signature: renderGridProfileSignature(unavailable) });
  }

  const aggregation = renderAggregationContract(participants, datasetProvider);
  const zoomBucket = resolveRenderGridZoomBucket(
    zoom,
    previousProfile?.zoomBucket,
    aggregation?.hysteresis,
  );
  const manualFactor = renderGridPositiveInteger(requestedMultiplier);
  const canAggregate = Boolean(aggregation && gpuAggregationAvailable);
  const zoomFactor = canAggregate
    ? resolveZoomAggregationFactor({
      geometry: baseGeometry,
      zoomBucket,
      minCellPixels: aggregation.minCellPixels,
      maximumFactor: aggregation.maximumFactor,
    })
    : 1;
  const aggregationFactor = canAggregate ? Math.max(manualFactor, zoomFactor) : 1;
  const baseResolutionKm = Number(baseGrid.baseResolutionKm);
  const geometry = {
    ...baseGeometry,
    cell_width_degrees: Number(baseGeometry.cell_width_degrees) * aggregationFactor,
    cell_height_degrees: Number(baseGeometry.cell_height_degrees) * aggregationFactor,
  };
  const profile = {
    schema: RENDER_GRID_PROFILE_SCHEMA,
    status: baseGrid.status,
    participants,
    baseGeometry,
    geometry,
    baseResolutionKm: Number.isFinite(baseResolutionKm) ? baseResolutionKm : null,
    renderResolutionKm: Number.isFinite(baseResolutionKm)
      ? baseResolutionKm * aggregationFactor
      : null,
    requestedMultiplier: manualFactor,
    aggregationFactor,
    zoomFactor,
    zoomBucket,
    reducer: aggregation?.reducer || null,
    nullPolicy: aggregation?.nullPolicy || null,
    gpuAggregation: canAggregate && aggregationFactor > 1,
    overrideReason: canAggregate
      ? null
      : aggregation
        ? "gpu_aggregation_unavailable"
        : "aggregation_contract_missing_or_incompatible",
    detail: aggregationFactor > 1
      ? `${baseGrid.detail} / GPU ${aggregation.reducer} x ${aggregationFactor}`
      : baseGrid.detail,
  };
  return Object.freeze({ ...profile, signature: renderGridProfileSignature(profile) });
}

class RenderGridProfileControllerCore {
  constructor({
    targetState,
    baseGridProvider,
    zoomProvider,
    gpuAggregationAvailableProvider,
    datasetProvider,
    eventTarget,
  } = {}) {
    if (!targetState || typeof baseGridProvider !== "function" || typeof zoomProvider !== "function"
      || typeof gpuAggregationAvailableProvider !== "function" || typeof datasetProvider !== "function"
      || !eventTarget?.dispatchEvent) {
      throw new TypeError("RenderGridProfileController requires state, grid, zoom, GPU, dataset and event providers");
    }
    this.state = targetState;
    this.baseGridProvider = baseGridProvider;
    this.zoomProvider = zoomProvider;
    this.gpuAggregationAvailableProvider = gpuAggregationAvailableProvider;
    this.datasetProvider = datasetProvider;
    this.eventTarget = eventTarget;
    this.profile = null;
    this.revision = 0;
  }

  refresh(reason = "refresh") {
    const profile = buildRenderGridProfile({
      baseGrid: this.baseGridProvider(),
      zoom: this.zoomProvider(),
      previousProfile: this.profile,
      requestedMultiplier: this.state.virtualGrid?.requestedMultiplier,
      gpuAggregationAvailable: this.gpuAggregationAvailableProvider(),
      datasetProvider: this.datasetProvider,
    });
    const changed = profile.signature !== this.profile?.signature;
    if (!changed && this.profile) {
      this.state.renderGridProfile = this.profile;
      return this.profile;
    }
    this.revision += 1;
    this.profile = Object.freeze({ ...profile, revision: this.revision });
    this.state.renderGridProfile = this.profile;
    this.eventTarget.dispatchEvent(new CustomEvent("rrkal:render-grid-profile-changed", {
      detail: { reason, ...this.profile },
    }));
    return this.profile;
  }

  snapshot() {
    return this.profile;
  }

  dispose() {
    this.profile = null;
  }
}

Object.assign(globalThis, {
  RENDER_GRID_PROFILE_SCHEMA,
  RenderGridProfileControllerCore,
  buildRenderGridProfile,
  renderAggregationContract,
  resolveRenderGridZoomBucket,
  resolveZoomAggregationFactor,
});
