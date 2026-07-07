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
  syncBasemapAttribution();
  const pairs = [
    ["map-setting-scale", "scaleVisible"],
    ["map-setting-zoom-control", "zoomControlVisible"],
    ["map-setting-graticule", "graticuleVisible"],
    ["map-setting-graticule-labels", "graticuleLabels"],
    ["map-setting-scroll-wheel", "scrollWheelZoom"],
    ["map-setting-double-click", "doubleClickZoom"],
    ["map-setting-dragging", "dragging"],
    ["map-setting-keyboard", "keyboard"],
    ["map-setting-vignette", "vignetteVisible"],
  ];
  for (const [id, key] of pairs) {
    const input = $(id);
    if (input) input.checked = Boolean(state.mapSettings[key]);
  }
  syncMapVignetteControls();
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

function syncBasemapAttribution() {
  const attribution = $("map-basemap-attribution");
  if (!attribution) return;
  attribution.textContent = `底圖來源：${getCurrentBasemapAttribution()}`;
}

function syncMapVignetteControls() {
  const inset = $("map-setting-vignette-inset");
  const insetValue = $("map-setting-vignette-inset-value");
  const strength = $("map-setting-vignette-strength");
  const strengthValue = $("map-setting-vignette-strength-value");
  if (inset) {
    inset.value = String(state.mapSettings.vignetteInsetPct);
  }
  if (insetValue) {
    insetValue.textContent = `${state.mapSettings.vignetteInsetPct}%`;
  }
  if (strength) {
    strength.value = String(state.mapSettings.vignetteStrength);
  }
  if (strengthValue) {
    strengthValue.textContent = `${state.mapSettings.vignetteStrength}%`;
  }
}

function applyMapVignetteSettings() {
  const shell = $("map-shell");
  if (!shell) return;
  const insetPct = Math.max(0, Math.min(5, Number(state.mapSettings.vignetteInsetPct) || 0));
  const strength = Math.max(0, Math.min(100, Number(state.mapSettings.vignetteStrength) || 0));
  const strengthRatio = strength / 100;
  shell.classList.toggle("is-vignette-disabled", !state.mapSettings.vignetteVisible || strength <= 0);
  shell.style.setProperty("--map-edge-vignette-inset", `${insetPct}%`);
  shell.style.setProperty("--map-edge-vignette-alpha", String(0.08 + 0.36 * strengthRatio));
  shell.style.setProperty("--map-edge-vignette-soft-alpha", String(0.04 + 0.24 * strengthRatio));
  shell.style.setProperty("--map-edge-vignette-blur", `${0.45 + 1.9 * strengthRatio}rem`);
  shell.style.setProperty("--map-edge-vignette-soft-blur", `${0.16 + 0.52 * strengthRatio}rem`);
}

function bindMapSettingsControls() {
  const openButton = $("map-settings-open");
  const closeButton = $("map-settings-close");
  const modal = $("map-settings-modal");
  applyMapVignetteSettings();
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
    syncBasemapAttribution();
  });
  $("map-setting-scale")?.addEventListener("change", (event) => {
    setMapScaleVisible(event.target.checked);
  });
  $("map-setting-zoom-control")?.addEventListener("change", (event) => {
    setMapZoomControlVisible(event.target.checked);
  });
  $("map-setting-vignette")?.addEventListener("change", (event) => {
    state.mapSettings.vignetteVisible = event.target.checked;
    applyMapVignetteSettings();
  });
  $("map-setting-vignette-inset")?.addEventListener("input", (event) => {
    state.mapSettings.vignetteInsetPct = Number(event.target.value);
    syncMapVignetteControls();
    applyMapVignetteSettings();
  });
  $("map-setting-vignette-strength")?.addEventListener("input", (event) => {
    state.mapSettings.vignetteStrength = Number(event.target.value);
    syncMapVignetteControls();
    applyMapVignetteSettings();
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
