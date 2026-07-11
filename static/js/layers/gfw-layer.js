const GridCanvasLayer = L.Layer.extend({
  initialize() {
    this._rows = [];
    this._hitCells = [];
  },
  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "grid-canvas-layer");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    targetMap.getPane("gfwPane").appendChild(this._canvas);
    targetMap.on("move zoom resize", this._reset, this);
    this._reset();
  },
  onRemove(targetMap) {
    targetMap.off("move zoom resize", this._reset, this);
    L.DomUtil.remove(this._canvas);
  },
  setRows(rows) {
    this._rows = rows;
    return this._draw();
  },
  _reset() {
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._draw();
  },
  _draw() {
    const started = performance.now();
    if (!this._ctx || !this._map) return 0;
    const ctx = this._ctx;
    const size = this._map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.globalAlpha = state.layerAlpha.gfw;
    const renderRows = aggregateGfwRowsForRender(this._rows);
    const halfDegrees = gfwRenderCellHalfDegrees();
    const hitCells = [];
    for (const row of renderRows) {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const nw = this._map.latLngToContainerPoint([lat + halfDegrees, lon - halfDegrees]);
      const se = this._map.latLngToContainerPoint([lat - halfDegrees, lon + halfDegrees]);
      const x = Math.floor(Math.min(nw.x, se.x));
      const y = Math.floor(Math.min(nw.y, se.y));
      const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
      const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      ctx.fillStyle = gfwCellColorCss(row);
      ctx.fillRect(x, y, w, h);
      hitCells.push({
        row,
        rect: { x, y, w, h },
        bounds: {
          west: normalizeLongitude(lon - halfDegrees),
          south: lat - halfDegrees,
          east: normalizeLongitude(lon + halfDegrees),
          north: lat + halfDegrees,
          leaflet: L.latLngBounds([lat - halfDegrees, lon - halfDegrees], [lat + halfDegrees, lon + halfDegrees]),
        },
        center: { lat, lon: normalizeLongitude(lon) },
      });
    }
    this._hitCells = hitCells;
    ctx.globalAlpha = 1;
    return performance.now() - started;
  },
  hitTest(containerPoint) {
    const point = L.point(containerPoint);
    for (let index = this._hitCells.length - 1; index >= 0; index -= 1) {
      const cell = this._hitCells[index];
      const { x, y, w, h } = cell.rect;
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
        return cell;
      }
    }
    return null;
  },
});

function setGfwPaneOpacity(opacity) {
  GfwLayerEffects.setPaneOpacity(map, opacity);
}

function syncGfwTransitionStyle() {
  GfwLayerEffects.syncTransitionStyle(map, state);
}

function gfwTransitionMs() {
  return GfwLayerEffects.transitionMs(state);
}

function gfwLayerElement(layer) {
  return GfwLayerEffects.layerElement(layer);
}

function setGfwLayerTransition(layer) {
  GfwLayerEffects.setLayerTransition(layer, state);
}

function setGfwLayerOpacity(layer, opacity) {
  GfwLayerEffects.setLayerOpacity(layer, opacity);
}

function setGfwLayerBlur(layer, active) {
  GfwLayerEffects.setLayerBlur(layer, state, active);
}

function setGfwPaneBlur(active) {
  GfwLayerEffects.setPaneBlur(map, state, active);
}

function fadeOutGfwLayer() {
  GfwLayerEffects.fadeOut({ targetMap: map, targetState: state });
}

function waitGfwTransition() {
  return GfwLayerEffects.waitTransition(state);
}

function revealGfwLayer() {
  GfwLayerEffects.reveal({ targetMap: map, targetState: state });
}

function removeRetiredGfwLayer(layer) {
  GfwLayerEffects.removeRetiredLayer({ targetMap: map, targetState: state, layer });
}

function removeRetiredGfwLayers() {
  GfwLayerEffects.removeRetiredLayers({ targetMap: map, targetState: state });
}

function crossfadeGfwLayer(previousLayer, nextLayer) {
  GfwLayerEffects.crossfade({ targetMap: map, targetState: state, previousLayer, nextLayer });
}

function removeGfwLayer() {
  removeRetiredGfwLayers();
  if (state.gridLayer && map.hasLayer(state.gridLayer)) {
    map.removeLayer(state.gridLayer);
  }
  state.gridLayer = null;
  revealGfwLayer();
  state.renderedGfwDate = null;
  clearRenderedLodZoom("gfw");
  if (state.dataLayer !== "gfw") {
    RenderState.off("gfw", "關閉");
  }
}

function clearGfwLayerForLodReload() {
  fadeOutGfwLayer();
  clearRenderedLodZoom("gfw");
  RenderState.loading("gfw", "縮放變更");
}

function createGfwLayer(layerClass) {
  const layer = new layerClass().addTo(map);
  setGfwLayerTransition(layer);
  setGfwLayerOpacity(layer, 0);
  setGfwLayerBlur(layer, false);
  return layer;
}

function renderGfwMap(rows) {
  syncGfwTransitionStyle();
  map.invalidateSize();
  removeAisLayer();
  const previousLayer = state.gridLayer && map.hasLayer(state.gridLayer) ? state.gridLayer : null;
  let choice = RendererRegistry.chooseGfwLayer(rows, GridCanvasLayer);
  let nextLayer = createGfwLayer(choice.LayerClass);
  let drawMs = nextLayer.setRows(rows);
  if (choice.backend === "webgl" && nextLayer._failed) {
    if (map.hasLayer(nextLayer)) {
      map.removeLayer(nextLayer);
    }
    choice = { backend: "canvas", LayerClass: GridCanvasLayer };
    nextLayer = createGfwLayer(choice.LayerClass);
    drawMs = nextLayer.setRows(rows);
  }
  state.gridLayer = nextLayer;
  state.renderedGfwDate = $("date")?.value || state.renderedGfwDate;
  setRenderedLodZoom("gfw");
  applyLayerOrder();
  crossfadeGfwLayer(previousLayer, nextLayer);
  return {
    backend: choice.backend,
    drawMs,
    detail: RendererRegistry.recordGfwRender(choice.backend, drawMs),
  };
}
