function layerItems() {
  return Array.from(document.querySelectorAll(".layer-item"));
}

function applyLayerOrder() {
  const baseZ = 520;
  const step = 50;
  const order = state.layerOrder.length ? state.layerOrder : ["gfw", "ais", "eez"];
  order.forEach((layerId, index) => {
    const pane = map.getPane(`${layerId}Pane`);
    if (!pane) return;
    // The first item in the selector is the top visual layer.
    pane.style.zIndex = String(baseZ + ((order.length - index) * step));
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
    const pane = map.getPane("eezPane");
    if (pane) {
      pane.style.opacity = String(state.layerAlpha.eez);
    }
  }
}

function bindLayerAlphaControls() {
  for (const input of document.querySelectorAll(".alpha-slider")) {
    const layerId = input.dataset.alphaLayer;
    if (!layerId) continue;
    input.value = String(state.layerAlpha[layerId] ?? Number(input.value));
    for (const eventName of ["click", "pointerdown", "mousedown", "touchstart", "dragstart"]) {
      input.addEventListener(eventName, (event) => event.stopPropagation());
    }
    input.addEventListener("input", () => {
      state.layerAlpha[layerId] = Number(input.value);
      applyLayerAlpha(layerId);
    });
  }
  for (const layerId of Object.keys(state.layerAlpha)) {
    applyLayerAlpha(layerId);
  }
}

function updateDataLayerMenu() {
  $("layer-gfw").checked = state.dataLayer === "gfw";
  $("layer-ais").checked = state.dataLayer === "ais";
  const labels = [];
  if (state.dataLayer === "gfw") labels.push("GFW");
  if (state.dataLayer === "ais") labels.push("AIS");
  if ($("eez-toggle").checked) labels.push("EEZ");
  $("data-layer-summary").textContent = labels.length ? labels.join(" + ") : "None";
  updatePlaybackControls();
  applyLayerOrder();
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
    gfw: ["GFW fishery grid", "Grid layer display controls."],
    ais: ["AIS vessel positions", "Live AIS source and display controls."],
    eez: ["EEZ boundary overlay", "Maritime boundary overlay controls."],
  };
  const [title, subtitle] = labels[layerId] || ["Layer Settings", "Configure the selected map layer."];
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
