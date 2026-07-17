const SampledGridCanvasLayer = L.Layer.extend({
  initialize({ renderClock } = {}) {
    if (!renderClock || typeof renderClock.now !== "function") {
      throw new TypeError("SampledGridCanvasLayer requires a render clock");
    }
    this._renderClock = renderClock;
    this._frame = CanonicalGridFrame.empty();
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
  setFrame(frame) {
    if (!CanonicalGridFrame.isFrame(frame)) throw new TypeError("Sampled-grid layer requires CanonicalGridFrame");
    this._frame = frame;
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
    const paintFrame = sampledGridPaintFrame(this._frame);
    const boundsScratch = {};
    ctx.clearRect(0, 0, size.x, size.y);
    const layerAlpha = state.layerAlpha[state.dataLayer] ?? state.sampledGridPaint?.alpha ?? 1;
    for (const index of paintFrame.indices) {
      const bounds = this._frame.boundsAt(index, boundsScratch);
      if (!bounds) continue;
      const nw = this._map.latLngToContainerPoint([bounds.north, bounds.west]);
      const se = this._map.latLngToContainerPoint([bounds.south, bounds.east]);
      const x = Math.floor(Math.min(nw.x, se.x));
      const y = Math.floor(Math.min(nw.y, se.y));
      const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
      const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      const value = Number(this._frame.valueAt("value", index));
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
    return sampledGridHitCellAt(this._map, this._frame, containerPoint);
  },
});

function syncSampledGridTransitionStyle() {
  SampledGridLayerEffects.syncTransitionStyle(map, state);
}

function setSampledGridLayerTransition(layer) {
  SampledGridLayerEffects.setLayerTransition(layer, state);
}

function setSampledGridLayerOpacity(layer, opacity) {
  SampledGridLayerEffects.setLayerOpacity(layer, opacity);
}

function setSampledGridLayerBlur(layer, active) {
  SampledGridLayerEffects.setLayerBlur(layer, state, active);
}

function fadeOutSampledGridLayer() {
  SampledGridLayerEffects.fadeOut({ targetMap: map, targetState: state });
}

function revealSampledGridLayer() {
  SampledGridLayerEffects.reveal({ targetMap: map, targetState: state });
}

function removeRetiredSampledGridLayers() {
  SampledGridLayerEffects.removeRetiredLayers({ targetMap: map, targetState: state });
}

function crossfadeSampledGridLayer(previousLayer, nextLayer) {
  SampledGridLayerEffects.crossfade({
    targetMap: map,
    targetState: state,
    previousLayer,
    nextLayer,
    renderClock: ClockDomain.render,
  });
}

function removeSampledGridLayer() {
  removeRetiredSampledGridLayers();
  if (state.gridLayer && map.hasLayer(state.gridLayer)) {
    map.removeLayer(state.gridLayer);
  }
  state.gridLayer = null;
  revealSampledGridLayer();
  state.renderedSampledGridDate = null;
  state.sampledGridMeta = null;
  clearRenderedLodZoom(state.dataLayer || "sampled-grid");
}

function sampledGridFrameWithinCoverage(frame, datasetId = state.datasetId) {
  if (!CanonicalGridFrame.isFrame(frame)) return CanonicalGridFrame.empty();
  return window.LayerViewportController?.filterFrame(frame, datasetId) || frame;
}

function clearSampledGridLayerForLodReload() {
  fadeOutSampledGridLayer();
  clearRenderedLodZoom(state.dataLayer || "sampled-grid");
  RenderState.loading(state.dataLayer || "sampled-grid", "LOD 更新");
}

function createSampledGridLayer(layerClass) {
  const layer = new layerClass({ renderClock: ClockDomain.render }).addTo(map);
  setSampledGridLayerTransition(layer);
  setSampledGridLayerOpacity(layer, 0);
  setSampledGridLayerBlur(layer, false);
  return layer;
}

function renderSampledGridMap(frame) {
  const visibleFrame = sampledGridFrameWithinCoverage(frame);
  syncSampledGridTransitionStyle();
  removeAisLayer();
  const previousLayer = state.gridLayer && map.hasLayer(state.gridLayer) ? state.gridLayer : null;
  let choice = RendererRegistry.chooseSampledGridLayer(visibleFrame, SampledGridCanvasLayer);
  let nextLayer = createSampledGridLayer(choice.LayerClass);
  let drawMs = nextLayer.setFrame(visibleFrame);
  if (choice.backend === "webgl" && nextLayer._failed) {
    if (map.hasLayer(nextLayer)) map.removeLayer(nextLayer);
    choice = { backend: "canvas", LayerClass: SampledGridCanvasLayer };
    nextLayer = createSampledGridLayer(choice.LayerClass);
    drawMs = nextLayer.setFrame(visibleFrame);
  }
  state.gridLayer = nextLayer;
  state.renderedSampledGridDate = $("date")?.value || state.renderedSampledGridDate;
  setRenderedLodZoom(state.dataLayer || "sampled-grid");
  applyLayerOrder();
  crossfadeSampledGridLayer(previousLayer, nextLayer);
  return {
    backend: choice.backend,
    drawMs,
    rowCount: visibleFrame.rowCount,
    frame: visibleFrame,
    detail: RendererRegistry.recordSampledGridRender(choice.backend, drawMs),
  };
}
