const sampledGridPaintState = {
  scaleMode: "contract",
  colorStops: [
    { position: 0, color: "#163b4a" },
    { position: 0.25, color: "#2d8296" },
    { position: 0.5, color: "#4dbb9b" },
    { position: 0.75, color: "#e2bd52" },
    { position: 1, color: "#d85a30" },
  ],
  maxValue: null,
  alpha: 0.58,
};

const dataFrameStoreState = {
  maxEntries: 0,
  maxBytes: 512 * 1024 * 1024,
  stats: {
    hits: 0,
    misses: 0,
  },
};

const state = {
  datasets: {},
  datasetId: null,
  dataLayer: null,
  enabledLayerIds: [],
  layerContracts: [],
  importedLayerIds: [],
  importedLayers: {},
  overlayLayers: { eez: false },
  layerOrder: [],
  layerAlpha: { ais: 0.58, eez: 1 },
  schema: null,
  eezLayer: null,
  eezTileLayers: [],
  eezMode: null,
  eezSeq: 0,
  eezActivePane: "eezPaneA",
  eezStagePane: "eezPaneB",
  renderedLodZoom: {
    gfw: null,
    ais: null,
    eez: null,
  },
  graticuleLayer: null,
  eezPaint: {
    fillColor: "#176f86",
    boundaryColor: "#1f7f96",
    fillOpacity: 0.08,
    boundaryOpacity: 0.88,
    polTypeColors: {
      disputed: "#ef5b5b",
      joint: "#f5a524",
      other: "#94a3b8",
    },
  },
  sampledGridPaint: sampledGridPaintState,
  sampledGridPaintProfiles: {},
  gfwPaint: sampledGridPaintState,
  mapSettings: {
    basemapId: "carto_light",
    scaleVisible: true,
    zoomControlVisible: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    dragging: true,
    keyboard: true,
    vignetteVisible: false,
    vignetteInsetPct: 1,
    vignetteStrength: 55,
    graticuleVisible: false,
    graticuleLabels: true,
    graticuleAlpha: 0.45,
    graticuleColor: "#e2ecf6",
    graticuleLineStyle: "dashed",
    graticuleLineWidth: 1,
  },
  layerViewport: {
    mode: "unbounded",
    datasetId: null,
    signature: "",
    bounds: null,
    minZoom: 2,
    coverageIds: [],
  },
  tileSelection: {
    enabled: false,
    mode: "single",
    hover: null,
    selected: null,
    items: [],
  },
  virtualGrid: {
    strategy: "least_common_multiple",
    status: "unresolved",
    revision: 0,
    signature: "",
    participants: [],
    geometry: null,
    resolutionKm: null,
    detail: "等待圖層合約",
  },
  aisLiveSeq: 0,
  aisSettings: null,
  aisSocket: null,
  aisLayer: null,
  gridLayer: null,
  sampledGridMeta: null,
  sampledGridMetaByDataset: {},
  sampledGridAoiByDataset: {},
  sampledGridResolutionByDataset: {},
  sampledGridQueryResolutionByDataset: {},
  renderCapability: null,
  rendering: {
    sampledGridMode: "canvas",
    sampledGridBackend: "",
    gfwMode: "canvas",
    viewportReloadSettleMs: 700,
    gfwBackend: "等待中",
  },
  dataFrameStore: dataFrameStoreState,
  lifecycleEvents: {
    maxEntries: 20000,
  },
  playbackCache: {
    stepMode: "sequential",
    watermarkStrategy: "adaptive",
    windowBehind: 1,
    highWatermark: 10,
    lowWatermark: 5,
    startupWatermark: 5,
    resumeWatermark: 5,
    maxPendingFrames: 12,
    scopeSettleMs: 600,
    adaptiveWatermark: {
      minimumSupplySamples: 2,
      minimumStartupSamples: 10,
      latencySafetyFactor: 1.35,
      reserveSlices: 2,
      maxSupplyDeficitFactor: 2,
      lowRatio: 0.5,
      maxHighWatermark: 60,
      ramBudgetFraction: 0.75,
      defaultFrameBytes: 4 * 1024 * 1024,
      decreaseHoldMs: 15000,
      decreaseStep: 2,
    },
    isBackgroundPreloading: false,
    buffering: false,
    bufferStatus: "idle",
    bufferReady: 0,
    bufferRequired: 0,
    bufferResume: 0,
    bufferCurrentDate: "",
    bufferTargetIndex: -1,
    bufferAttempts: 0,
    bufferStateName: "",
    bufferErrorMessage: "",
    generation: 0,
    timeline: null,
  },
  playbackDelivery: {
    mode: "analysis",
    requestedMode: "analysis",
  },
  playbackInterpolation: {
    mode: "layer_crossfade",
  },
  gfwRenderArtifactCache: {
    generation: 0,
    released: 0,
    reason: "",
    clearedMonotonicMs: 0,
    gpu: false,
  },
  rows: [],
  columns: [],
  renderedGfwDate: null,
  renderedSampledGridDate: null,
  sampledGridTransitionMs: 180,
  sampledGridZoomBlurPx: 2,
  gfwTransitionMs: 180,
  gfwZoomBlurPx: 2,
  availableDates: [],
  fetchSeq: 0,
  primaryFetchController: null,
  primaryReloadTimer: null,
  playTimer: null,
  playIntervalMs: 1400,
  playbackRate: 1,
  isBootstrapping: true,
  queryPolicy: {
    default_limit: null,
    max_limit: null,
    table_preview_limit: 300,
    network_concurrency: 6,
    background_network_concurrency: 3,
  },
};

function sampledGridCoverageAreas(datasetId = state.datasetId) {
  const areas = state.datasets?.[datasetId]?.sampled_grid?.coverage_areas;
  return (Array.isArray(areas) ? areas : [])
    .map((area) => ({
      ...area,
      id: String(area?.id || "").trim(),
      label: String(area?.label || area?.id || "").trim(),
    }))
    .filter((area) => area.id);
}

function sampledGridAvailableResolutions(datasetId = state.datasetId) {
  const resolutions = state.datasets?.[datasetId]?.sampled_grid?.available_resolutions_km;
  return [...new Set((Array.isArray(resolutions) ? resolutions : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0))]
    .sort((left, right) => left - right);
}

function selectedSampledGridAoi(datasetId = state.datasetId) {
  const areas = sampledGridCoverageAreas(datasetId);
  const available = new Set(areas.map((area) => area.id));
  const remembered = String(state.sampledGridAoiByDataset?.[datasetId] || "").trim();
  if (available.has(remembered)) return remembered;
  const configured = String(state.datasets?.[datasetId]?.sampled_grid?.default_aoi || "").trim();
  return available.has(configured) ? configured : (areas[0]?.id || "");
}
