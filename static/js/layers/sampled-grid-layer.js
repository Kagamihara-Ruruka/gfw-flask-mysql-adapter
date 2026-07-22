const SampledGridCanvasLayer = L.Layer.extend({
  initialize({ renderClock, renderContextValidator = null } = {}) {
    if (!renderClock || typeof renderClock.now !== "function") {
      throw new TypeError("SampledGridCanvasLayer requires a render clock");
    }
    this._renderClock = renderClock;
    this._renderContextValidator = typeof renderContextValidator === "function"
      ? renderContextValidator
      : null;
    this._frame = CanonicalGridFrame.empty();
    this._renderContext = null;
    this._active = false;
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
  setActive(active) {
    this._active = Boolean(active);
    if (!this._active) cancelSampledGridViewportRedraw(this);
    return this;
  },
  setFrame(frame, renderContext) {
    if (!CanonicalGridFrame.isFrame(frame)) throw new TypeError("Sampled-grid layer requires CanonicalGridFrame");
    this._frame = frame;
    this._renderContext = renderContext;
    if (!isSampledGridRenderContext(this._renderContext)) {
      throw new TypeError("Sampled-grid layer requires a RenderContext");
    }
    return this.redraw();
  },
  isRenderContextCurrent() {
    if (!this._renderContext) return false;
    return this._renderContextValidator
      ? Boolean(this._renderContextValidator(this._renderContext))
      : true;
  },
  clearSurface() {
    if (!this._ctx || !this._canvas) return;
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  },
  invalidateRenderContext() {
    this._renderContext = null;
    this._frame = CanonicalGridFrame.empty();
    this.clearSurface();
  },
  syncViewport() {
    if (!this._map || !this._canvas) return;
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
  },
  redraw() {
    if (!this._active) return 0;
    if (!this.isRenderContextCurrent()) {
      this.clearSurface();
      return 0;
    }
    return this._draw();
  },
  _reset() {
    this.syncViewport();
    return this.redraw();
  },
  _draw() {
    const started = this._renderClock.now();
    if (
      !this._active
      || !this._ctx
      || !this._map
      || !this._renderContext
      || !this.isRenderContextCurrent()
    ) return 0;
    const ctx = this._ctx;
    const size = this._map.getSize();
    const paintFrame = this._renderContext.paintFrame;
    const boundsScratch = {};
    ctx.clearRect(0, 0, size.x, size.y);
    const layerAlpha = this._renderContext.alpha;
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
    const landMask = this._renderContext.validityMask;
    if (landMask?.ready && landMask.canvas) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(landMask.canvas, 0, 0, size.x, size.y);
      ctx.restore();
    }
    return this._renderClock.now() - started;
  },
  hitTest(containerPoint) {
    if (!this.isRenderContextCurrent()) return null;
    return sampledGridHitCellAt(this._map, this._frame, containerPoint);
  },
});

function syncSampledGridTransitionStyle() {
  SampledGridLayerTransitions.syncTransitionStyle();
}

function setSampledGridLayerTransition(layer) {
  SampledGridLayerTransitions.setLayerTransition(layer);
}

function setSampledGridLayerOpacity(layer, opacity) {
  SampledGridLayerTransitions.setLayerOpacity(layer, opacity);
}

function setSampledGridLayerBlur(layer, active) {
  SampledGridLayerTransitions.setLayerBlur(layer, active);
}

function fadeOutSampledGridLayer() {
  SampledGridLayerTransitions.fadeOut();
}

function revealSampledGridLayer() {
  SampledGridLayerTransitions.reveal();
}

function removeRetiredSampledGridLayers() {
  SampledGridLayerTransitions.removeRetiredLayers();
}

function crossfadeSampledGridLayer(previousLayer, nextLayer, { retainPrevious = false } = {}) {
  SampledGridLayerTransitions.crossfade({
    previousLayer,
    nextLayer,
    retainPrevious,
  });
}

