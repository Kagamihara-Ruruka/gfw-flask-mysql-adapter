const SampledGridCanvasLayer = L.Layer.extend({
  initialize() {
    this._rows = [];
    this._hitCells = [];
  },
  onAdd(targetMap) {
    this._map = targetMap;
    this._canvas = L.DomUtil.create("canvas", "grid-canvas-layer");
    this._ctx = this._canvas.getContext("2d", { alpha: true });
    targetMap.getPane("sampledGridPane").appendChild(this._canvas);
    targetMap.on("move zoom resize", this._reset, this);
    this._reset();
  },
  onRemove(targetMap) {
    targetMap.off("move zoom resize", this._reset, this);
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
    const started = performance.now();
    if (!this._ctx || !this._map) return 0;
    const ctx = this._ctx;
    const size = this._map.getSize();
    const model = SampledGridContract.model();
    ctx.clearRect(0, 0, size.x, size.y);
    const layerAlpha = state.layerAlpha[state.dataLayer] ?? state.sampledGridPaint?.alpha ?? 1;
    const hitCells = [];
    for (const row of sampledGridRowsForRender(this._rows)) {
      const bounds = model.bounds(row);
      if (!bounds) continue;
      const nw = this._map.latLngToContainerPoint([bounds.north, bounds.west]);
      const se = this._map.latLngToContainerPoint([bounds.south, bounds.east]);
      const x = Math.floor(Math.min(nw.x, se.x));
      const y = Math.floor(Math.min(nw.y, se.y));
      const w = Math.max(1, Math.ceil(Math.abs(se.x - nw.x)));
      const h = Math.max(1, Math.ceil(Math.abs(se.y - nw.y)));
      if (x > size.x || y > size.y || x + w < 0 || y + h < 0) continue;
      const cellOpacity = sampledGridCellOpacity(row);
      if (cellOpacity > 0) {
        ctx.globalAlpha = layerAlpha * cellOpacity;
        ctx.fillStyle = sampledGridCellColorCss(row);
        ctx.fillRect(x, y, w, h);
      }
      hitCells.push({
        row,
        rect: { x, y, w, h },
        bounds: {
          ...bounds,
          leaflet: L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]),
        },
        center: {
          lat: (bounds.south + bounds.north) / 2,
          lon: normalizeLongitude((bounds.west + bounds.east) / 2),
        },
      });
    }
    this._hitCells = hitCells;
    ctx.globalAlpha = 1;
    return performance.now() - started;
  },
  hitTest(containerPoint) {
    const point = L.point(containerPoint);
    for (let index = this._hitCells.length - 1; index >= 0; index -= 1) {
      const cell = this._hitCells[index];
      const { x, y, w, h } = cell.rect;
      if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) {
        return cell;
      }
    }
    return null;
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
  return SampledGridLayerEffects.waitTransition(state);
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
  SampledGridLayerEffects.crossfade({ targetMap: map, targetState: state, previousLayer, nextLayer });
}

function removeSampledGridLayer() {
  removeRetiredGfwLayers();
  SampledGridCoverageMask.remove(map);
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

function clearSampledGridLayerForLodReload() {
  fadeOutGfwLayer();
  clearRenderedLodZoom(state.dataLayer || "sampled-grid");
  RenderState.loading(state.dataLayer || "sampled-grid", "LOD 更新");
}

function createSampledGridLayer(layerClass) {
  const layer = new layerClass().addTo(map);
  setGfwLayerTransition(layer);
  setGfwLayerOpacity(layer, 0);
  setGfwLayerBlur(layer, false);
  return layer;
}

function renderSampledGridMap(rows) {
  syncGfwTransitionStyle();
  map.invalidateSize();
  removeAisLayer();
  const previousLayer = state.gridLayer && map.hasLayer(state.gridLayer) ? state.gridLayer : null;
  let choice = RendererRegistry.chooseSampledGridLayer(rows, SampledGridCanvasLayer);
  let nextLayer = createSampledGridLayer(choice.LayerClass);
  let drawMs = nextLayer.setRows(rows);
  if (choice.backend === "webgl" && nextLayer._failed) {
    if (map.hasLayer(nextLayer)) map.removeLayer(nextLayer);
    choice = { backend: "canvas", LayerClass: SampledGridCanvasLayer };
    nextLayer = createSampledGridLayer(choice.LayerClass);
    drawMs = nextLayer.setRows(rows);
  }
  state.gridLayer = nextLayer;
  SampledGridCoverageMask.sync(map, state.datasets[state.datasetId]);
  state.renderedSampledGridDate = $("date")?.value || state.renderedSampledGridDate;
  state.renderedGfwDate = state.renderedSampledGridDate;
  setRenderedLodZoom(state.dataLayer || "sampled-grid");
  applyLayerOrder();
  crossfadeGfwLayer(previousLayer, nextLayer);
  return {
    backend: choice.backend,
    drawMs,
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
