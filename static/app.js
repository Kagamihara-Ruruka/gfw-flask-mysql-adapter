async function init() {
  try {
    await loadRenderCapability();
    syncHardwareSettingsControls();
    await loadDatasets();
    await loadSchema();
    await reloadActiveLayer();
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
  if (pageId !== "dashboard") {
    stopPlayback();
    return;
  }
  setTimeout(() => map.invalidateSize(), 60);
}

function bindPageTabs() {
  for (const button of document.querySelectorAll("[data-page-tab]")) {
    button.addEventListener("click", () => setActivePage(button.dataset.pageTab));
  }
}

function bindControls() {
  bindPageTabs();
  $("layer-gfw").addEventListener("change", () => selectDataLayer("gfw"));
  $("layer-ais").addEventListener("change", () => selectDataLayer("ais"));
  $("dataset-select")?.addEventListener("change", (event) => {
    selectDataset(event.target.value).catch((err) => setStatus(err.message, true));
  });
  bindDataLayerMenuDismiss();
  for (const button of document.querySelectorAll(".layer-settings-toggle")) {
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", toggleLayerSettings);
  }
  bindLayerOrderDrag();
  bindLayerAlphaControls();
  bindEezPaintControls();
  bindGfwPaintControls();
  bindMapSettingsControls();
  bindMapExportControls();
  bindLayerSettingsModalControls();
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
    stepDay(-1).catch((err) => setStatus(err.message, true));
  });
  $("next-day").addEventListener("click", () => {
    stopPlayback();
    stepDay(1).catch((err) => setStatus(err.message, true));
  });
  $("play-toggle").addEventListener("click", () => setPlayback(!state.isPlaying).catch((err) => setStatus(err.message, true)));
  $("play-speed").addEventListener("change", updatePlaybackSpeed);
  $("latest-date").addEventListener("click", () => jumpToLatestDate().catch((err) => setStatus(err.message, true)));
  $("map-fullscreen").addEventListener("click", () => {
    toggleMapFullscreen().catch((err) => setStatus(err.message, true));
  });
  ControlButtons.bindFeedback(["map-fullscreen"]);
  document.addEventListener("fullscreenchange", syncMapFullscreenButton);
  $("eez-toggle").addEventListener("change", () => {
    updateDataLayerMenu();
    if ($("eez-toggle").checked) {
      reloadEezLayer().catch((err) => console.error("EEZ overlay failed", err));
    } else {
      syncEezLayer();
    }
  });
  $("table-scroll").addEventListener("scroll", () => requestAnimationFrame(renderTableWindow));
}

function bindDeveloperBridge() {
  window.addEventListener("message", (event) => {
    if (event.data?.type !== "rrkal:layer-imports-changed") {
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
    loadDatasets()
      .then(() => loadSchema())
      .then(() => reloadActiveLayer())
      .catch((err) => setStatus(err.message, true));
  });
}

bindControls();
bindDeveloperBridge();
bindMapRefresh();
init();
