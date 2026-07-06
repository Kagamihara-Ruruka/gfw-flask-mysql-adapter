async function init() {
  try {
    await loadRenderCapability();
    await loadDatasets();
    await loadSchema();
    await reloadActiveLayer();
    state.isBootstrapping = false;
    reloadEezLayer().catch((err) => console.error("EEZ overlay failed", err));
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
  $("map-fullscreen").textContent = active ? "Exit" : "Full";
  $("map-fullscreen").title = active ? "Exit fullscreen map" : "Fullscreen map";
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

function bindControls() {
  $("layer-gfw").addEventListener("change", () => selectDataLayer("gfw"));
  $("layer-ais").addEventListener("change", () => selectDataLayer("ais"));
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

bindControls();
bindMapRefresh();
init();
