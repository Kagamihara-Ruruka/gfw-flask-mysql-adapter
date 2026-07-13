class SampledGridCellHitTester {
  constructor({ targetMap } = {}) {
    this.map = targetMap;
  }

  dataset() {
    return state?.datasets?.[state.datasetId] || {};
  }

  model() {
    return SampledGridContract.model(state.datasetId);
  }

  cellBounds(bounds) {
    const normalized = {
      west: Number(bounds?.west),
      south: Number(bounds?.south),
      east: Number(bounds?.east),
      north: Number(bounds?.north),
    };
    if (!Object.values(normalized).every(Number.isFinite)) return null;
    if (normalized.west >= normalized.east || normalized.south >= normalized.north) return null;
    return {
      ...normalized,
      leaflet: L.latLngBounds(
        [normalized.south, normalized.west],
        [normalized.north, normalized.east],
      ),
    };
  }

  bboxString(bounds) {
    return [bounds.west, bounds.south, bounds.east, bounds.north]
      .map((value) => value.toFixed(6))
      .join(",");
  }

  cellForHit(hit) {
    const row = hit?.row;
    if (!row) return null;
    const model = this.model();
    const bounds = this.cellBounds(hit.bounds || model.bounds(row));
    if (!bounds) return null;
    const metricValue = model.value(row);
    const resolutionKm = model.resolutionKm(row);
    const bboxString = this.bboxString(bounds);
    return {
      selection_type: "data_cell",
      source_layer: state.dataLayer,
      dataset_id: state.datasetId,
      date: row.date || $("date")?.value || null,
      tile_key: bboxString,
      label: `cell ${bboxString}`,
      identity: row.cell_id == null ? null : { column: "cell_id", value: row.cell_id },
      metric: {
        column: "value",
        value: metricValue,
      },
      center: { ...hit.center },
      bounds,
      bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
      bbox_string: bboxString,
      granularity: "sampled_grid_cell",
      resolution_km: resolutionKm,
      data_status: row.data_status || "observed",
      source_rows: Number(row.source_rows || 1),
    };
  }

  virtualCellForEvent(event) {
    if (!event?.latlng) return null;
    const model = this.model();
    if (!model.enabled) return null;
    const resolutionKm = model.resolutionKm()
      || SampledGridContract.requestResolution({
        datasetId: state.datasetId,
        zoom: this.map?.getZoom?.(),
        latitude: event.latlng.lat,
      });
    const virtualCell = model.cellAt(
      event.latlng.lat,
      normalizeLongitude(event.latlng.lng),
      resolutionKm,
    );
    const bounds = this.cellBounds(virtualCell?.bounds);
    if (!bounds) return null;
    const bboxString = this.bboxString(bounds);
    return {
      selection_type: "virtual_cell",
      source_layer: state.dataLayer,
      dataset_id: state.datasetId,
      date: $("date")?.value || state.renderedSampledGridDate || null,
      tile_key: bboxString,
      label: `cell ${bboxString}`,
      identity: null,
      metric: {
        column: "value",
        value: null,
      },
      center: { ...virtualCell.center },
      bounds,
      bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
      bbox_string: bboxString,
      granularity: "sampled_grid_cell",
      resolution_km: virtualCell.resolution_km,
      data_status: "no_data",
      source_rows: 0,
    };
  }

  cellForEvent(event) {
    const hit = state?.gridLayer?.hitTest?.(event.containerPoint);
    return this.cellForHit(hit) || this.virtualCellForEvent(event);
  }
}

