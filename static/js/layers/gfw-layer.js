const SampledGridCanvasLayer = L.Layer.extend({
  initialize({ renderClock } = {}) {
    if (!renderClock || typeof renderClock.now !== "function") {
      throw new TypeError("SampledGridCanvasLayer requires a render clock");
    }
    this._renderClock = renderClock;
    this._rows = [];
  },
  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "grid-canvas-layer");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    targetMap.getPane("sampledGridPane").appendChild(this._canvas);
    bindSampledGridViewportRedraw(this, targetMap);
    this._reset();
  },
  onRemove(targetMap) {
    unbindSampledGridViewportRedraw(this, targetMap);
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
    const started = this._renderClock.now();
    if (!this._ctx || !this._map) return 0;
    const ctx = this._ctx;
    const size = this._map.getSize();
    const paintFrame = sampledGridPaintFrame(this._rows);
    const model = paintFrame.model;
    ctx.clearRect(0, 0, size.x, size.y);
    const layerAlpha = state.layerAlpha[state.dataLayer] ?? state.sampledGridPaint?.alpha ?? 1;
    for (const row of paintFrame.rows) {
      const bounds = model.bounds(row);
      if (!bounds) continue;
      const nw = this._map.latLngToContainerPoint([bounds.north, bounds.west]);
      const se = this._map.latLngToContainerPoint([bounds.south, bounds.east]);
      const x = Math.floor(Math.min(nw.x, se.x));
      const y = Math.floor(Math.min(nw.y, se.y));
      const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
      const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      const value = model.value(row);
      const cellOpacity = paintFrame.opacityForValue(value);
      if (cellOpacity > 0) {
        ctx.globalAlpha = layerAlpha * cellOpacity;
        ctx.fillStyle = paintFrame.colorCssForValue(value);
        ctx.fillRect(x, y, w, h);
      }
    }
    ctx.globalAlpha = 1;
    return this._renderClock.now() - started;
  },
  hitTest(containerPoint) {
    return sampledGridHitCellAt(this._map, this._rows, containerPoint);
  },
});

const GridCanvasLayer = SampledGridCanvasLayer;

function setGfwPaneOpacity(opacity) {
  SampledGridLayerEffects.setPaneOpacity(map, opacity);
}

function syncGfwTransitionStyle() {
  SampledGridLayerEffects.syncTransitionStyle(map, state);
}

function gfwTransitionMs() {
  return SampledGridLayerEffects.transitionMs(state);
}

function gfwLayerElement(layer) {
  return SampledGridLayerEffects.layerElement(layer);
}

function setGfwLayerTransition(layer) {
  SampledGridLayerEffects.setLayerTransition(layer, state);
}

function setGfwLayerOpacity(layer, opacity) {
  SampledGridLayerEffects.setLayerOpacity(layer, opacity);
}

function setGfwLayerBlur(layer, active) {
  SampledGridLayerEffects.setLayerBlur(layer, state, active);
}

function setGfwPaneBlur(active) {
  SampledGridLayerEffects.setPaneBlur(map, state, active);
}

function fadeOutGfwLayer() {
  SampledGridLayerEffects.fadeOut({ targetMap: map, targetState: state });
}

function waitGfwTransition() {
  return SampledGridLayerEffects.waitTransition(state, ClockDomain.render);
}

function revealGfwLayer() {
  SampledGridLayerEffects.reveal({ targetMap: map, targetState: state });
}

function removeRetiredGfwLayer(layer) {
  SampledGridLayerEffects.removeRetiredLayer({ targetMap: map, targetState: state, layer });
}

function removeRetiredGfwLayers() {
  SampledGridLayerEffects.removeRetiredLayers({ targetMap: map, targetState: state });
}

function crossfadeGfwLayer(previousLayer, nextLayer) {
  SampledGridLayerEffects.crossfade({
    targetMap: map,
    targetState: state,
    previousLayer,
    nextLayer,
    renderClock: ClockDomain.render,
  });
}

function removeSampledGridLayer() {
  removeRetiredGfwLayers();
  if (state.gridLayer && map.hasLayer(state.gridLayer)) {
    map.removeLayer(state.gridLayer);
  }
  state.gridLayer = null;
  revealGfwLayer();
  state.renderedSampledGridDate = null;
  state.renderedGfwDate = null;
  state.sampledGridMeta = null;
  clearRenderedLodZoom(state.dataLayer || "sampled-grid");
}

function sampledGridRowsWithinCoverage(rows, datasetId = state.datasetId) {
  const values = Array.isArray(rows) ? rows : [];
  return window.LayerViewportController?.filterRows(values, datasetId) || values;
}

function clearSampledGridLayerForLodReload() {
  fadeOutGfwLayer();
  clearRenderedLodZoom(state.dataLayer || "sampled-grid");
  RenderState.loading(state.dataLayer || "sampled-grid", "LOD 更新");
}

function createSampledGridLayer(layerClass) {
  const layer = new layerClass({ renderClock: ClockDomain.render }).addTo(map);
  setGfwLayerTransition(layer);
  setGfwLayerOpacity(layer, 0);
  setGfwLayerBlur(layer, false);
  return layer;
}

function renderSampledGridMap(rows) {
  const visibleRows = sampledGridRowsWithinCoverage(rows);
  syncGfwTransitionStyle();
  removeAisLayer();
  const previousLayer = state.gridLayer && map.hasLayer(state.gridLayer) ? state.gridLayer : null;
  let choice = RendererRegistry.chooseSampledGridLayer(visibleRows, SampledGridCanvasLayer);
  let nextLayer = createSampledGridLayer(choice.LayerClass);
  let drawMs = nextLayer.setRows(visibleRows);
  if (choice.backend === "webgl" && nextLayer._failed) {
    if (map.hasLayer(nextLayer)) map.removeLayer(nextLayer);
    choice = { backend: "canvas", LayerClass: SampledGridCanvasLayer };
    nextLayer = createSampledGridLayer(choice.LayerClass);
    drawMs = nextLayer.setRows(visibleRows);
  }
  state.gridLayer = nextLayer;
  state.renderedSampledGridDate = $("date")?.value || state.renderedSampledGridDate;
  state.renderedGfwDate = state.renderedSampledGridDate;
  setRenderedLodZoom(state.dataLayer || "sampled-grid");
  applyLayerOrder();
  crossfadeGfwLayer(previousLayer, nextLayer);
  return {
    backend: choice.backend,
    drawMs,
    rowCount: visibleRows.length,
    detail: RendererRegistry.recordSampledGridRender(choice.backend, drawMs),
  };
}

function removeGfwLayer() {
  return removeSampledGridLayer();
}

function clearGfwLayerForLodReload() {
  return clearSampledGridLayerForLodReload();
}

function createGfwLayer(layerClass) {
  return createSampledGridLayer(layerClass);
}

function renderGfwMap(rows) {
  return renderSampledGridMap(rows);
}
