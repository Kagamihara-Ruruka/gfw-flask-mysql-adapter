function createRenderIntentService({
  targetState,
  bboxProvider,
  viewportController = null,
  frameIdentity,
  targetMap = null,
  sampledGridContract,
  selectedDateProvider,
} = {}) {
  if (
    !targetState
    || typeof bboxProvider !== "function"
    || !frameIdentity
    || !sampledGridContract
    || typeof selectedDateProvider !== "function"
  ) {
    throw new TypeError("RenderIntentService requires state, bbox, identity, grid contract and date providers");
  }

  const DEFAULT_COLUMNS = "render";

  function unlimitedLimit() {
    return targetState.queryPolicy?.max_limit == null
      ? "max"
      : Number(targetState.queryPolicy.max_limit);
  }

  function currentViewport() {
    const rawBbox = bboxProvider();
    const boundedBbox = viewportController?.queryBbox(rawBbox, targetState.datasetId) ?? rawBbox;
    const bbox = boundedBbox ? frameIdentity.bboxSignature(boundedBbox) : "";
    const viewport = {
      bbox,
      outsideCoverage: !bbox,
      zoom: targetMap?.getZoom?.() ?? null,
    };
    if (targetMap?.getCenter) viewport.center = targetMap.getCenter();
    return viewport;
  }

  function baseIntent({ layerId = targetState.dataLayer, renderProfile = "dashboard.snapshot" } = {}) {
    const viewport = currentViewport();
    const dataset = targetState.datasets?.[targetState.datasetId] || {};
    return {
      kind: "render_intent",
      version: 1,
      layerId,
      datasetId: targetState.datasetId,
      viewport,
      query: {
        aoi: typeof selectedSampledGridAoi === "function"
          ? selectedSampledGridAoi(targetState.datasetId)
          : "",
        limit: unlimitedLimit(),
        columns: DEFAULT_COLUMNS,
        requestedResolutionKm: sampledGridContract.requestResolution({
          datasetId: targetState.datasetId,
          zoom: viewport.zoom,
          latitude: viewport.center?.lat,
        }),
        effectiveQueryResolutionKm: sampledGridContract.queryResolution({
          datasetId: targetState.datasetId,
          zoom: viewport.zoom,
          latitude: viewport.center?.lat,
        }),
        mappingVersion: dataset.sampled_grid?.mapping_version || dataset.mapping_version || "",
      },
      renderProfile,
    };
  }

  function snapshot({
    date = selectedDateProvider(),
    layerId = targetState.dataLayer,
    renderProfile = "dashboard.snapshot",
  } = {}) {
    return {
      ...baseIntent({ layerId, renderProfile }),
      time: {
        mode: "single",
        date,
      },
    };
  }

  function range({
    dates = [],
    start = dates[0],
    end = dates[dates.length - 1],
    anchorDate = selectedDateProvider(),
    layerId = targetState.dataLayer,
    renderProfile = "dashboard.playback",
  } = {}) {
    return {
      ...baseIntent({ layerId, renderProfile }),
      time: {
        mode: "range",
        dates,
        start,
        end,
        anchorDate,
      },
    };
  }

  function toSampledGridPacketRequest(intent) {
    const request = {
      datasetId: intent?.datasetId,
      date: intent?.time?.date,
      bbox: intent?.viewport?.bbox,
      limit: intent?.query?.limit,
      columns: intent?.query?.columns || DEFAULT_COLUMNS,
      center: intent?.viewport?.center,
      zoom: intent?.viewport?.zoom,
      layerId: intent?.layerId,
      renderProfile: intent?.renderProfile,
      outsideCoverage: Boolean(intent?.viewport?.outsideCoverage),
      aoi: intent?.query?.aoi || "",
      resolution: intent?.query?.requestedResolutionKm,
      queryResolution: intent?.query?.effectiveQueryResolutionKm,
      latitude: intent?.viewport?.center?.lat,
      mappingVersion: intent?.query?.mappingVersion || "",
    };
    const normalized = frameIdentity.normalizeRequest(request);
    return {
      ...normalized,
      center: request.center,
      outsideCoverage: request.outsideCoverage,
      renderProfile: request.renderProfile,
    };
  }

  function toSampledGridRangeRequest(intent) {
    const request = {
      dates: intent?.time?.dates || [],
      bbox: intent?.viewport?.bbox,
      datasetId: intent?.datasetId,
      limit: intent?.query?.limit,
      columns: intent?.query?.columns || DEFAULT_COLUMNS,
      anchorDate: intent?.time?.anchorDate,
      layerId: intent?.layerId,
      renderProfile: intent?.renderProfile,
      outsideCoverage: Boolean(intent?.viewport?.outsideCoverage),
      aoi: intent?.query?.aoi || "",
      resolution: intent?.query?.requestedResolutionKm,
      queryResolution: intent?.query?.effectiveQueryResolutionKm,
      zoom: intent?.viewport?.zoom,
      latitude: intent?.viewport?.center?.lat,
      mappingVersion: intent?.query?.mappingVersion || "",
    };
    const normalized = frameIdentity.normalizeRequest({
      ...request,
      date: request.anchorDate || request.dates[0] || "",
    });
    return {
      ...normalized,
      date: undefined,
      dates: request.dates,
      anchorDate: request.anchorDate,
      center: intent?.viewport?.center,
      outsideCoverage: request.outsideCoverage,
      renderProfile: request.renderProfile,
    };
  }

  return Object.freeze({
    range,
    snapshot,
    toSampledGridPacketRequest,
    toSampledGridRangeRequest,
    unlimitedLimit,
  });
}
