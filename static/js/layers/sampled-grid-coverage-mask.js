const SampledGridCoverageMaskLayer = L.Layer.extend({
  initialize(definition) {
    this._definition = definition;
  },

  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "sampled-grid-coverage-mask");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    targetMap.getPane("sampledGridMaskPane").appendChild(this._canvas);
    targetMap.on("move zoom resize", this._reset, this);
    this._reset();
  },

  onRemove(targetMap) {
    targetMap.off("move zoom resize", this._reset, this);
    L.DomUtil.remove(this._canvas);
  },

  setDefinition(definition) {
    this._definition = definition;
    this._draw();
    return this;
  },

  bringToFront() {
    const pane = this._map?.getPane("sampledGridMaskPane");
    if (pane && this._canvas) pane.appendChild(this._canvas);
    return this;
  },

  _reset() {
    if (!this._map || !this._canvas) return;
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._draw();
  },

  _drawCoverageHole(bounds, longitudeOffset) {
    const nw = this._map.latLngToContainerPoint([
      bounds.north,
      bounds.west + longitudeOffset,
    ]);
    const se = this._map.latLngToContainerPoint([
      bounds.south,
      bounds.east + longitudeOffset,
    ]);
    const x = Math.floor(Math.min(nw.x, se.x)) - 1;
    const y = Math.floor(Math.min(nw.y, se.y)) - 1;
    const width = Math.ceil(Math.abs(se.x - nw.x)) + 2;
    const height = Math.ceil(Math.abs(se.y - nw.y)) + 2;
    this._ctx.fillRect(x, y, width, height);
  },

  _draw() {
    if (!this._ctx || !this._map || !this._definition) return;
    const { color, opacity, coverages } = this._definition;
    const size = this._map.getSize();
    const ctx = this._ctx;
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    for (const coverage of coverages) {
      for (const longitudeOffset of [-360, 0, 360]) {
        this._drawCoverageHole(coverage.bounds, longitudeOffset);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  },
});

const SampledGridCoverageMask = (() => {
  let activeLayer = null;

  function normalizedBounds(value) {
    const bounds = value?.bounds || {};
    const normalized = {
      west: Number(bounds.west),
      south: Number(bounds.south),
      east: Number(bounds.east),
      north: Number(bounds.north),
    };
    if (!Object.values(normalized).every(Number.isFinite)) return null;
    if (normalized.west >= normalized.east || normalized.south >= normalized.north) return null;
    return normalized;
  }

  function definitionForDataset(dataset) {
    const contract = dataset?.sampled_grid || {};
    const config = contract.visualization?.coverage_mask || {};
    if (config.enabled !== true) return null;
    const color = String(config.color || "").trim();
    const opacity = Number(config.opacity);
    const coverages = (contract.coverage_areas || [])
      .map((coverage) => ({ ...coverage, bounds: normalizedBounds(coverage) }))
      .filter((coverage) => coverage.bounds);
    if (!color || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !coverages.length) {
      return null;
    }
    return { color, opacity, coverages };
  }

  function remove(targetMap) {
    if (activeLayer && targetMap.hasLayer(activeLayer)) targetMap.removeLayer(activeLayer);
    activeLayer = null;
  }

  function sync(targetMap, dataset) {
    const definition = definitionForDataset(dataset);
    if (!definition) {
      remove(targetMap);
      return null;
    }
    if (!activeLayer) {
      activeLayer = new SampledGridCoverageMaskLayer(definition).addTo(targetMap);
    } else {
      activeLayer.setDefinition(definition);
    }
    return activeLayer.bringToFront();
  }

  return {
    Layer: SampledGridCoverageMaskLayer,
    definitionForDataset,
    remove,
    sync,
  };
})();

window.SampledGridCoverageMask = SampledGridCoverageMask;
