async function init() {
  try {
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
  for (const button of document.querySelectorAll(".layer-settings-toggle")) {
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", toggleLayerSettings);
  }
  bindLayerOrderDrag();
  bindLayerAlphaControls();
  $("ais-render-strategy").addEventListener("change", () => {
    if (state.dataLayer === "ais") {
      reloadActiveLayer();
    }
  });
  $("start-date").addEventListener("change", () => normalizeDateInputs());
  $("end-date").addEventListener("change", () => normalizeDateInputs());
  $("date").addEventListener("change", () => normalizeDateInputs());
  $("replay").addEventListener("click", replayFromStart);
  $("prev-day").addEventListener("click", () => {
    stopPlayback();
    stepDay(-1);
  });
  $("next-day").addEventListener("click", () => {
    stopPlayback();
    stepDay(1);
  });
  $("play-toggle").addEventListener("click", () => setPlayback(!state.isPlaying));
  $("play-speed").addEventListener("change", updatePlaybackSpeed);
  $("reload").addEventListener("click", reloadActiveLayer);
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

function bindMapRefresh() {
  let moveTimer = null;
  let eezMoveTimer = null;
  map.on("moveend", () => {
    if (state.isBootstrapping) return;
    clearTimeout(moveTimer);
    clearTimeout(eezMoveTimer);
    moveTimer = setTimeout(() => {
      reloadActiveLayer();
    }, 250);
    eezMoveTimer = setTimeout(() => {
      reloadEezLayer().catch((err) => console.error("EEZ overlay failed", err));
    }, 900);
  });
}

bindControls();
bindMapRefresh();
init();
