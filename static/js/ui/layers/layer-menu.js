function layerItems() {
  return Array.from(document.querySelectorAll(".layer-item"));
}

function layerOptionsContainer() {
  return document.querySelector("[data-layer-options]") || document.querySelector(".data-layer-options");
}

function layerIdOf(contract) {
  return String(contract?.layer_id || "").trim().toLowerCase();
}

function layerContractById(layerId) {
  const id = String(layerId || "").trim().toLowerCase();
  return (state.layerContracts || []).find((contract) => layerIdOf(contract) === id) || null;
}

function layerLabel(layerId) {
  const contract = layerContractById(layerId);
  return contract?.label || contract?.source_label || String(layerId || "").toUpperCase();
}

function isImportedLayer(layerId) {
  const id = String(layerId || "").trim().toLowerCase();
  return Boolean(id && state.importedLayers?.[id]);
}

function isRelationalLayer(layerId) {
  const contract = layerContractById(layerId);
  return Boolean(contract?.capabilities?.relational_query || contract?.source_route_group === "database");
}

function isSampledGridLayer(layerId) {
  const contract = layerContractById(layerId);
  return Boolean(contract?.capabilities?.sampled_grid);
}

function isWebsocketLayer(layerId) {
  const contract = layerContractById(layerId);
  return Boolean(contract?.source_route_group === "websocket" || contract?.contract_group === "websocket");
}

function isSpatialLayer(layerId) {
  const contract = layerContractById(layerId);
  return Boolean(contract?.source_route_group === "spatial" || contract?.contract_group === "spatial");
}

function isPrimaryDataLayer(layerId) {
  if (isSampledGridLayer(layerId)) return true;
  return String(layerId || "").trim().toLowerCase() === "ais" && isWebsocketLayer(layerId);
}

function hasOverlayHandler(layerId) {
  return String(layerId || "").trim().toLowerCase() === "eez" && isSpatialLayer(layerId);
}

function hasLayerHandler(layerId) {
  return isPrimaryDataLayer(layerId) || hasOverlayHandler(layerId);
}

function layerInputId(layerId) {
  const id = String(layerId || "").trim().toLowerCase();
  return id === "eez" ? "eez-toggle" : `layer-${id}`;
}

function layerPaneNames(layerId) {
  const id = String(layerId || "").trim().toLowerCase();
  if (id === "eez") return ["eezPaneA", "eezPaneB"];
  if (id === "ais") return ["aisPane"];
  if (isSampledGridLayer(id)) return ["sampledGridPane"];
  return [`${id}Pane`];
}

function layerSettingsPanelKind(layerId) {
  const id = String(layerId || "").trim().toLowerCase();
  if (isSampledGridLayer(id)) return "sampled-grid";
  if (id === "ais" && isWebsocketLayer(id)) return "ais";
  if (id === "eez" && isSpatialLayer(id)) return "eez";
  return "";
}

function importedLayerContracts() {
  return (state.layerContracts || []).filter((contract) => isImportedLayer(layerIdOf(contract)));
}

function renderDataLayerMenu() {
  const container = layerOptionsContainer();
  if (!container) return;
  container.replaceChildren();
  const contracts = importedLayerContracts();
  if (!contracts.length) {
    const empty = document.createElement("div");
    empty.className = "layer-empty-state";
    empty.textContent = "No imported data layers";
    container.appendChild(empty);
    return;
  }
  for (const contract of contracts) {
    const layerId = layerIdOf(contract);
    const item = document.createElement("div");
    item.className = "layer-item";
    item.dataset.layerId = layerId;
    item.dataset.layerGroup = contract.source_route_group || contract.contract_group || "";
    item.dataset.layerImported = isImportedLayer(layerId) ? "1" : "0";

    const option = document.createElement("div");
    option.className = "layer-option";

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.title = "Drag to reorder layers";
    handle.textContent = "::";

    const label = document.createElement("label");
    label.className = "checkbox-row";

    const input = document.createElement("input");
    input.id = layerInputId(layerId);
    input.type = "checkbox";
    input.value = layerId;
    input.dataset.layerToggle = layerId;
    input.dataset.layerToggleKind = hasOverlayHandler(layerId) ? "overlay" : "primary";
    input.disabled = !hasLayerHandler(layerId);
    input.checked = hasOverlayHandler(layerId) ? state.overlayLayers?.[layerId] === true : state.dataLayer === layerId;

    const title = document.createElement("span");
    title.textContent = layerLabel(layerId);
    if (!hasLayerHandler(layerId)) {
      title.title = "Layer contract is imported, but this dashboard has no renderer for it yet.";
    }

    label.append(input, title);
    option.append(handle, label);

    const settingsPanelKind = layerSettingsPanelKind(layerId);
    if (settingsPanelKind && document.querySelector(`[data-layer-settings-panel="${settingsPanelKind}"]`)) {
      const settings = document.createElement("button");
      settings.className = "icon-button layer-settings-toggle layer-gear-button";
      settings.type = "button";
      settings.dataset.settingsLayer = layerId;
      settings.setAttribute("aria-label", `${layerLabel(layerId)} settings`);
      settings.setAttribute("aria-expanded", "false");
      settings.textContent = "\u2699";
      option.append(settings);
    }

    item.append(option);
    container.appendChild(item);
  }
  bindLayerOrderDrag();
}

