const GridCanvasLayer = L.Layer.extend({
  initialize() {
    this._rows = [];
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
    }
    ctx.globalAlpha = 1;
    return performance.now() - started;
  },
});

function setGfwPaneOpacity(opacity) {
  const pane = map.getPane("gfwPane");
  if (!pane) return;
  pane.style.opacity = String(opacity);
}

function syncGfwTransitionStyle() {
  const pane = map.getPane("gfwPane");
  if (!pane) return;
  pane.style.opacity = "1";
  pane.style.transition = `filter ${state.gfwTransitionMs}ms ease`;
}

function gfwTransitionMs() {
  return Math.max(0, Number(state.gfwTransitionMs || 0));
}

function gfwLayerElement(layer) {
  return layer?._canvas || null;
}

function setGfwLayerTransition(layer) {
  const element = gfwLayerElement(layer);
  if (!element) return;
  const ms = gfwTransitionMs();
  element.style.transition = `opacity ${ms}ms ease, filter ${ms}ms ease`;
}

function setGfwLayerOpacity(layer, opacity) {
  const element = gfwLayerElement(layer);
  if (!element) return;
  element.style.opacity = String(opacity);
}

function setGfwLayerBlur(layer, active) {
  const element = gfwLayerElement(layer);
  if (!element) return;
  const blurPx = Math.max(0, Number(state.gfwZoomBlurPx || 0));
  element.style.filter = active && blurPx > 0 ? `blur(${blurPx}px)` : "";
}

function setGfwPaneBlur(active) {
  const pane = map.getPane("gfwPane");
  if (!pane) return;
  const blurPx = Math.max(0, Number(state.gfwZoomBlurPx || 0));
  pane.style.filter = active && blurPx > 0 ? `blur(${blurPx}px)` : "";
}

function fadeOutGfwLayer() {
  if (!state.gridLayer || !map.hasLayer(state.gridLayer)) return;
  syncGfwTransitionStyle();
  setGfwLayerTransition(state.gridLayer);
  setGfwLayerBlur(state.gridLayer, true);
}

function waitGfwTransition() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, Number(state.gfwTransitionMs || 0)));
  });
}

function revealGfwLayer() {
  setGfwPaneBlur(false);
  setGfwPaneOpacity(1);
  setGfwLayerBlur(state.gridLayer, false);
  setGfwLayerOpacity(state.gridLayer, 1);
}

function removeRetiredGfwLayer(layer) {
  if (!layer) return;
  if (map.hasLayer(layer)) {
    map.removeLayer(layer);
  }
  if (Array.isArray(state.gfwRetiringLayers)) {
    state.gfwRetiringLayers = state.gfwRetiringLayers.filter((item) => item !== layer);
  }
}

function removeRetiredGfwLayers() {
  const retiring = Array.isArray(state.gfwRetiringLayers) ? [...state.gfwRetiringLayers] : [];
  for (const layer of retiring) {
    removeRetiredGfwLayer(layer);
  }
}

function crossfadeGfwLayer(previousLayer, nextLayer) {
  syncGfwTransitionStyle();
  setGfwPaneBlur(false);
  setGfwPaneOpacity(1);
  setGfwLayerTransition(nextLayer);
  setGfwLayerBlur(nextLayer, false);

  if (!previousLayer || previousLayer === nextLayer || !map.hasLayer(previousLayer)) {
    setGfwLayerOpacity(nextLayer, 1);
    return;
  }

  setGfwLayerTransition(previousLayer);
  setGfwLayerBlur(previousLayer, false);
  setGfwLayerOpacity(nextLayer, 0);
  state.gfwRetiringLayers = state.gfwRetiringLayers || [];
  state.gfwRetiringLayers.push(previousLayer);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setGfwLayerOpacity(nextLayer, 1);
      setGfwLayerOpacity(previousLayer, 0);
    });
  });

  window.setTimeout(() => {
    if (state.gridLayer !== previousLayer) {
      removeRetiredGfwLayer(previousLayer);
    }
  }, gfwTransitionMs() + 80);
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
