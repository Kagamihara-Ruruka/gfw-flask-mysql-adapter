class SampledGridLayerTransitionControllerCore {
  constructor({ targetMap, targetState, renderClock } = {}) {
    if (
      !targetMap
      || !targetState
      || !renderClock
      || typeof renderClock.request !== "function"
      || typeof renderClock.cancel !== "function"
      || typeof renderClock.schedule !== "function"
      || typeof renderClock.cancelSchedule !== "function"
    ) {
      throw new TypeError("SampledGridLayerTransitionController requires map, state and render clock");
    }
    this.targetMap = targetMap;
    this.targetState = targetState;
    this.renderClock = renderClock;
    this.revision = 0;
    this.frameHandles = new Set();
    this.timerHandles = new Set();
    this.disposed = false;
  }

  transitionMs() {
    const baseMs = Math.max(0, Number(this.targetState.sampledGridTransitionMs ?? 0));
    if (typeof PlaybackInterpolationController !== "undefined") {
      const playbackActive = typeof PlaybackRuntime !== "undefined" && PlaybackRuntime.isActive();
      return PlaybackInterpolationController.playbackTransitionMs(
        this.targetState,
        baseMs,
        { playbackActive },
      );
    }
    return baseMs;
  }

  blurPx() {
    return Math.max(0, Number(this.targetState.sampledGridZoomBlurPx ?? 0));
  }

  layerElement(layer) {
    return layer?._canvas || null;
  }

  setPaneOpacity(opacity) {
    const pane = this.targetMap.getPane("sampledGridPane");
    if (pane) pane.style.opacity = String(opacity);
  }

  setPaneBlur(active) {
    const pane = this.targetMap.getPane("sampledGridPane");
    if (!pane) return;
    const px = this.blurPx();
    pane.style.filter = active && px > 0 ? `blur(${px}px)` : "";
  }

  syncTransitionStyle() {
    const pane = this.targetMap.getPane("sampledGridPane");
    if (!pane) return;
    pane.style.opacity = "1";
    pane.style.transition = `filter ${this.transitionMs()}ms ease`;
  }

  setLayerTransition(layer) {
    const element = this.layerElement(layer);
    if (!element) return;
    const ms = this.transitionMs();
    element.style.transition = `opacity ${ms}ms ease, filter ${ms}ms ease`;
  }

  setLayerOpacity(layer, opacity) {
    const element = this.layerElement(layer);
    if (element) element.style.opacity = String(opacity);
  }

  setLayerBlur(layer, active) {
    const element = this.layerElement(layer);
    if (!element) return;
    const px = this.blurPx();
    element.style.filter = active && px > 0 ? `blur(${px}px)` : "";
  }

  request(token, callback) {
    const handle = this.renderClock.request(() => {
      this.frameHandles.delete(handle);
      if (this.isCurrent(token)) callback();
    });
    this.frameHandles.add(handle);
    return handle;
  }

  schedule(token, callback, delayMs) {
    const handle = this.renderClock.schedule(() => {
      this.timerHandles.delete(handle);
      if (this.isCurrent(token)) callback();
    }, delayMs);
    this.timerHandles.add(handle);
    return handle;
  }

  isCurrent(token) {
    return !this.disposed && token === this.revision;
  }

  cancelScheduledWork() {
    for (const handle of this.frameHandles) this.renderClock.cancel(handle);
    for (const handle of this.timerHandles) this.renderClock.cancelSchedule(handle);
    this.frameHandles.clear();
    this.timerHandles.clear();
  }

  invalidate(_reason = "invalidated") {
    this.revision += 1;
    this.cancelScheduledWork();
    this.setPaneBlur(false);
    this.setPaneOpacity(1);
    const active = this.targetState.gridLayer;
    this.setLayerBlur(active, false);
    this.setLayerOpacity(active, 1);
    return this.revision;
  }

  fadeOut() {
    const active = this.targetState.gridLayer;
    if (!active || !this.targetMap.hasLayer(active)) return;
    this.invalidate("fade_out");
    this.syncTransitionStyle();
    this.setLayerTransition(active);
    this.setLayerBlur(active, true);
  }

  reveal() {
    this.invalidate("reveal");
  }

  removeRetiredLayer(layer) {
    if (!layer) return;
    if (this.targetMap.hasLayer(layer)) this.targetMap.removeLayer(layer);
    if (Array.isArray(this.targetState.sampledGridRetiringLayers)) {
      this.targetState.sampledGridRetiringLayers = this.targetState.sampledGridRetiringLayers
        .filter((item) => item !== layer);
    }
  }

  removeRetiredLayers() {
    const retiring = Array.isArray(this.targetState.sampledGridRetiringLayers)
      ? [...this.targetState.sampledGridRetiringLayers]
      : [];
    for (const layer of retiring) this.removeRetiredLayer(layer);
  }

  crossfade({ previousLayer, nextLayer, retainPrevious = false } = {}) {
    const token = this.invalidate("crossfade");
    this.syncTransitionStyle();
    this.setLayerTransition(nextLayer);
    this.setLayerBlur(nextLayer, false);

    if (!previousLayer || previousLayer === nextLayer || !this.targetMap.hasLayer(previousLayer)) {
      this.setLayerOpacity(nextLayer, 1);
      return token;
    }

    this.setLayerTransition(previousLayer);
    this.setLayerBlur(previousLayer, false);
    this.setLayerOpacity(nextLayer, 0);
    if (!retainPrevious) {
      this.targetState.sampledGridRetiringLayers ||= [];
      if (!this.targetState.sampledGridRetiringLayers.includes(previousLayer)) {
        this.targetState.sampledGridRetiringLayers.push(previousLayer);
      }
    }

    this.request(token, () => {
      this.request(token, () => {
        this.setLayerOpacity(nextLayer, 1);
        this.setLayerOpacity(previousLayer, 0);
      });
    });

    this.schedule(token, () => {
      if (retainPrevious) {
        if (this.targetState.gridLayer !== previousLayer) this.setLayerOpacity(previousLayer, 0);
      } else if (this.targetState.gridLayer !== previousLayer) {
        this.removeRetiredLayer(previousLayer);
      }
    }, this.transitionMs() + 80);
    return token;
  }

  dispose() {
    if (this.disposed) return;
    this.invalidate("disposed");
    this.removeRetiredLayers();
    this.disposed = true;
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.SampledGridLayerTransitionControllerCore = SampledGridLayerTransitionControllerCore;
}