function applyLayerOrder() {
  const baseZ = 520;
  const step = 50;
  const contractOrder = importedLayerContracts().map((contract) => layerIdOf(contract));
  const order = state.layerOrder.length ? state.layerOrder : contractOrder;
  order.forEach((layerId, index) => {
    const zIndex = String(baseZ + ((order.length - index) * step));
    for (const paneName of layerPaneNames(layerId)) {
      const pane = map.getPane(paneName);
      if (pane) {
        pane.style.zIndex = zIndex;
      }
    }
  });
}

function applyLayerAlpha(layerId) {
  const id = String(layerId || "").trim().toLowerCase();
  if (isSampledGridLayer(id) && state.gridLayer) {
    state.gridLayer.setRows(state.rows);
    return;
  }
  if (id === "ais" && state.aisLayer) {
    state.aisLayer.setRows(state.rows);
    return;
  }
  if (id === "eez") {
    for (const paneName of ["eezPaneA", "eezPaneB"]) {
      const pane = map.getPane(paneName);
      if (!pane) continue;
      pane.style.opacity = paneName === state.eezActivePane && $("eez-toggle")?.checked
        ? String(state.layerAlpha.eez)
        : "0";
    }
  }
}

function enforceImportedOverlayState() {
  if (!isImportedLayer("eez") && typeof syncEezLayer === "function") {
    state.overlayLayers.eez = false;
    syncEezLayer();
  }
}

function updateDataLayerMenu() {
  enforceImportedOverlayState();
  const pendingPrimaryLayer = !state.dataLayer && state.datasetId
    ? layerIdOf(state.datasets?.[state.datasetId])
    : null;
  const displayedPrimaryLayer = state.dataLayer || (
    pendingPrimaryLayer
    && isImportedLayer(pendingPrimaryLayer)
    && isPrimaryDataLayer(pendingPrimaryLayer)
      ? pendingPrimaryLayer
      : null
  );
  for (const input of document.querySelectorAll("[data-layer-toggle]")) {
    const layerId = input.dataset.layerToggle;
    input.checked = hasOverlayHandler(layerId)
      ? state.overlayLayers?.[layerId] === true
      : displayedPrimaryLayer === layerId;
    input.disabled = !hasLayerHandler(layerId);
  }
  const labels = [];
  if (displayedPrimaryLayer) labels.push(layerLabel(displayedPrimaryLayer));
  for (const contract of importedLayerContracts()) {
    const layerId = layerIdOf(contract);
    if (hasOverlayHandler(layerId) && $(layerInputId(layerId))?.checked) {
      labels.push(layerLabel(layerId));
    }
  }
  $("data-layer-summary").textContent = labels.length ? labels.join(" + ") : "沒有圖層";
  updatePlaybackControls();
  applyLayerOrder();
}

function bindDataLayerMenuDismiss() {
  const menu = $("data-layer-menu");
  if (!menu) return;

  const controls = menu.closest(".controls");
  const syncOpenState = () => {
    controls?.classList.toggle("has-open-layer-menu", menu.open);
  };
  menu.addEventListener("toggle", syncOpenState);
  syncOpenState();

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

function bindDataLayerControls() {
  const container = layerOptionsContainer();
  if (!container || container.dataset.layerControlsBound === "1") return;
  container.dataset.layerControlsBound = "1";
  container.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-layer-toggle]")) {
      return;
    }
    const layerId = input.dataset.layerToggle;
    if (input.dataset.layerToggleKind === "overlay") {
      state.overlayLayers[layerId] = input.checked;
      updateDataLayerMenu();
      if (layerId === "eez") {
        if (input.checked) {
          reloadEezLayer().catch((err) => console.error("EEZ overlay failed", err));
        } else {
          syncEezLayer();
        }
      }
      return;
    }
    if (!input.checked && String(state.dataLayer || "").toLowerCase() === layerId) {
      input.checked = true;
      const menu = $("data-layer-menu");
      if (menu) menu.open = false;
      return;
    }
    selectDataLayer(layerId).catch((err) => setStatus(err.message, true));
  });
  container.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".layer-settings-toggle") : null;
    if (!button) return;
    event.stopPropagation();
    toggleLayerSettings({ currentTarget: button });
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

  const contract = layerContractById(layerId);
  $("layer-settings-title").textContent = contract?.label || layerLabel(layerId);
  $("layer-settings-subtitle").textContent = contract?.detail || contract?.source_config_path || "";

  const panelKind = layerSettingsPanelKind(layerId);
  for (const panel of document.querySelectorAll("[data-layer-settings-panel]")) {
    panel.hidden = panel.dataset.layerSettingsPanel !== panelKind;
  }
  if (panelKind === "sampled-grid") {
    const alphaInput = document.querySelector('[data-layer-settings-panel="sampled-grid"] .alpha-slider');
    if (alphaInput) {
      if (state.layerAlpha[layerId] === undefined) {
        const defaultAlpha = Number(state.sampledGridPaint?.alpha ?? (alphaInput.defaultValue || alphaInput.value));
        state.layerAlpha[layerId] = Number.isFinite(defaultAlpha) ? defaultAlpha : 1;
      }
      alphaInput.dataset.alphaLayer = layerId;
      alphaInput.value = String(state.layerAlpha[layerId]);
    }
    if (typeof syncSampledGridPaintControls === "function") {
      syncSampledGridPaintControls(layerId);
    }
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
  return window.LayerActivationController.toggle(layerId);
}

function syncLayerOrderFromDom() {
  state.layerOrder = layerItems().map((item) => item.dataset.layerId).filter(Boolean);
  applyLayerOrder();
}

function bindLayerOrderDrag() {
  let draggedItem = null;
  for (const item of layerItems()) {
    if (item.dataset.layerOrderBound === "1") continue;
    item.dataset.layerOrderBound = "1";
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
