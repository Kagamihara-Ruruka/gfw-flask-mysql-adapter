async function init() {
  try {
    const renderCapability = await loadRenderCapability();
    window.aerialBackdropController?.configure(renderCapability?.server?.aerial_backdrop);
    syncHardwareSettingsControls();
    await loadDatasets();
    await window.LayerActivationController.reconcile({ reload: true, reason: "bootstrap" });
    state.isBootstrapping = false;
    if (state.importedLayers?.eez !== false && $("eez-toggle")?.checked) {
      reloadEezLayer().catch((err) => console.error("EEZ overlay failed", err));
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

let pendingFullscreenBounds = null;
let mapResizeObserver = null;
let mapResizeFrame = null;
let mapResizeEezTimer = null;
let lastMapContainerSize = null;

function scheduleEezResizeReload(reason) {
  if (state.isBootstrapping || !$("eez-toggle")?.checked || typeof reloadEezLayer !== "function") return;
  clearTimeout(mapResizeEezTimer);
  mapResizeEezTimer = setTimeout(() => {
    refreshEezTileReadiness(reason).catch((err) => console.error("EEZ overlay failed", err));
  }, 120);
}

function applyMapContainerSize(reason = "尺寸更新", { force = false } = {}) {
  const shell = $("map-shell");
  if (!shell) return false;
  const rect = shell.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const nextSize = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  if (!force && nextSize === lastMapContainerSize) return false;
  lastMapContainerSize = nextSize;
  map.invalidateSize({ animate: false, pan: false });
  scheduleEezResizeReload(reason);
  return true;
}

function flushMapContainerSize(reason = "尺寸更新", { force = true } = {}) {
  if (mapResizeFrame !== null) {
    cancelAnimationFrame(mapResizeFrame);
    mapResizeFrame = null;
  }
  return applyMapContainerSize(reason, { force });
}

function syncMapContainerSize(reason = "尺寸更新", { force = false } = {}) {
  const shell = $("map-shell");
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const nextSize = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  if (!force && nextSize === lastMapContainerSize) return;
  if (mapResizeFrame !== null) cancelAnimationFrame(mapResizeFrame);
  mapResizeFrame = requestAnimationFrame(() => {
    mapResizeFrame = null;
    applyMapContainerSize(reason, { force });
  });
}

function bindMapContainerResize() {
  const shell = $("map-shell");
  if (!shell || mapResizeObserver) return;
  if (typeof ResizeObserver === "function") {
    mapResizeObserver = new ResizeObserver(() => syncMapContainerSize());
    mapResizeObserver.observe(shell);
  }
  window.addEventListener("resize", () => syncMapContainerSize());
  syncMapContainerSize("初始化尺寸");
}

async function toggleMapFullscreen() {
  const shell = $("map-shell");
  pendingFullscreenBounds = map.getBounds();
  if (!document.fullscreenElement) {
    await shell.requestFullscreen();
  } else if (document.fullscreenElement === shell) {
    await document.exitFullscreen();
  }
}

function syncMapFullscreenButton() {
  const active = document.fullscreenElement === $("map-shell");
  ControlButtons.setIcon(
    "map-fullscreen",
    active ? "minimize-2" : "maximize-2",
    active ? "×" : "⛶",
    active ? "退出地圖全螢幕" : "地圖全螢幕",
  );
  $("map-settings-open").hidden = active;
  if (active && typeof setMapSettingsModal === "function") {
    setMapSettingsModal(false);
  }
  setTimeout(() => {
    map.invalidateSize();
    if (pendingFullscreenBounds) {
      map.fitBounds(pendingFullscreenBounds, {
        animate: false,
        padding: [0, 0],
      });
      pendingFullscreenBounds = null;
    }
  }, 80);
}

function setActivePage(pageId) {
  for (const button of document.querySelectorAll("[data-page-tab]")) {
    const active = button.dataset.pageTab === pageId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of document.querySelectorAll("[data-page-panel]")) {
    const active = panel.dataset.pagePanel === pageId;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  if (pageId === "developer") {
    const frame = $("developer-control-frame");
    const source = frame?.dataset.src;
    if (frame && source && !frame.hasAttribute("src")) {
      frame.src = source;
    }
  }
  if (pageId !== "dashboard") {
    stopPlayback();
    return;
  }
  setTimeout(() => syncMapContainerSize("頁籤切換", { force: true }), 60);
}

function bindPageTabs() {
  for (const button of document.querySelectorAll("[data-page-tab]")) {
    button.addEventListener("click", () => setActivePage(button.dataset.pageTab));
  }
}

function bindControls() {
  bindPageTabs();
  $("dataset-select")?.addEventListener("change", (event) => {
    selectDataset(event.target.value).catch((err) => setStatus(err.message, true));
  });
  $("sampled-grid-aoi")?.addEventListener("change", (event) => {
    selectSampledGridAoi(event.target.value).catch((err) => setStatus(err.message, true));
  });
  bindDataLayerMenuDismiss();
  bindDataLayerControls();
  bindLayerAlphaControls();
  bindEezPaintControls();
  bindSampledGridPaintControls();
  bindMapSettingsControls();
  bindMapExportControls();
  bindLayerSettingsModalControls();
  bindMapContainerResize();
  bindAisSettingsControls();
  bindPlaybackControlFeedback();
  bindFullscreenPlaybackControls();
  bindHardwareSettingsControls();
  bindPlaybackSettingsControls();
  if (typeof bindDeveloperConfigControls === "function") {
    bindDeveloperConfigControls();
  }
  RenderState.sync();
  $("ais-render-strategy").addEventListener("change", () => {
    if (state.dataLayer === "ais") {
      reloadActiveLayer();
    }
  });
  $("start-date").addEventListener("change", () => normalizeDateInputs().catch((err) => setStatus(err.message, true)));
  $("end-date").addEventListener("change", () => normalizeDateInputs().catch((err) => setStatus(err.message, true)));
  $("date").addEventListener("change", () => normalizeDateInputs().catch((err) => setStatus(err.message, true)));
  $("replay").addEventListener("click", () => replayFromStart().catch((err) => setStatus(err.message, true)));
  $("prev-day").addEventListener("click", () => {
    stopPlayback();
    stepDay(-1, "往前一日").catch((err) => setStatus(err.message, true));
  });
  $("next-day").addEventListener("click", () => {
    stopPlayback();
    stepDay(1, "往後一日").catch((err) => setStatus(err.message, true));
  });
  $("play-toggle").addEventListener("click", () => setPlayback(!playbackIsActive()).catch((err) => setStatus(err.message, true)));
  $("play-speed").addEventListener("change", updatePlaybackSpeed);
  $("latest-date").addEventListener("click", () => jumpToLatestDate().catch((err) => setStatus(err.message, true)));
  $("map-fullscreen").addEventListener("click", () => {
    toggleMapFullscreen().catch((err) => setStatus(err.message, true));
  });
  ControlButtons.bindFeedback(["map-fullscreen"]);
  document.addEventListener("fullscreenchange", syncMapFullscreenButton);
  $("table-scroll").addEventListener("scroll", () => requestAnimationFrame(renderTableWindow));
}

let datasetRegistryRefresh = null;

function datasetRegistrySignature() {
  return JSON.stringify({
    datasets: state.datasets || {},
    layers: state.layerContracts || [],
    importedLayerIds: [...(state.importedLayerIds || [])].sort(),
  });
}

async function refreshDatasetRegistry() {
  if (datasetRegistryRefresh || state.isBootstrapping) {
    return datasetRegistryRefresh;
  }
  datasetRegistryRefresh = (async () => {
    const before = datasetRegistrySignature();
    await loadDatasets();
    if (datasetRegistrySignature() === before) {
      return;
    }
    await window.LayerActivationController.reconcile({ reload: true, reason: "registry_changed" });
  })();
  try {
    await datasetRegistryRefresh;
  } finally {
    datasetRegistryRefresh = null;
  }
}

function bindDeveloperBridge() {
  window.addEventListener("message", (event) => {
    if (!["rrkal:layer-imports-changed", "rrkal:source-registry-changed"].includes(event.data?.type)) {
      return;
    }
    try {
      const origin = new URL(event.origin);
      if (origin.hostname !== window.location.hostname) {
        return;
      }
    } catch {
      return;
    }
    refreshDatasetRegistry().catch((err) => setStatus(err.message, true));
  });
  window.addEventListener("focus", () => {
    if (!document.hidden) {
      refreshDatasetRegistry().catch((err) => setStatus(err.message, true));
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      PlaybackPreheater?.stop?.("document_hidden");
      stopPlayback({ reason: "document_hidden" });
      return;
    }
    refreshDatasetRegistry().catch((err) => setStatus(err.message, true));
  });
}

bindControls();
bindDeveloperBridge();
bindMapRefresh();
init();
