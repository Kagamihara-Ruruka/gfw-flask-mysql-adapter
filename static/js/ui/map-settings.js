function setMapSettingsModal(open) {
  const modal = $("map-settings-modal");
  if (!modal) return;
  modal.hidden = !open;
  const button = $("map-settings-open");
  if (button) {
    button.setAttribute("aria-expanded", String(Boolean(open)));
  }
}

function syncMapSettingsControls() {
  const basemapSelect = $("map-basemap-select");
  if (basemapSelect) {
    basemapSelect.value = state.mapSettings.basemapId;
  }
  const pairs = [
    ["map-setting-scale", "scaleVisible"],
    ["map-setting-zoom-control", "zoomControlVisible"],
    ["map-setting-graticule", "graticuleVisible"],
    ["map-setting-graticule-labels", "graticuleLabels"],
    ["map-setting-scroll-wheel", "scrollWheelZoom"],
    ["map-setting-double-click", "doubleClickZoom"],
    ["map-setting-dragging", "dragging"],
    ["map-setting-keyboard", "keyboard"],
  ];
  for (const [id, key] of pairs) {
    const input = $(id);
    if (input) input.checked = Boolean(state.mapSettings[key]);
  }
  const graticuleAlpha = $("map-setting-graticule-alpha");
  if (graticuleAlpha) {
    graticuleAlpha.value = String(state.mapSettings.graticuleAlpha);
  }
  const graticuleColor = $("map-setting-graticule-color");
  if (graticuleColor) {
    graticuleColor.value = state.mapSettings.graticuleColor;
  }
  const graticuleLineStyle = $("map-setting-graticule-line-style");
  if (graticuleLineStyle) {
    graticuleLineStyle.value = state.mapSettings.graticuleLineStyle;
  }
  const graticuleLineWidth = $("map-setting-graticule-line-width");
  if (graticuleLineWidth) {
    graticuleLineWidth.value = String(state.mapSettings.graticuleLineWidth);
  }
}

function bindMapSettingsControls() {
  const openButton = $("map-settings-open");
  const closeButton = $("map-settings-close");
  const modal = $("map-settings-modal");
  if (openButton) {
    openButton.addEventListener("click", (event) => {
      event.stopPropagation();
      syncMapSettingsControls();
      setMapSettingsModal(true);
    });
  }
  if (closeButton) {
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setMapSettingsModal(false);
    });
  }
  if (modal) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        setMapSettingsModal(false);
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setMapSettingsModal(false);
    }
  });

  $("map-basemap-select")?.addEventListener("change", (event) => {
    setBasemap(event.target.value);
  });
  $("map-setting-scale")?.addEventListener("change", (event) => {
    setMapScaleVisible(event.target.checked);
  });
  $("map-setting-zoom-control")?.addEventListener("change", (event) => {
    setMapZoomControlVisible(event.target.checked);
  });
  $("map-setting-graticule")?.addEventListener("change", (event) => {
    state.mapSettings.graticuleVisible = event.target.checked;
    syncGraticuleLayer();
  });
  $("map-setting-graticule-labels")?.addEventListener("change", (event) => {
    state.mapSettings.graticuleLabels = event.target.checked;
    syncGraticuleLayer();
  });
  $("map-setting-graticule-alpha")?.addEventListener("input", (event) => {
    state.mapSettings.graticuleAlpha = Number(event.target.value);
    syncGraticuleLayer();
  });
  $("map-setting-graticule-color")?.addEventListener("input", (event) => {
    state.mapSettings.graticuleColor = event.target.value;
    syncGraticuleLayer();
  });
  $("map-setting-graticule-line-style")?.addEventListener("change", (event) => {
    state.mapSettings.graticuleLineStyle = event.target.value;
    syncGraticuleLayer();
  });
  $("map-setting-graticule-line-width")?.addEventListener("input", (event) => {
    state.mapSettings.graticuleLineWidth = Number(event.target.value);
    syncGraticuleLayer();
  });
  $("map-setting-scroll-wheel")?.addEventListener("change", (event) => {
    setMapInteraction("scrollWheelZoom", event.target.checked);
  });
  $("map-setting-double-click")?.addEventListener("change", (event) => {
    setMapInteraction("doubleClickZoom", event.target.checked);
  });
  $("map-setting-dragging")?.addEventListener("change", (event) => {
    setMapInteraction("dragging", event.target.checked);
  });
  $("map-setting-keyboard")?.addEventListener("change", (event) => {
    setMapInteraction("keyboard", event.target.checked);
  });
  $("map-view-reset")?.addEventListener("click", resetMapView);
  $("map-view-world")?.addEventListener("click", fitWorldView);
  $("map-view-taiwan")?.addEventListener("click", fitTaiwanView);
}
