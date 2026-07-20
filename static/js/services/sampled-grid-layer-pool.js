class SampledGridLayerPoolCore {
  constructor({
    targetMap,
    targetState,
    layerFactory,
    layerEffects,
    landMaskProvider = null,
    rendererCapabilityState = null,
    renderClock = null,
    recoverActiveLayer = null,
    commitPendingRender = null,
    maxLayers = 2,
  } = {}) {
    if (
      !targetMap
      || !targetState
      || typeof layerFactory !== "function"
      || !layerEffects
      || typeof layerEffects.setLayerOpacity !== "function"
    ) {
      throw new TypeError("SampledGridLayerPool requires map, state, layer factory and effects");
    }
    this.targetMap = targetMap;
    this.targetState = targetState;
    this.layerFactory = layerFactory;
    this.layerEffects = layerEffects;
    this.maxLayers = Math.max(2, Math.floor(Number(maxLayers) || 2));
    this.layers = [];
    this.renderEpoch = 0;
    this.renderClock = renderClock;
    this.recoverActiveLayer = typeof recoverActiveLayer === "function" ? recoverActiveLayer : null;
    this.commitPendingRender = typeof commitPendingRender === "function" ? commitPendingRender : null;
    this.pendingRender = null;
    this.capabilityRecoveryFrame = null;
    this.unsubscribeLandMask = landMaskProvider?.subscribe?.((snapshot) => {
      if (!snapshot?.ready) {
        if (snapshot?.status === "FAILED") this.cancelPendingRender("land_mask_failed");
        return;
      }
      if (this.pendingRender && this.commitPendingRender) {
        const pending = this.pendingRender;
        this.pendingRender = null;
        try {
          const result = this.commitPendingRender(pending.payload, {
            reason: "land_mask_ready",
            snapshot,
          });
          pending.resolve(Object.freeze({
            status: result && !result.deferred ? "committed" : "stale",
            result: result || null,
          }));
          if (result && !result.deferred) return;
        } catch (error) {
          pending.resolve(Object.freeze({ status: "failed", error }));
          throw error;
        }
      }
      const active = this.targetState.gridLayer;
      if (!active || !this.layers.includes(active) || !this.targetMap.hasLayer(active)) return;
      this.recoverActiveLayer?.(active, { reason: "land_mask_ready", snapshot });
    }) || null;
    this.unsubscribeRendererCapability = rendererCapabilityState?.subscribe?.((_snapshot, event = {}) => {
      if (event.reason !== "context_lost" || !this.recoverActiveLayer || !this.renderClock) return;
      const active = this.targetState.gridLayer;
      if (!active || active._rendererId !== event.detail?.rendererId) return;
      if (this.capabilityRecoveryFrame !== null) return;
      this.capabilityRecoveryFrame = this.renderClock.request(() => {
        this.capabilityRecoveryFrame = null;
        if (this.targetState.gridLayer !== active || !this.targetMap.hasLayer(active)) return;
        this.recoverActiveLayer(active);
      });
    }) || null;
  }

  matches(layer, LayerClass) {
    return Boolean(layer && LayerClass && layer.constructor === LayerClass && !layer._failed);
  }

  beginRenderTransaction(reason = "frame_commit") {
    this.cancelPendingRender(reason);
    this.renderEpoch += 1;
    this.layerEffects.invalidate?.(reason);
    return this.renderEpoch;
  }

  isRenderEpochCurrent(epoch) {
    return Number(epoch) === this.renderEpoch;
  }

  stagePendingRender(payload) {
    if (!payload?.frame || !payload?.identity?.scopeKey) {
      throw new TypeError("Pending sampled-grid render requires frame and complete scope identity");
    }
    this.cancelPendingRender("superseded");
    let resolve;
    const completion = new Promise((settle) => { resolve = settle; });
    const immutablePayload = Object.freeze({
      ...payload,
      requestContext: payload.requestContext
        ? Object.freeze({ ...payload.requestContext })
        : null,
      identity: Object.freeze({ ...payload.identity }),
    });
    this.pendingRender = { payload: immutablePayload, completion, resolve };
    return Object.freeze({ ...immutablePayload, completion });
  }

  cancelPendingRender(reason = "invalidated") {
    const pending = this.pendingRender;
    if (!pending) return false;
    this.pendingRender = null;
    pending.resolve(Object.freeze({ status: "cancelled", reason }));
    return true;
  }

  remove(layer) {
    if (!layer) return false;
    layer.setActive?.(false);
    if (this.targetMap.hasLayer(layer)) this.targetMap.removeLayer(layer);
    this.layers = this.layers.filter((candidate) => candidate !== layer);
    if (this.targetState.gridLayer === layer) this.targetState.gridLayer = null;
    return true;
  }

  acquire(LayerClass, { currentLayer = this.targetState.gridLayer } = {}) {
    this.layerEffects.invalidate?.("layer_acquire");
    let candidate = this.layers.find((layer) => (
      layer !== currentLayer && this.matches(layer, LayerClass)
    ));
    if (candidate) {
      candidate.setActive?.(false);
      this.layerEffects.setLayerOpacity(candidate, 0);
      return candidate;
    }

    const replaceable = this.layers.find((layer) => layer !== currentLayer);
    if (this.layers.length >= this.maxLayers && replaceable) this.remove(replaceable);

    candidate = this.layerFactory(LayerClass);
    candidate.setActive?.(false);
    this.layerEffects.setLayerOpacity(candidate, 0);
    this.layers.push(candidate);
    return candidate;
  }

  activate(layer) {
    if (!layer || !this.layers.includes(layer) || !this.targetMap.hasLayer(layer)) {
      throw new Error("SampledGridLayerPool cannot activate an unmanaged layer");
    }
    this.layerEffects.invalidate?.("layer_activate");
    for (const candidate of this.layers) candidate.setActive?.(false);
    layer.syncViewport?.();
    layer.setActive?.(true);
    this.targetState.gridLayer = layer;
    return layer;
  }

  invalidateActiveContext(reason = "scope_invalidated") {
    this.beginRenderTransaction(reason);
    const active = this.targetState.gridLayer;
    let invalidated = false;
    for (const layer of this.layers) {
      layer.setActive?.(false);
      layer.invalidateRenderContext?.(reason);
      this.layerEffects.setLayerOpacity(layer, 0);
      invalidated = true;
    }
    this.targetState.renderedSampledGridDate = null;
    return Boolean(active && invalidated);
  }

  discard(layer) {
    return this.remove(layer);
  }

  clear() {
    this.beginRenderTransaction("pool_clear");
    for (const layer of [...this.layers]) this.remove(layer);
    this.layers = [];
    this.targetState.sampledGridRetiringLayers = [];
    this.targetState.gridLayer = null;
  }

  snapshot() {
    return Object.freeze({
      size: this.layers.length,
      maxLayers: this.maxLayers,
      active: this.targetState.gridLayer || null,
      renderEpoch: this.renderEpoch,
      pendingIdentity: this.pendingRender?.payload?.identity || null,
    });
  }

  dispose() {
    this.unsubscribeLandMask?.();
    this.unsubscribeLandMask = null;
    this.unsubscribeRendererCapability?.();
    this.unsubscribeRendererCapability = null;
    if (this.capabilityRecoveryFrame !== null) {
      this.renderClock?.cancel?.(this.capabilityRecoveryFrame);
      this.capabilityRecoveryFrame = null;
    }
    this.commitPendingRender = null;
    this.clear();
  }
}

if (typeof globalThis !== "undefined") globalThis.SampledGridLayerPoolCore = SampledGridLayerPoolCore;