function removeSampledGridLayer() {
  if (typeof SampledGridLayerPool !== "undefined") {
    SampledGridLayerPool.clear();
  } else {
    removeRetiredSampledGridLayers();
    if (state.gridLayer && map.hasLayer(state.gridLayer)) {
      map.removeLayer(state.gridLayer);
    }
    state.gridLayer = null;
  }
  revealSampledGridLayer();
  state.renderedSampledGridDate = null;
  state.sampledGridMeta = null;
  clearRenderedLodZoom(state.dataLayer || "sampled-grid");
}

function sampledGridFrameWithinCoverage(frame, datasetId = state.datasetId) {
  if (!CanonicalGridFrame.isFrame(frame)) return CanonicalGridFrame.empty();
  return window.LayerViewportController?.filterFrame(frame, datasetId) || frame;
}

function repaintActiveSampledGridLayer({
  layerId = state.dataLayer,
  datasetId = state.datasetId,
} = {}) {
  const active = state.gridLayer;
  if (!active?.setFrame || !CanonicalGridFrame.isFrame(active._frame)) return 0;
  const normalizedLayerId = String(layerId || "").trim().toLowerCase();
  const normalizedDatasetId = String(datasetId || "").trim();
  const current = active._renderContext;
  if (
    current
    && (current.layerId !== normalizedLayerId || current.datasetId !== normalizedDatasetId)
  ) return 0;
  const renderEpoch = typeof SampledGridLayerPool !== "undefined"
    ? SampledGridLayerPool.beginRenderTransaction("paint_profile_changed")
    : Math.max(1, Math.floor(Number(current?.renderEpoch || 0)) + 1);
  const validityMask = typeof SpatialLandMaskService !== "undefined"
    ? SpatialLandMaskService.snapshot(normalizedLayerId)
    : current?.validityMask || null;
  const renderContext = createSampledGridRenderContext(active._frame, {
    layerId: normalizedLayerId,
    datasetId: normalizedDatasetId,
    alpha: state.layerAlpha?.[normalizedLayerId],
    renderGridProfile: current?.renderGridProfile || state.renderGridProfile,
    requestContext: current?.requestContext || null,
    frameIdentity: FrameIdentity,
    validityMask,
    renderEpoch,
  });
  return active.setFrame(active._frame, renderContext);
}

function clearSampledGridLayerForLodReload() {
  fadeOutSampledGridLayer();
  clearRenderedLodZoom(state.dataLayer || "sampled-grid");
  RenderState.loading(state.dataLayer || "sampled-grid", "LOD 更新");
}

function createSampledGridLayer(layerClass, {
  continuousFieldProvider = null,
  renderContextValidator = null,
} = {}) {
  const layer = new layerClass({
    renderClock: ClockDomain.render,
    continuousFieldProvider,
    renderContextValidator,
  }).addTo(map);
  setSampledGridLayerTransition(layer);
  setSampledGridLayerOpacity(layer, 0);
  setSampledGridLayerBlur(layer, false);
  return layer;
}

