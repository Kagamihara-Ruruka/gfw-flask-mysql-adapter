function schedulePrimaryReload(delayMs = 0) {
  clearTimeout(state.primaryReloadTimer);
  state.primaryReloadTimer = setTimeout(() => {
    state.primaryReloadTimer = null;
    reloadActiveLayer();
  }, delayMs);
}

function invalidatePrimaryRenderForViewport({ lodChanging = false } = {}) {
  if (state.dataLayer === "gfw") {
    state.fetchSeq += 1;
    if (lodChanging) {
      clearGfwLayerForLodReload();
    } else {
      RenderState.loading("gfw", "視窗變更");
    }
    return;
  }
  if (state.dataLayer === "ais") {
    RenderState.loading("ais", lodChanging ? "LOD 變更" : "視窗變更");
  }
}

function invalidateEezRenderForZoom() {
  if (!$("eez-toggle").checked) return;
  state.eezSeq += 1;
  clearEezLayerForReload();
  RenderState.loading("eez", "縮放變更");
  TimingMetrics.setText("eez-ms", "載入中");
}

function bindMapRefresh() {
  let eezTimer = null;
  let primaryPrepared = false;
  let primaryLodPrepared = false;
  let eezZoomPrepared = false;

  function clearScheduledReloads() {
    clearTimeout(state.primaryReloadTimer);
    clearTimeout(eezTimer);
  }

  function preparePrimaryRender({ lodChanging = false } = {}) {
    if (state.isBootstrapping) return;
    clearScheduledReloads();
    if (lodChanging && !primaryLodPrepared) {
      primaryPrepared = true;
      primaryLodPrepared = true;
      invalidatePrimaryRenderForViewport({ lodChanging: true });
      return;
    }
    if (primaryPrepared) return;
    primaryPrepared = true;
    invalidatePrimaryRenderForViewport({ lodChanging: false });
  }

  function prepareEezZoomRender() {
    if (state.isBootstrapping || eezZoomPrepared) return;
    eezZoomPrepared = true;
    clearScheduledReloads();
    invalidateEezRenderForZoom();
  }

  function prepareViewportRender(event) {
    const lodChanging = isLodZoomEvent(event);
    preparePrimaryRender({ lodChanging });
    if (lodChanging) {
      prepareEezZoomRender();
    }
  }

  function scheduleViewportRender() {
    if (state.isBootstrapping) return;
    if (!primaryPrepared && !eezZoomPrepared) return;
    clearScheduledReloads();
    if (primaryPrepared && state.dataLayer) {
      schedulePrimaryReload(250);
    }
    if (eezZoomPrepared && $("eez-toggle").checked) {
      eezTimer = setTimeout(() => {
        reloadEezLayer().catch((err) => console.error("EEZ overlay failed", err));
      }, 900);
    }
    primaryPrepared = false;
    primaryLodPrepared = false;
    eezZoomPrepared = false;
  }

  map.on("movestart zoomstart", prepareViewportRender);
  map.on("moveend zoomend", scheduleViewportRender);
}
