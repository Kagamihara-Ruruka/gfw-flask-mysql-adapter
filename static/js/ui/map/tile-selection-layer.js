class GfwCellHitTester {
  constructor({ targetMap } = {}) {
    this.map = targetMap;
  }

  dataset() {
    return state?.datasets?.[state.datasetId] || {};
  }

  identityColumn(row) {
    const dataset = this.dataset();
    if (dataset.id_column && row?.[dataset.id_column] !== undefined) return dataset.id_column;
    if (row?.grid_id !== undefined) return "grid_id";
    return null;
  }

  metricColumn(row) {
    const dataset = this.dataset();
    const metrics = Array.isArray(dataset.metric_columns) ? dataset.metric_columns : [];
    return metrics.find((column) => row?.[column] !== undefined) || "fish_sum";
  }

  cellBoundsForCenter(lat, lon) {
    const halfDegrees = gfwRenderCellHalfDegrees();
    const centerLat = Math.min(90 - halfDegrees, Math.max(-90 + halfDegrees, lat));
    const centerLon = normalizeLongitude(lon);
    const west = Math.max(-180, centerLon - halfDegrees);
    const east = Math.min(180, centerLon + halfDegrees);
    const south = Math.max(-90, centerLat - halfDegrees);
    const north = Math.min(90, centerLat + halfDegrees);
    if (west >= east || south >= north) return null;
    return {
      west,
      south,
      east,
      north,
      leaflet: L.latLngBounds([south, west], [north, east]),
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
    const metricColumn = this.metricColumn(row);
    const bounds = hit.bounds;
    const identityColumn = this.identityColumn(row);
    const identityValue = row[identityColumn];
    const metricValue = Number(row[metricColumn] ?? 0);
    return {
      selection_type: "data_cell",
      source_layer: "gfw",
      dataset_id: state.datasetId,
      date: row[state.datasets?.[state.datasetId]?.time_column || "obs_date"] || $("date")?.value || null,
      tile_key: this.bboxString(bounds),
      label: `cell ${this.bboxString(bounds)}`,
      identity: identityColumn ? {
        column: identityColumn,
        value: identityValue,
      } : null,
      metric: {
        column: metricColumn,
        value: Number.isFinite(metricValue) ? metricValue : 0,
      },
      center: { ...hit.center },
      bounds,
      bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
      bbox_string: this.bboxString(bounds),
      granularity: "gfw_render_cell",
      render_cell_km: gfwRenderCellKm(),
      source_rows: Number(row.source_rows || 1),
    };
  }

  virtualCellForEvent(event) {
    if (!event?.latlng) return null;
    const lat = gfwRenderCellCenter(event.latlng.lat);
    const lon = gfwRenderCellCenter(normalizeLongitude(event.latlng.lng));
    const bounds = this.cellBoundsForCenter(lat, lon);
    if (!bounds) return null;
    const metricColumn = this.metricColumn(null);
    const bboxString = this.bboxString(bounds);
    return {
      selection_type: "virtual_cell",
      source_layer: "gfw",
      dataset_id: state.datasetId,
      date: $("date")?.value || state.renderedGfwDate || null,
      tile_key: bboxString,
      label: `cell ${bboxString}`,
      identity: null,
      metric: {
        column: metricColumn,
        value: 0,
      },
      center: { lat, lon: normalizeLongitude(lon) },
      bounds,
      bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
      bbox_string: bboxString,
      granularity: "gfw_render_cell",
      render_cell_km: gfwRenderCellKm(),
      source_rows: 0,
    };
  }

  cellForEvent(event) {
    const hit = state?.gridLayer?.hitTest?.(event.containerPoint);
    return this.cellForHit(hit) || this.virtualCellForEvent(event);
  }
}

class TileSelectionLayer {
  constructor({ targetMap, button, hitTester = null } = {}) {
    this.map = targetMap;
    this.button = button;
    this.hitTester = hitTester || new GfwCellHitTester({ targetMap });
    this.enabled = false;
    this.selectedCell = null;
    this.selectedRectangle = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundRefresh = () => this.refreshSelectedCell();
    this.ensureState();
    this.ensurePane();
    this.bindButton();
    this.syncButton();
  }

  ensureState() {
    if (typeof state === "undefined") return;
    state.tileSelection = state.tileSelection || {
      enabled: false,
      hover: null,
      selected: null,
    };
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

  bindButton() {
    if (!this.button) return;
    this.button.addEventListener("click", () => this.setEnabled(!this.enabled));
    if (typeof ControlButtons !== "undefined") {
      ControlButtons.bindFeedback([this.button.id]);
    }
  }

  publicCell(cell) {
    if (!cell) return null;
    return {
      selection_type: cell.selection_type,
      source_layer: cell.source_layer,
      dataset_id: cell.dataset_id,
      date: cell.date,
      tile_key: cell.tile_key,
      label: cell.label,
      identity: { ...cell.identity },
      metric: { ...cell.metric },
      center: { ...cell.center },
      bbox: [...cell.bbox],
      bbox_string: cell.bbox_string,
      granularity: cell.granularity,
      render_cell_km: cell.render_cell_km,
      source_rows: cell.source_rows,
    };
  }

  snapshot() {
    return {
      enabled: this.enabled,
      hover: null,
      selected: this.publicCell(this.selectedCell),
    };
  }

  selected() {
    return this.publicCell(this.selectedCell);
  }

  emitChange(reason) {
    this.ensureState();
    if (typeof state !== "undefined") {
      state.tileSelection.enabled = this.enabled;
      state.tileSelection.hover = null;
      state.tileSelection.selected = this.publicCell(this.selectedCell);
    }
    window.dispatchEvent(new CustomEvent("rrkal:tile-selection-changed", {
      detail: { reason, ...this.snapshot() },
    }));
  }

  clearSelection() {
    this.selectedCell = null;
    if (!this.selectedRectangle) return;
    if (this.map?.hasLayer(this.selectedRectangle)) {
      this.map.removeLayer(this.selectedRectangle);
    }
    this.selectedRectangle = null;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    if (this.enabled) {
      this.map?.on("click", this.boundClick);
      this.map?.on("zoomend moveend", this.boundRefresh);
      this.status("網格選取模式：點擊 GFW 顏色格");
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

  syncButton() {
    if (!this.button) return;
    this.button.classList.toggle("is-active", this.enabled);
    this.button.setAttribute("aria-pressed", this.enabled ? "true" : "false");
    this.button.title = this.enabled ? "關閉網格選取模式" : "網格選取模式";
    this.button.setAttribute("aria-label", this.button.title);
    if (typeof ControlButtons !== "undefined") {
      ControlButtons.renderIcons?.();
    }
  }

  drawSelection(cell) {
    if (!cell) return;
    if (!this.selectedRectangle) {
      this.selectedRectangle = L.rectangle(cell.bounds.leaflet, {
        pane: "tileSelectionPane",
        interactive: false,
        color: "#f8fafc",
        weight: 2.2,
        opacity: 1,
        fillColor: "#ffffff",
        fillOpacity: 0,
      }).addTo(this.map);
    } else {
      this.selectedRectangle.setBounds(cell.bounds.leaflet);
      if (!this.map.hasLayer(this.selectedRectangle)) this.selectedRectangle.addTo(this.map);
    }
  }

  setSelectedCell(cell) {
    if (!cell) return;
    this.selectedCell = cell;
    this.drawSelection(cell);
    this.status(`已選取 ${cell.label}`);
    this.emitChange("selected");
  }

  refreshSelectedCell() {
    if (!this.selectedCell || !this.selectedRectangle) return;
    this.drawSelection(this.selectedCell);
  }

  handleClick(event) {
    if (!this.enabled) return;
    L.DomEvent.stop(event.originalEvent);
    const cell = this.hitTester.cellForEvent(event);
    if (!cell) {
      this.status("沒有點中 GFW 顏色格", true);
      return;
    }
    this.setSelectedCell(cell);
  }
}

function initTileSelectionLayer() {
  const button = document.getElementById("grid-select-toggle");
  const targetMap = window.__rrkalMap || (typeof map !== "undefined" ? map : null);
  window.GfwCellHitTester = GfwCellHitTester;
  if (!button || !targetMap) return null;
  const layer = new TileSelectionLayer({ targetMap, button });
  window.TileSelectionLayer = layer;
  return layer;
}

initTileSelectionLayer();
