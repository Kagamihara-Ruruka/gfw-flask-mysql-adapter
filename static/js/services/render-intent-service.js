const RenderIntentService = (() => {
  const DEFAULT_COLUMNS = "render";

  function unlimitedLimit() {
    return state.queryPolicy?.max_limit == null ? "max" : Number(state.queryPolicy.max_limit);
  }

  function currentViewport() {
    const viewport = {
      bbox: currentBbox(),
      zoom: typeof map !== "undefined" && map ? map.getZoom() : null,
    };
    if (typeof map !== "undefined" && map?.getCenter) {
      viewport.center = map.getCenter();
    }
    return viewport;
  }

  function baseIntent({ layerId = state.dataLayer, renderProfile = "dashboard.snapshot" } = {}) {
    return {
      kind: "render_intent",
      version: 1,
      layerId,
      datasetId: state.datasetId,
      viewport: currentViewport(),
      query: {
        limit: unlimitedLimit(),
        columns: DEFAULT_COLUMNS,
      },
      renderProfile,
    };
  }

  function snapshot({
    date = $("date")?.value,
    layerId = state.dataLayer,
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
    anchorDate = $("date")?.value,
    layerId = state.dataLayer,
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

  function toGfwPacketRequest(intent) {
    return {
      datasetId: intent?.datasetId,
      date: intent?.time?.date,
      bbox: intent?.viewport?.bbox,
      limit: intent?.query?.limit,
      columns: intent?.query?.columns || DEFAULT_COLUMNS,
      center: intent?.viewport?.center,
      zoom: intent?.viewport?.zoom,
      layerId: intent?.layerId,
      renderProfile: intent?.renderProfile,
    };
  }

  function toGfwRangeRequest(intent) {
    return {
      dates: intent?.time?.dates || [],
      bbox: intent?.viewport?.bbox,
      datasetId: intent?.datasetId,
      limit: intent?.query?.limit,
      columns: intent?.query?.columns || DEFAULT_COLUMNS,
      anchorDate: intent?.time?.anchorDate,
      layerId: intent?.layerId,
      renderProfile: intent?.renderProfile,
    };
  }

  return {
    range,
    snapshot,
    toGfwPacketRequest,
    toGfwRangeRequest,
    unlimitedLimit,
  };
})();
