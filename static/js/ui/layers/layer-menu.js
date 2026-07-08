function layerItems() {
  return Array.from(document.querySelectorAll(".layer-item"));
}

function applyLayerOrder() {
  const baseZ = 520;
  const step = 50;
  const order = state.layerOrder.length ? state.layerOrder : ["gfw", "ais", "eez"];
  order.forEach((layerId, index) => {
    // The first item in the selector is the top visual layer.
    const zIndex = String(baseZ + ((order.length - index) * step));
    const paneNames = layerId === "eez" ? ["eezPaneA", "eezPaneB"] : [`${layerId}Pane`];
    for (const paneName of paneNames) {
      const pane = map.getPane(paneName);
      if (pane) {
        pane.style.zIndex = zIndex;
      }
    }
  });
}

function applyLayerAlpha(layerId) {
  if (layerId === "gfw" && state.gridLayer) {
    state.gridLayer.setRows(state.rows);
    return;
  }
  if (layerId === "ais" && state.aisLayer) {
    state.aisLayer.setRows(state.rows);
    return;
  }
  if (layerId === "eez") {
    for (const paneName of ["eezPaneA", "eezPaneB"]) {
      const pane = map.getPane(paneName);
      if (!pane) continue;
      pane.style.opacity = paneName === state.eezActivePane && $("eez-toggle").checked
        ? String(state.layerAlpha.eez)
        : "0";
    }
  }
}

function isImportedLayer(layerId) {
  return state.importedLayers?.[layerId] !== false;
}

function setLayerItemAvailability(layerId, available) {
  const item = document.querySelector(`[data-layer-id="${layerId}"]`);
  if (item) {
    item.hidden = !available;
    item.classList.toggle("is-not-imported", !available);
  }
  const inputId = layerId === "eez" ? "eez-toggle" : `layer-${layerId}`;
  const input = $(inputId);
  if (input) {
    input.disabled = !available;
    if (!available) {
      input.checked = false;
    }
  }
}

function enforceImportedLayerState() {
  for (const layerId of ["gfw", "ais", "eez"]) {
    setLayerItemAvailability(layerId, isImportedLayer(layerId));
  }
  if (state.dataLayer && !isImportedLayer(state.dataLayer)) {
    const removedLayer = state.dataLayer;
    state.dataLayer = null;
    if (removedLayer === "gfw") {
      removeGfwLayer();
    }
    if (removedLayer === "ais") {
      removeAisLayer();
    }
  }
  if (!isImportedLayer("eez")) {
    syncEezLayer();
  }
}

function updateDataLayerMenu() {
  enforceImportedLayerState();
  $("layer-gfw").checked = isImportedLayer("gfw") && state.dataLayer === "gfw";
  $("layer-ais").checked = isImportedLayer("ais") && state.dataLayer === "ais";
  const labels = [];
  if (state.dataLayer === "gfw") labels.push("GFW");
  if (state.dataLayer === "ais") labels.push("AIS");
  if (isImportedLayer("eez") && $("eez-toggle").checked) labels.push("EEZ");
  $("data-layer-summary").textContent = labels.length ? labels.join(" + ") : "無";
  updatePlaybackControls();
  applyLayerOrder();
}

function bindDataLayerMenuDismiss() {
  const menu = $("data-layer-menu");
  if (!menu) return;

  document.addEventListener("click", (event) => {
    if (!menu.open || menu.contains(event.target)) return;
    menu.open = false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
    }
  });
}

function toggleLayerSettings(event) {
  const button = event.currentTarget;
  const layerId = button.dataset.settingsLayer;
  if (!layerId) return;
  setLayerSettingsModal(layerId, true);
  button.setAttribute("aria-expanded", "true");
}

function setLayerSettingsModal(layerId, open) {
  const modal = $("layer-settings-modal");
  if (!modal) return;
  modal.hidden = !open;
  if (!open) {
    for (const button of document.querySelectorAll(".layer-settings-toggle")) {
      button.setAttribute("aria-expanded", "false");
    }
    return;
  }

  const labels = {
    gfw: ["GFW 漁業網格", "網格圖層顯示控制。"],
    ais: ["AIS 船舶位置", "即時 AIS 來源與顯示控制。"],
    eez: ["EEZ 經濟海域邊界", "海事邊界圖層控制。"],
  };
  const [title, subtitle] = labels[layerId] || ["圖層設定", "調整所選地圖圖層。"];
  $("layer-settings-title").textContent = title;
  $("layer-settings-subtitle").textContent = subtitle;

  for (const panel of document.querySelectorAll("[data-layer-settings-panel]")) {
    panel.hidden = panel.dataset.layerSettingsPanel !== layerId;
  }
}

function bindLayerSettingsModalControls() {
  const modal = $("layer-settings-modal");
  const closeButton = $("layer-settings-close");
  if (closeButton) {
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setLayerSettingsModal(null, false);
    });
  }
  if (modal) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        setLayerSettingsModal(null, false);
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (typeof setAisConfigModal === "function") {
        setAisConfigModal(false);
      }
      setLayerSettingsModal(null, false);
    }
  });
}

async function selectDataLayer(layerId) {
  if (!["gfw", "ais"].includes(layerId)) {
    updateDataLayerMenu();
    return;
  }
  if (!isImportedLayer(layerId)) {
    updateDataLayerMenu();
    return;
  }
  stopPlayback();
  state.dataLayer = state.dataLayer === layerId ? null : layerId;
  updateDataLayerMenu();
  $("data-layer-menu").open = false;
  if (state.dataLayer !== "ais") {
    removeAisLayer();
  }
  if (state.dataLayer !== "gfw") {
    removeGfwLayer();
  }
  await reloadActiveLayer();
}

function syncLayerOrderFromDom() {
  state.layerOrder = layerItems().map((item) => item.dataset.layerId).filter(Boolean);
  applyLayerOrder();
}

function bindLayerOrderDrag() {
  let draggedItem = null;
  for (const item of layerItems()) {
    const handle = item.querySelector(".drag-handle");
    item.draggable = false;
    if (handle) {
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) => {
        draggedItem = item;
        item.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.dataset.layerId);
      });
    }
    for (const control of item.querySelectorAll("input, select, button, label, .layer-settings")) {
      control.addEventListener("click", (event) => event.stopPropagation());
      control.addEventListener("dragstart", (event) => event.stopPropagation());
    }
    item.addEventListener("dragstart", (event) => {
      if (event.target !== handle) {
        event.preventDefault();
        return;
      }
      draggedItem = item;
      item.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.dataset.layerId);
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("is-dragging");
      draggedItem = null;
      syncLayerOrderFromDom();
    });
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!draggedItem || draggedItem === item) return;
      const rect = item.getBoundingClientRect();
      const after = event.clientY > rect.top + (rect.height / 2);
      item.parentElement.insertBefore(draggedItem, after ? item.nextSibling : item);
    });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      syncLayerOrderFromDom();
    });
  }
  syncLayerOrderFromDom();
}
