function cellColor(row) {
  const fish = Number(row.fish_sum ?? 0);
  const ratio = Math.min(1, Math.max(0, fish / 40));
  const red = Math.round(216 * ratio + 45 * (1 - ratio));
  const green = Math.round(90 * ratio + 130 * (1 - ratio));
  const blue = Math.round(48 * ratio + 150 * (1 - ratio));
  return `rgb(${red},${green},${blue})`;
}

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
    ctx.globalAlpha = state.layerAlpha.gfw;
    for (const row of this._rows) {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const nw = this._map.latLngToContainerPoint([lat + GFW_CELL_HALF_DEGREES, lon - GFW_CELL_HALF_DEGREES]);
      const se = this._map.latLngToContainerPoint([lat - GFW_CELL_HALF_DEGREES, lon + GFW_CELL_HALF_DEGREES]);
      const x = Math.floor(Math.min(nw.x, se.x));
      const y = Math.floor(Math.min(nw.y, se.y));
      const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
      const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      ctx.fillStyle = cellColor(row);
      ctx.fillRect(x, y, w, h);
    }
    ctx.globalAlpha = 1;
  },
});

function removeGfwLayer() {
  if (state.gridLayer && map.hasLayer(state.gridLayer)) {
    map.removeLayer(state.gridLayer);
  }
}

function renderGfwMap(rows) {
  map.invalidateSize();
  removeAisLayer();
  if (!state.gridLayer) {
    state.gridLayer = new GridCanvasLayer().addTo(map);
  } else if (!map.hasLayer(state.gridLayer)) {
    state.gridLayer.addTo(map);
  }
  state.gridLayer.setRows(rows);
  applyLayerOrder();
}
