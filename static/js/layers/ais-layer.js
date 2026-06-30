const AIS_COLUMNS = ["event_time", "mmsi", "name", "lat", "lon", "speed", "course", "heading"];

function aisDensityColor(count, maxCount) {
  const intensity = Math.log1p(count) / Math.log1p(Math.max(1, maxCount));
  const red = Math.round(34 + intensity * 14);
  const green = Math.round(110 + intensity * 95);
  const blue = Math.round(145 + intensity * 75);
  return {
    color: `rgb(${red},${green},${blue})`,
    alpha: 0.16 + intensity * 0.5,
  };
}

const AisDensityCanvasLayer = L.Layer.extend({
  initialize() {
    this._rows = [];
  },
  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "ais-density-canvas-layer");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    targetMap.getPane("aisPane").appendChild(this._canvas);
    targetMap.on("move zoom resize", this._reset, this);
    this._reset();
  },
  onRemove(targetMap) {
    targetMap.off("move zoom resize", this._reset, this);
    L.DomUtil.remove(this._canvas);
  },
  setRows(rows) {
    this._rows = rows;
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
    ctx.clearRect(0, 0, size.x, size.y);
    const buckets = new Map();
    for (const row of this._rows) {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const latCenter = gfwCellCenter(lat);
      const lonCenter = gfwCellCenter(normalizeLongitude(lon));
      const key = `${latCenter.toFixed(6)}:${lonCenter.toFixed(6)}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const maxCount = Math.max(1, ...buckets.values());
    const alphaScale = state.layerAlpha.ais / 0.58;
    for (const [key, count] of buckets) {
      const [latText, lonText] = key.split(":");
      const lat = Number(latText);
      const lon = Number(lonText);
      for (const wrappedLon of wrappedLongitudesForViewport(lon)) {
        const nw = this._map.latLngToContainerPoint([lat + GFW_CELL_HALF_DEGREES, wrappedLon - GFW_CELL_HALF_DEGREES]);
        const se = this._map.latLngToContainerPoint([lat - GFW_CELL_HALF_DEGREES, wrappedLon + GFW_CELL_HALF_DEGREES]);
        const x = Math.floor(Math.min(nw.x, se.x));
        const y = Math.floor(Math.min(nw.y, se.y));
        const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
        const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
        if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
        const paint = aisDensityColor(count, maxCount);
        ctx.globalAlpha = Math.max(0, Math.min(1, paint.alpha * alphaScale));
        ctx.fillStyle = paint.color;
        ctx.fillRect(x, y, w, h);
      }
    }
    ctx.globalAlpha = 1;
  },
});

const AisPointCanvasLayer = L.Layer.extend({
  initialize() {
    this._rows = [];
  },
  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "ais-point-canvas-layer");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    targetMap.getPane("aisPane").appendChild(this._canvas);
    targetMap.on("move zoom resize", this._reset, this);
    this._reset();
  },
  onRemove(targetMap) {
    targetMap.off("move zoom resize", this._reset, this);
    L.DomUtil.remove(this._canvas);
  },
  setRows(rows) {
    this._rows = rows;
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
    const zoom = this._map.getZoom();
    const radius = Math.max(1.3, Math.min(4.5, zoom * 0.45));
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.globalAlpha = state.layerAlpha.ais;
    ctx.fillStyle = "rgb(28, 145, 190)";
    ctx.strokeStyle = "rgb(255, 255, 255)";
    ctx.lineWidth = 0.7;
    for (const row of this._rows) {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      for (const wrappedLon of wrappedLongitudesForViewport(normalizeLongitude(lon))) {
        const point = this._map.latLngToContainerPoint([lat, wrappedLon]);
        if (point.x < -radius || point.y < -radius || point.x > size.x + radius || point.y > size.y + radius) continue;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        if (radius >= 2.5) {
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  },
});

function removeAisLayer() {
  if (state.aisLayer && map.hasLayer(state.aisLayer)) {
    map.removeLayer(state.aisLayer);
  }
  if (state.dataLayer !== "ais") {
    RenderState.off("ais", "off");
  }
}

function renderAisMap(rows) {
  map.invalidateSize();
  removeGfwLayer();
  const strategy = $("ais-render-strategy").value;
  const LayerClass = strategy === "point_dots" ? AisPointCanvasLayer : AisDensityCanvasLayer;
  if (state.aisLayer && !(state.aisLayer instanceof LayerClass)) {
    removeAisLayer();
    state.aisLayer = null;
  }
  if (!state.aisLayer) {
    state.aisLayer = new LayerClass().addTo(map);
  } else if (!map.hasLayer(state.aisLayer)) {
    state.aisLayer.addTo(map);
  }
  state.aisLayer.setRows(rows);
  applyLayerOrder();
}
