class SampledGridLayerPoolCore {
  constructor({ targetMap, targetState, layerFactory, layerEffects, maxLayers = 2 } = {}) {
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
  }

  matches(layer, LayerClass) {
    return Boolean(layer && LayerClass && layer.constructor === LayerClass && !layer._failed);
  }

  remove(layer) {
    if (!layer) return false;
    if (this.targetMap.hasLayer(layer)) this.targetMap.removeLayer(layer);
    this.layers = this.layers.filter((candidate) => candidate !== layer);
    if (this.targetState.gridLayer === layer) this.targetState.gridLayer = null;
    return true;
  }

  acquire(LayerClass, { currentLayer = this.targetState.gridLayer } = {}) {
    let candidate = this.layers.find((layer) => (
      layer !== currentLayer && this.matches(layer, LayerClass)
    ));
    if (candidate) {
      this.layerEffects.setLayerOpacity(candidate, 0);
      return candidate;
    }

    const replaceable = this.layers.find((layer) => layer !== currentLayer);
    if (this.layers.length >= this.maxLayers && replaceable) this.remove(replaceable);

    candidate = this.layerFactory(LayerClass);
    this.layerEffects.setLayerOpacity(candidate, 0);
    this.layers.push(candidate);
    return candidate;
  }

  discard(layer) {
    return this.remove(layer);
  }

  clear() {
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
    });
  }

  dispose() {
    this.clear();
  }
}

if (typeof globalThis !== "undefined") globalThis.SampledGridLayerPoolCore = SampledGridLayerPoolCore;
