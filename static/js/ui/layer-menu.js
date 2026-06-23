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
  const targetId = button.dataset.settingsTarget;
  const panel = $(targetId);
  if (!panel) return;
  const isOpen = !panel.hidden;
  panel.hidden = isOpen;
  button.setAttribute("aria-expanded", String(!isOpen));
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
    item.draggable = true;
    item.addEventListener("dragstart", (event) => {
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
