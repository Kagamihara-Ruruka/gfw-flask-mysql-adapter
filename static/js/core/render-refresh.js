function schedulePrimaryReload(delayMs = 0) {
  ClockDomain.monotonic.cancel(state.primaryReloadTimer);
  state.primaryReloadTimer = ClockDomain.monotonic.schedule(() => {
    state.primaryReloadTimer = null;
    reloadActiveLayer().catch((error) => {
      if (error?.name !== "AbortError") setStatus(error?.message || "圖層重新載入失敗", true);
    });
  }, delayMs);
}

function invalidatePrimaryRenderForViewport({ lodChanging = false } = {}) {
  if (typeof isSampledGridLayer === "function" && isSampledGridLayer(state.dataLayer)) {
    state.fetchSeq += 1;
    if (lodChanging) {
      clearSampledGridLayerForLodReload();
    } else {
      RenderState.loading(state.dataLayer, "視窗變更");
    }
    return;
  }
  if (state.dataLayer === "ais") {
    RenderState.loading("ais", lodChanging ? "LOD 變更" : "視窗變更");
  }
}

function invalidateEezRenderForZoom() {
  if (!$("eez-toggle")?.checked) return;
  if (markEezTilesUpdating("縮放更新")) return;
  RenderState.loading("eez", "縮放變更");
  TimingMetrics.setText("eez-ms", "載入中");
}

function bindMapRefresh() {
  let eezTimer = null;
  let primaryPrepared = false;
  let primaryLodPrepared = false;
  let eezZoomPrepared = false;

  function clearScheduledReloads() {
    ClockDomain.monotonic.cancel(state.primaryReloadTimer);
    ClockDomain.monotonic.cancel(eezTimer);
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
    if (eezZoomPrepared && $("eez-toggle")?.checked) {
      eezTimer = ClockDomain.monotonic.schedule(() => {
        refreshEezTileReadiness("縮放更新").catch((err) => console.error("EEZ overlay failed", err));
      }, 120);
    }
    primaryPrepared = false;
    primaryLodPrepared = false;
    eezZoomPrepared = false;
  }

  map.on("movestart zoomstart", prepareViewportRender);
  map.on("moveend zoomend", scheduleViewportRender);
}