class SameTimeLocationLabel {
  descriptors(cells) {
    return cells.map((cell, index) => ({
      key: cell.tile_key,
      center: cell.bounds.leaflet.getCenter(),
      icon: L.divIcon({
        className: "tile-selection-live-location-icon",
        html: `<span>${index + 1}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }));
  }
}

class LockedTimeLocationLabel {
  descriptors(cells) {
    const groups = new Map();
    cells.forEach((cell, index) => {
      const group = groups.get(cell.tile_key) || { cell, numbers: [] };
      group.numbers.push(index + 1);
      groups.set(cell.tile_key, group);
    });
    return [...groups.entries()].map(([tileKey, group]) => ({
      key: tileKey,
      center: group.cell.bounds.leaflet.getCenter(),
      icon: L.divIcon({
        className: "tile-selection-locked-time-icon",
        html: `<span>${group.numbers.join(",")}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }));
  }
}

const TileSelectionLabelStrategies = Object.freeze({
  same_time_location: Object.freeze(new SameTimeLocationLabel()),
  locked_time_location: Object.freeze(new LockedTimeLocationLabel()),
});

const TileSelectionModeRegistry = Object.freeze({
  single: Object.freeze({
    id: "single",
    label: "單點模式",
    multiple: false,
    timeBinding: "live_player",
    labelStrategy: null,
  }),
  same_time_multi_location: Object.freeze({
    id: "same_time_multi_location",
    label: "同時異地模式",
    multiple: true,
    timeBinding: "live_player",
    labelStrategy: "same_time_location",
  }),
  multi_time_multi_location: Object.freeze({
    id: "multi_time_multi_location",
    label: "異時異地模式",
    multiple: true,
    timeBinding: "locked_axis",
    labelStrategy: "locked_time_location",
  }),
});

class ContinuousTileSelectionDrawer {
  constructor({ button, onEnabledChange, onModeChange, onClear } = {}) {
    this.button = button;
    this.onEnabledChange = onEnabledChange;
    this.onModeChange = onModeChange;
    this.onClear = onClear;
    this.root = this.render();
    document.getElementById("map-shell")?.append(this.root);
    this.bindOutsideClose();
  }

  render() {
    const root = document.createElement("section");
    root.className = "tile-selection-drawer";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "連續網格選取模式");

    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "連續網格選取";
    this.count = document.createElement("output");
    this.count.className = "tile-selection-count";
    this.count.setAttribute("aria-label", "已儲存 Tile 數量");
    this.count.textContent = "0";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "tile-selection-drawer-close";
    closeButton.setAttribute("aria-label", "關閉網格選取設定");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    header.append(title, this.count, closeButton);

    const enabledRow = document.createElement("label");
    enabledRow.className = "tile-selection-enable-row";
    const enabledLabel = document.createElement("span");
    enabledLabel.textContent = "啟用連續選取";
    this.enabledInput = document.createElement("input");
    this.enabledInput.type = "checkbox";
    this.enabledInput.setAttribute("role", "switch");
    this.enabledInput.addEventListener("change", () => {
      this.onEnabledChange?.(this.enabledInput.checked);
    });
    enabledRow.append(enabledLabel, this.enabledInput);

    const modes = document.createElement("div");
    modes.className = "tile-selection-mode-control";
    modes.setAttribute("role", "radiogroup");
    modes.setAttribute("aria-label", "連續選取模式");
    this.modeButtons = new Map();
    Object.values(TileSelectionModeRegistry)
      .filter((definition) => definition.multiple)
      .forEach((definition) => modes.append(this.renderModeButton(definition)));

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "tile-selection-clear-button";
    clearButton.textContent = "清除所有儲存 Tile 標籤";
    clearButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onClear?.();
    });
    root.append(header, enabledRow, modes, clearButton);
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    return root;
  }

  renderModeButton(definition) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tile-selection-mode-button";
    button.dataset.tileSelectionMode = definition.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.textContent = definition.label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onModeChange?.(definition.id);
    });
    this.modeButtons.set(definition.id, button);
    return button;
  }

  bindOutsideClose() {
    document.addEventListener("pointerdown", (event) => {
      if (this.root.hidden) return;
      if (this.root.contains(event.target) || this.button?.contains(event.target)) return;
      this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
  }

  open() {
    this.root.hidden = false;
    this.button?.setAttribute("aria-expanded", "true");
  }

  close() {
    this.root.hidden = true;
    this.button?.setAttribute("aria-expanded", "false");
  }

  toggle() {
    if (this.root.hidden) this.open();
    else this.close();
  }

  sync({ enabled, mode, count } = {}) {
    const continuousActive = Boolean(enabled && TileSelectionModeRegistry[mode]?.multiple);
    this.enabledInput.checked = continuousActive;
    this.count.textContent = String(Number(count || 0));
    this.modeButtons.forEach((button, id) => {
      const active = id === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
  }
}

class TileSelectionLayer {
  constructor({ targetMap, singleButton, continuousButton, hitTester = null } = {}) {
    this.map = targetMap;
    this.singleButton = singleButton;
    this.continuousButton = continuousButton;
    this.hitTester = hitTester || new SampledGridCellHitTester({ targetMap });
    this.enabled = false;
    this.mode = "single";
    this.selectedCell = null;
    this.selectedCells = [];
    this.selectionRectangles = new Map();
    this.selectionLabels = new Map();
    this.boundClick = (event) => this.handleClick(event);
    this.boundRefresh = () => this.refreshSelectedCell();
    const initialState = this.ensureState();
    this.mode = initialState?.mode || "single";
    this.lastContinuousMode = TileSelectionModeRegistry[this.mode]?.multiple
      ? this.mode
      : "same_time_multi_location";
    this.ensurePane();
    this.continuousDrawer = new ContinuousTileSelectionDrawer({
      button: this.continuousButton,
      onEnabledChange: (enabled) => this.setContinuousEnabled(enabled),
      onModeChange: (mode) => this.setMode(mode),
      onClear: () => this.clearAllSelections(),
    });
    this.bindEntrypoints();
    this.syncButton();
  }

  ensureState() {
    if (typeof state === "undefined") return null;
    state.tileSelection = state.tileSelection || {
      enabled: false,
      mode: "single",
      hover: null,
      selected: null,
      items: [],
    };
    if (!TileSelectionModeRegistry[state.tileSelection.mode]) {
      state.tileSelection.mode = "single";
    }
    if (!Array.isArray(state.tileSelection.items)) {
      state.tileSelection.items = [];
    }
    return state.tileSelection;
  }

  status(message, isError = false) {
    if (typeof setStatus === "function") {
      setStatus(message, isError);
    }
  }

  ensurePane() {
    if (!this.map || this.map.getPane("tileSelectionPane")) return;
    this.map.createPane("tileSelectionPane");
    const pane = this.map.getPane("tileSelectionPane");
    pane.style.zIndex = "690";
    pane.style.pointerEvents = "none";
  }

  bindEntrypoints() {
    this.singleButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.continuousDrawer.close();
      const singleActive = this.enabled && !TileSelectionModeRegistry[this.mode]?.multiple;
      if (singleActive) this.setEnabled(false);
      else this.setMode("single");
    });
    if (this.continuousButton) {
      this.continuousButton.setAttribute("aria-haspopup", "dialog");
      this.continuousButton.setAttribute("aria-expanded", "false");
      this.continuousButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.continuousDrawer.toggle();
      });
    }
    if (typeof ControlButtons !== "undefined") {
      ControlButtons.bindFeedback(
        [this.singleButton?.id, this.continuousButton?.id].filter(Boolean),
      );
    }
  }

  publicCell(cell) {
    if (!cell) return null;
    const timeAxis = this.resolvedTimeAxis(cell);
    return {
      selection_id: cell.selection_id,
      selection_type: cell.selection_type,
      source_layer: cell.source_layer,
      dataset_id: cell.dataset_id,
      date: timeAxis.cursor || cell.date,
      tile_key: cell.tile_key,
      label: cell.label,
      identity: cell.identity ? { ...cell.identity } : null,
      metric: cell.metric ? { ...cell.metric } : null,
      center: cell.center ? { ...cell.center } : null,
      bbox: [...cell.bbox],
      bbox_string: cell.bbox_string,
      granularity: cell.granularity,
      resolution_km: cell.resolution_km,
      data_status: cell.data_status,
      source_rows: cell.source_rows,
      time_binding: cell.time_binding ? {
        kind: cell.time_binding.kind,
        axis_hash: cell.time_binding.axis_hash || null,
        axis: cell.time_binding.axis ? { ...cell.time_binding.axis } : null,
      } : null,
      time_axis: timeAxis,
    };
  }

  currentTimeAxis() {
    const start = document.getElementById("start-date")?.value || null;
    const end = document.getElementById("end-date")?.value || null;
    const cursor = document.getElementById("date")?.value || null;
    return { start, end, cursor };
  }

  timeAxisHash(axis) {
    return [axis?.start || "", axis?.end || "", axis?.cursor || ""].join("|");
  }

  timeBindingForMode(mode = this.mode) {
    const definition = TileSelectionModeRegistry[mode] || TileSelectionModeRegistry.single;
    if (definition.timeBinding !== "locked_axis") {
      return { kind: "live_player", axis_hash: null, axis: null };
    }
    const axis = this.currentTimeAxis();
    return {
      kind: "locked_axis",
      axis_hash: this.timeAxisHash(axis),
      axis,
    };
  }

  resolvedTimeAxis(cell) {
    if (cell?.time_binding?.kind === "locked_axis" && cell.time_binding.axis) {
      return { ...cell.time_binding.axis };
    }
    return this.currentTimeAxis();
  }

  prepareCell(cell, mode = this.mode) {
    const timeBinding = this.timeBindingForMode(mode);
    const selectionId = timeBinding.kind === "locked_axis"
      ? `${cell.tile_key}|${timeBinding.axis_hash}`
      : cell.tile_key;
    return {
      ...cell,
      selection_id: selectionId,
      time_binding: timeBinding,
    };
  }

  snapshot() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      hover: null,
      selected: this.publicCell(this.selectedCell),
      items: this.selectedCells.map((cell) => this.publicCell(cell)),
    };
  }

  selected() {
    return this.publicCell(this.selectedCell);
  }

  selections() {
    return this.selectedCells.map((cell) => this.publicCell(cell));
  }

  emitChange(reason) {
    this.ensureState();
    if (typeof state !== "undefined") {
      state.tileSelection.enabled = this.enabled;
      state.tileSelection.mode = this.mode;
      state.tileSelection.hover = null;
      state.tileSelection.selected = this.publicCell(this.selectedCell);
      state.tileSelection.items = this.selectedCells.map((cell) => this.publicCell(cell));
    }
    window.dispatchEvent(new CustomEvent("rrkal:tile-selection-changed", {
      detail: { reason, ...this.snapshot() },
    }));
  }

  clearSelection() {
    this.selectedCell = null;
    this.selectedCells = [];
    this.selectionRectangles.forEach((rectangle) => {
      if (this.map?.hasLayer(rectangle)) this.map.removeLayer(rectangle);
    });
    this.selectionRectangles.clear();
    this.selectionLabels.forEach((label) => {
      if (this.map?.hasLayer(label)) this.map.removeLayer(label);
    });
    this.selectionLabels.clear();
    this.syncDrawer();
  }

  clearAllSelections() {
    this.clearSelection();
    this.status("已清除所有儲存 Tile 標籤");
    this.emitChange("cleared");
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    if (this.enabled) {
      this.map?.on("click", this.boundClick);
      this.map?.on("zoomend moveend", this.boundRefresh);
      this.status("網格選取模式：點擊取樣網格");
    } else {
      this.map?.off("click", this.boundClick);
      this.map?.off("zoomend moveend", this.boundRefresh);
      this.clearSelection();
      this.status("網格選取模式已關閉");
    }
    document.getElementById("map-shell")?.classList.toggle("is-tile-selection-enabled", this.enabled);
    this.syncButton();
    this.emitChange(this.enabled ? "enabled" : "disabled");
  }

  setMode(mode) {
    const definition = TileSelectionModeRegistry[mode];
    if (!definition) {
      this.syncButton();
      return;
    }
    if (mode === this.mode) {
      if (!this.enabled) this.setEnabled(true);
      else this.syncButton();
      return;
    }
    this.mode = mode;
    if (definition.multiple) this.lastContinuousMode = mode;
    this.rebindSelectionsForMode();
    if (!this.enabled) this.setEnabled(true);
    this.status(`網格選取：${TileSelectionModeRegistry[this.mode].label}`);
    this.syncButton();
    this.emitChange("mode_changed");
  }

  setContinuousEnabled(enabled) {
    if (enabled) {
      this.setMode(this.lastContinuousMode);
      return;
    }
    if (this.enabled && TileSelectionModeRegistry[this.mode]?.multiple) {
      this.setEnabled(false);
      return;
    }
    this.syncButton();
  }

  rebindSelectionsForMode() {
    let cells = [...this.selectedCells];
    if (!TileSelectionModeRegistry[this.mode].multiple && cells.length > 1) {
      cells = [this.selectedCell || cells[cells.length - 1]].filter(Boolean);
    }
    const rebound = new Map();
    cells.forEach((cell) => {
      const next = this.prepareCell(cell, this.mode);
      rebound.set(next.selection_id, next);
    });
    this.selectedCells = [...rebound.values()];
    this.selectedCell = this.selectedCells[this.selectedCells.length - 1] || null;
    this.syncSelectionRectangles();
  }

  syncButton() {
    const multiple = Boolean(TileSelectionModeRegistry[this.mode]?.multiple);
    const singleActive = this.enabled && !multiple;
    const continuousActive = this.enabled && multiple;
    if (this.singleButton) {
      this.singleButton.classList.toggle("is-active", singleActive);
      this.singleButton.setAttribute("aria-pressed", singleActive ? "true" : "false");
      this.singleButton.title = singleActive ? "關閉單點網格選取" : "單點網格選取";
      this.singleButton.setAttribute("aria-label", this.singleButton.title);
    }
    if (this.continuousButton) {
      this.continuousButton.classList.toggle("is-active", continuousActive);
      this.continuousButton.setAttribute("aria-pressed", continuousActive ? "true" : "false");
      this.continuousButton.title = "連續網格選取設定";
      this.continuousButton.setAttribute("aria-label", this.continuousButton.title);
    }
    this.syncDrawer();
    if (typeof ControlButtons !== "undefined") {
      ControlButtons.renderIcons?.();
    }
  }

  syncDrawer() {
    this.continuousDrawer?.sync({
      enabled: this.enabled,
      mode: this.mode,
      count: this.selectedCells.length,
    });
  }

  createSelectionRectangle(cell) {
    return L.rectangle(cell.bounds.leaflet, {
        pane: "tileSelectionPane",
        interactive: false,
        color: "#f8fafc",
        weight: 2.2,
        opacity: 1,
        fillColor: "#ffffff",
        fillOpacity: 0,
      }).addTo(this.map);
  }

  syncSelectionLabels() {
    const strategyId = TileSelectionModeRegistry[this.mode].labelStrategy;
    const strategy = TileSelectionLabelStrategies[strategyId] || null;
    const descriptors = strategy?.descriptors(this.selectedCells) || [];
    const activeKeys = new Set(descriptors.map((descriptor) => descriptor.key));
    this.selectionLabels.forEach((label, key) => {
      if (activeKeys.has(key)) return;
      if (this.map?.hasLayer(label)) this.map.removeLayer(label);
      this.selectionLabels.delete(key);
    });
    descriptors.forEach((descriptor) => {
      let label = this.selectionLabels.get(descriptor.key);
      if (!label) {
        label = L.marker(descriptor.center, {
          pane: "tileSelectionPane",
          interactive: false,
          keyboard: false,
          zIndexOffset: 1000,
          icon: descriptor.icon,
        }).addTo(this.map);
        this.selectionLabels.set(descriptor.key, label);
        return;
      }
      label.setLatLng(descriptor.center);
      label.setIcon(descriptor.icon);
      if (!this.map.hasLayer(label)) label.addTo(this.map);
    });
  }

  syncSelectionRectangles() {
    const activeIds = new Set(this.selectedCells.map((cell) => cell.selection_id));
    this.selectionRectangles.forEach((rectangle, selectionId) => {
      if (activeIds.has(selectionId)) return;
      if (this.map?.hasLayer(rectangle)) this.map.removeLayer(rectangle);
      this.selectionRectangles.delete(selectionId);
    });
    this.selectedCells.forEach((cell) => {
      let rectangle = this.selectionRectangles.get(cell.selection_id);
      if (!rectangle) {
        rectangle = this.createSelectionRectangle(cell);
        this.selectionRectangles.set(cell.selection_id, rectangle);
      } else {
        rectangle.setBounds(cell.bounds.leaflet);
        if (!this.map.hasLayer(rectangle)) rectangle.addTo(this.map);
      }
      const active = cell.selection_id === this.selectedCell?.selection_id;
      rectangle.setStyle({
        color: active ? "#f8fafc" : "#38bdf8",
        weight: active ? 2.4 : 1.8,
        opacity: active ? 1 : 0.86,
        dashArray: cell.time_binding?.kind === "locked_axis" ? "5 4" : null,
      });
    });
    this.syncSelectionLabels();
    this.syncDrawer();
  }

  setSelectedCell(cell) {
    if (!cell) return;
    const prepared = this.prepareCell(cell);
    const definition = TileSelectionModeRegistry[this.mode];
    let removed = false;
    if (!definition.multiple) {
      this.selectedCells = [prepared];
    } else {
      const existingIndex = this.selectedCells.findIndex((item) => item.selection_id === prepared.selection_id);
      if (existingIndex >= 0) {
        this.selectedCells.splice(existingIndex, 1);
        removed = true;
      } else {
        this.selectedCells.push(prepared);
      }
    }
    this.selectedCell = removed
      ? this.selectedCells[this.selectedCells.length - 1] || null
      : prepared;
    this.syncSelectionRectangles();
    this.status(removed
      ? `已移除 ${prepared.label}`
      : `已儲存 ${this.selectedCells.length} 個 Tile 標籤`);
    this.emitChange("selected");
  }

  refreshSelectedCell() {
    if (!this.selectedCells.length) return;
    this.syncSelectionRectangles();
  }

  handleClick(event) {
    if (!this.enabled) return;
    L.DomEvent.stop(event.originalEvent);
    const cell = this.hitTester.cellForEvent(event);
    if (!cell) {
      this.status("目前圖層沒有可解析的取樣網格", true);
      return;
    }
    this.setSelectedCell(cell);
  }
}

function initTileSelectionLayer() {
  const singleButton = document.getElementById("grid-select-toggle");
  const continuousButton = document.getElementById("grid-multi-select-toggle");
  const targetMap = window.__rrkalMap || (typeof map !== "undefined" ? map : null);
  window.SampledGridCellHitTester = SampledGridCellHitTester;
  window.GfwCellHitTester = SampledGridCellHitTester;
  if (!singleButton || !continuousButton || !targetMap) return null;
  const layer = new TileSelectionLayer({ targetMap, singleButton, continuousButton });
  window.TileSelectionLayer = layer;
  return layer;
}

window.TileSelectionModeRegistry = TileSelectionModeRegistry;
window.TileSelectionLabelStrategies = TileSelectionLabelStrategies;
window.SameTimeLocationLabel = SameTimeLocationLabel;
window.LockedTimeLocationLabel = LockedTimeLocationLabel;
window.ContinuousTileSelectionDrawer = ContinuousTileSelectionDrawer;
window.TileSelectionLayerClass = TileSelectionLayer;
initTileSelectionLayer();
