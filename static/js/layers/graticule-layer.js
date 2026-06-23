const GRATICULE_STEPS = [
  { minZoom: 0, step: 30 },
  { minZoom: 4, step: 10 },
  { minZoom: 6, step: 5 },
  { minZoom: 8, step: 2 },
  { minZoom: 10, step: 1 },
  { minZoom: 12, step: 0.5 },
];

function graticuleStepForZoom(zoom) {
  let selected = GRATICULE_STEPS[0].step;
  for (const item of GRATICULE_STEPS) {
    if (zoom >= item.minZoom) selected = item.step;
  }
  return selected;
}

function graticuleLineDash() {
  if (state.mapSettings.graticuleLineStyle === "solid") return [];
  if (state.mapSettings.graticuleLineStyle === "dotted") return [1, 5];
  return [4, 6];
}

function formatLatitude(lat) {
  const abs = Math.abs(lat);
  if (lat === 0) return "0°";
  const value = abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value}° ${lat > 0 ? "N" : "S"}`;
}

function formatLongitude(lon) {
  const normalized = normalizeLongitude(lon);
  const abs = Math.abs(normalized);
  if (normalized === 0) return "0°";
  const value = abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value}° ${normalized > 0 ? "E" : "W"}`;
}

const GraticuleCanvasLayer = L.Layer.extend({
  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "graticule-canvas-layer");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    targetMap.getPane("graticulePane").appendChild(this._canvas);
    targetMap.on("move zoom resize", this._reset, this);
    this._reset();
  },
  onRemove(targetMap) {
    targetMap.off("move zoom resize", this._reset, this);
    L.DomUtil.remove(this._canvas);
  },
  redraw() {
    this._draw();
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
    if (!this._ctx || !this._map) return;
    const ctx = this._ctx;
    const size = this._map.getSize();
    const bounds = this._map.getBounds();
    const zoom = this._map.getZoom();
    const step = graticuleStepForZoom(zoom);
    const alpha = state.mapSettings.graticuleAlpha;
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = state.mapSettings.graticuleColor;
    ctx.lineWidth = state.mapSettings.graticuleLineWidth;
    ctx.setLineDash(graticuleLineDash());
    const south = Math.max(-85, Math.floor(bounds.getSouth() / step) * step);
    const north = Math.min(85, Math.ceil(bounds.getNorth() / step) * step);
    const west = Math.floor(bounds.getWest() / step) * step;
    const east = Math.ceil(bounds.getEast() / step) * step;
    for (let lat = south; lat <= north + (step / 2); lat += step) {
      const y = this._map.latLngToContainerPoint([lat, bounds.getWest()]).y;
      if (y < -2 || y > size.y + 2) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.x, y);
      ctx.stroke();
    }
    for (let lon = west; lon <= east + (step / 2); lon += step) {
      for (const wrappedLon of wrappedLongitudesForViewport(normalizeLongitude(lon))) {
        const x = this._map.latLngToContainerPoint([bounds.getCenter().lat, wrappedLon]).x;
        if (x < -2 || x > size.x + 2) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.y);
        ctx.stroke();
      }
    }
    if (state.mapSettings.graticuleLabels) {
      ctx.setLineDash([]);
      ctx.globalAlpha = Math.min(1, alpha + 0.2);
      ctx.fillStyle = state.mapSettings.graticuleColor;
      ctx.font = "11px Segoe UI, Arial, sans-serif";
      ctx.textBaseline = "middle";
      for (let lat = south; lat <= north + (step / 2); lat += step) {
        const y = this._map.latLngToContainerPoint([lat, bounds.getWest()]).y;
        if (y < 12 || y > size.y - 12) continue;
        ctx.fillText(formatLatitude(lat), 8, y);
      }
      ctx.textBaseline = "top";
      for (let lon = west; lon <= east + (step / 2); lon += step) {
        for (const wrappedLon of wrappedLongitudesForViewport(normalizeLongitude(lon))) {
          const x = this._map.latLngToContainerPoint([bounds.getCenter().lat, wrappedLon]).x;
          if (x < 28 || x > size.x - 28) continue;
          ctx.fillText(formatLongitude(lon), x + 4, 8);
        }
      }
    }
    ctx.restore();
  },
});

function ensureGraticuleLayer() {
  if (!state.graticuleLayer) {
    state.graticuleLayer = new GraticuleCanvasLayer();
  }
  return state.graticuleLayer;
}

function syncGraticuleLayer() {
  const layer = ensureGraticuleLayer();
  if (state.mapSettings.graticuleVisible) {
    if (!map.hasLayer(layer)) {
      layer.addTo(map);
    }
    layer.redraw();
  } else if (map.hasLayer(layer)) {
    map.removeLayer(layer);
  }
}