function renderSampledGridMap(frame, { requestContext = null } = {}) {
  const visibleFrame = sampledGridFrameWithinCoverage(frame);
  syncSampledGridTransitionStyle();
  removeAisLayer();
  const validityMask = typeof SpatialLandMaskService !== "undefined"
    ? SpatialLandMaskService.snapshot(state.dataLayer)
    : null;
  if (visibleFrame.rowCount > 0 && validityMask?.enabled && !validityMask.ready) {
    if (validityMask.status === "FAILED") {
      throw new Error("Sampled-grid land mask is unavailable");
    }
    if (typeof SampledGridLayerPool === "undefined") {
      throw new Error("Sampled-grid land mask is not ready and no render transaction owner is available");
    }
    const normalizedRequest = FrameIdentity.normalizeRequest({
      ...requestContext,
      layerId: state.dataLayer,
      datasetId: state.datasetId,
    });
    const identity = Object.freeze({
      layerId: String(state.dataLayer || "").trim().toLowerCase(),
      datasetId: String(state.datasetId || "").trim(),
      date: normalizedRequest.date,
      scopeKey: FrameIdentity.scopeKey(normalizedRequest),
    });
    SampledGridLayerPool.invalidateActiveContext("land_mask_pending");
    const pending = SampledGridLayerPool.stagePendingRender({
      frame: visibleFrame,
      requestContext: normalizedRequest,
      identity,
    });
    return {
      backend: "deferred",
      deferred: true,
      completion: pending.completion,
      drawMs: 0,
      rowCount: visibleFrame.rowCount,
      frame: visibleFrame,
      detail: "等待陸地遮罩",
    };
  }
  const previousLayer = state.gridLayer && map.hasLayer(state.gridLayer) ? state.gridLayer : null;
  const renderEpoch = typeof SampledGridLayerPool !== "undefined"
    ? SampledGridLayerPool.beginRenderTransaction("frame_commit")
    : Math.max(1, Math.floor(Number(state.sampledGridRenderEpoch || 0)) + 1);
  state.sampledGridRenderEpoch = renderEpoch;
  let choice = RendererRegistry.chooseSampledGridLayer(visibleFrame, SampledGridCanvasLayer);
  let nextLayer = typeof SampledGridLayerPool !== "undefined"
    ? SampledGridLayerPool.acquire(choice.LayerClass, { currentLayer: previousLayer })
    : createSampledGridLayer(choice.LayerClass);
  const activateLayer = (layer) => {
    if (typeof SampledGridLayerPool !== "undefined") SampledGridLayerPool.activate(layer);
    else {
      previousLayer?.setActive?.(false);
      layer?.syncViewport?.();
      layer?.setActive?.(true);
      state.gridLayer = layer;
    }
  };
  let renderContext = createSampledGridRenderContext(visibleFrame, {
    layerId: state.dataLayer,
    datasetId: state.datasetId,
    requestContext,
    frameIdentity: FrameIdentity,
    validityMask,
    renderEpoch,
  });
  nextLayer.setFrame(visibleFrame, renderContext);
  activateLayer(nextLayer);
  let drawMs = nextLayer.redraw?.() || 0;
  if (choice.backend === "webgl" && nextLayer._failed) {
    if (typeof SampledGridLayerPool !== "undefined") {
      SampledGridLayerPool.discard(nextLayer);
    } else if (map.hasLayer(nextLayer)) {
      map.removeLayer(nextLayer);
    }
    choice = { backend: "canvas", LayerClass: SampledGridCanvasLayer };
    nextLayer = typeof SampledGridLayerPool !== "undefined"
      ? SampledGridLayerPool.acquire(choice.LayerClass, { currentLayer: previousLayer })
      : createSampledGridLayer(choice.LayerClass);
    renderContext = createSampledGridRenderContext(visibleFrame, {
      layerId: state.dataLayer,
      datasetId: state.datasetId,
      requestContext,
      frameIdentity: FrameIdentity,
      validityMask,
      renderEpoch,
    });
    nextLayer.setFrame(visibleFrame, renderContext);
    activateLayer(nextLayer);
    drawMs = nextLayer.redraw?.() || 0;
  }
  state.gridLayer = nextLayer;
  const committed = nextLayer.isRenderContextCurrent?.() !== false;
  state.renderedSampledGridDate = committed ? (renderContext.date || null) : null;
  setRenderedLodZoom(state.dataLayer || "sampled-grid");
  applyLayerOrder();
  crossfadeSampledGridLayer(previousLayer, nextLayer, {
    retainPrevious: typeof SampledGridLayerPool !== "undefined",
  });
  return {
    backend: choice.backend,
    drawMs,
    rowCount: visibleFrame.rowCount,
    frame: visibleFrame,
    committed,
    reason: committed ? "committed" : "render_context_stale",
    detail: RendererRegistry.recordSampledGridRender(choice.backend, drawMs),
  };
}
