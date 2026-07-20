const EezPolTypeStyle = Object.freeze({
  normal: Object.freeze({ colorKey: "fillColor" }),
  disputed: Object.freeze({ colorKey: "disputed", fallbackColor: "#ef5b5b" }),
  joint: Object.freeze({ colorKey: "joint", fallbackColor: "#f5a524" }),
  other: Object.freeze({ colorKey: "other", fallbackColor: "#94a3b8" }),
});

function eezPolTypeKind(properties = {}) {
  const polType = String(properties.pol_type || properties.POL_TYPE || "").trim().toLowerCase();
  if (polType === "overlapping claim") return "disputed";
  if (polType === "joint regime") return "joint";
  if (polType === "200nm") return "normal";
  return "other";
}

function eezFillPaint(properties = {}) {
  const kind = eezPolTypeKind(properties);
  const style = EezPolTypeStyle[kind] || EezPolTypeStyle.other;
  const baseOpacity = Number(state.eezPaint.fillOpacity);
  return {
    kind,
    fillColor: eezPolTypeFillColor(kind, style),
    fillOpacity: Math.min(0.28, Math.max(0, Number.isFinite(baseOpacity) ? baseOpacity : 0.08)),
  };
}

function eezPolTypeFillColor(kind, style) {
  if (kind === "normal") return state.eezPaint.fillColor;
  return state.eezPaint.polTypeColors?.[style.colorKey] || style.fallbackColor || state.eezPaint.fillColor;
}

function eezStyle(feature) {
  const fillPaint = eezFillPaint(feature?.properties || {});
  return {
    color: state.eezPaint.boundaryColor,
    weight: 2.4,
    opacity: state.eezPaint.boundaryOpacity,
    fillColor: fillPaint.fillColor,
    fillOpacity: fillPaint.fillOpacity,
  };
}

function eezPopup(feature) {
  const props = feature?.properties || {};
  const iso = props.iso3 || "unknown";
  const name = props.name || iso;
  return [
    `<strong>${escapeHtml(iso)} EEZ</strong>`,
    escapeHtml(name),
  ].join("<br>");
}

function eezVectorTileStyle(properties, zoom) {
  const fillPaint = eezFillPaint(properties);
  return {
    stroke: false,
    color: "transparent",
    weight: 0,
    opacity: 0,
    fill: true,
    fillColor: fillPaint.fillColor,
    fillOpacity: fillPaint.fillOpacity,
  };
}

function eezBoundaryTileStyle(properties, zoom) {
  return {
    fill: false,
    color: state.eezPaint.boundaryColor,
    weight: zoom <= 4 ? 0.8 : 1.5,
    opacity: state.eezPaint.boundaryOpacity,
  };
}

function canUseEezVectorTiles() {
  return Boolean(window.L?.vectorGrid?.protobuf || window.L?.VectorGrid?.Protobuf);
}

function eezLandMaskCapability() {
  return window.LayerRuntimeContractRegistry?.capability?.("eez", "land_mask_provider") || {};
}

function eezHighSeasCapability() {
  return window.LayerRuntimeContractRegistry?.capability?.("eez", "high_seas_overlay") || {};
}

function eezDomainTileUrl(kind, coordinates) {
  const capability = kind === "high_seas"
    ? eezHighSeasCapability()
    : eezLandMaskCapability();
  const template = capability.tile_template;
  if (capability.status !== "supported" || !template) return "";
  const path = String(template)
    .replace("{z}", String(coordinates.z))
    .replace("{x}", String(coordinates.x))
    .replace("{y}", String(coordinates.y));
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}source_version=${encodeURIComponent(capability.source_version || "unknown")}`;
}

const EezDomainGridLayer = L.GridLayer.extend({
  initialize({ kind, pane }) {
    L.GridLayer.prototype.initialize.call(this, {
      pane,
      tileSize: 256,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 0,
    });
    this.kind = kind;
  },
  createTile(coordinates, done) {
    const tile = document.createElement("canvas");
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const url = eezDomainTileUrl(this.kind, coordinates);
    if (!url) {
      queueMicrotask(() => done(null, tile));
      return tile;
    }
    const image = new Image();
    image.onload = () => {
      const context = tile.getContext("2d", { alpha: true });
      context.clearRect(0, 0, size.x, size.y);
      context.drawImage(image, 0, 0, size.x, size.y);
      context.globalCompositeOperation = "source-in";
      context.globalAlpha = Math.min(0.28, Math.max(0, Number(state.eezPaint.fillOpacity) || 0.08));
      context.fillStyle = state.eezPaint.polTypeColors?.high_seas || "#5578a8";
      context.fillRect(0, 0, size.x, size.y);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      done(null, tile);
    };
    image.onerror = () => done(new Error(`EEZ ${this.kind} tile failed`), tile);
    image.src = url;
    return tile;
  },
});

function createEezVectorGrid(url, options) {
  if (window.L?.vectorGrid?.protobuf) {
    return L.vectorGrid.protobuf(url, options);
  }
  return new L.VectorGrid.Protobuf(url, options);
}

function otherEezPaneName(paneName) {
  return paneName === "eezPaneA" ? "eezPaneB" : "eezPaneA";
}

function setEezPaneVisibility(activePaneName, visible) {
  for (const paneName of ["eezPaneA", "eezPaneB"]) {
    const pane = map.getPane(paneName);
    if (!pane) continue;
    pane.style.opacity = visible && paneName === activePaneName ? String(state.layerAlpha.eez) : "0";
  }
}

function clearEezLayerForReload({ invalidatePending = true } = {}) {
  if (invalidatePending) state.eezSeq += 1;
  if (state.eezLayer && map.hasLayer(state.eezLayer)) {
    map.removeLayer(state.eezLayer);
  }
  state.eezLayer = null;
  state.eezTileLayers = [];
  state.eezMode = null;
  clearRenderedLodZoom("eez");
  setEezPaneVisibility(state.eezActivePane, false);
}

function hasActiveEezVectorTiles() {
  return state.eezMode === "mvt" && state.eezLayer && state.eezTileLayers.length > 0;
}

function markEezTilesUpdating(reason = "瓦片更新中") {
  if (!$("eez-toggle")?.checked || !hasActiveEezVectorTiles()) return false;
  RenderState.loading("eez", reason);
  TimingMetrics.setText("eez-ms", "更新中");
  return true;
}

async function refreshEezTileReadiness(reason = "瓦片快取") {
  if (!$("eez-toggle")?.checked) {
    TimingMetrics.setText("eez-ms", "關閉");
    RenderState.off("eez", "關閉");
    return;
  }
  if (!hasActiveEezVectorTiles()) {
    await reloadEezLayer();
    return;
  }
  const timing = TimingMetrics.stopwatch();
  const seq = ++state.eezSeq;
  const transaction = RenderState.begin("eez", ["eez"]);
  RenderState.loading("eez", reason);
  try {
    await TimingMetrics.waitForLayers(state.eezTileLayers, 180);
  } catch (err) {
    // Persistent vector grids may already have enough tiles and emit no fresh load event.
    // Settle quickly so static EEZ bookkeeping never blocks dynamic data layers.
  }
  if (seq !== state.eezSeq || !RenderState.isCurrent(transaction)) return;
  setRenderedLodZoom("eez");
  setEezPaneVisibility(state.eezActivePane, true);
  TimingMetrics.setMs("eez-ms", timing.elapsed());
  TimingMetrics.updateSummary();
  RenderState.finish(transaction, { eez: "瓦片就緒" });
}

function createEezVectorTileLayer(paneName) {
  const rendererFactory = L.canvas?.tile || L.svg.tile;
  const eezLayer = createEezVectorGrid("/api/overlays/eez/render/tiles/{z}/{x}/{y}.pbf?v=eez-render-v1", {
    pane: paneName,
    rendererFactory,
    maxNativeZoom: 14,
    interactive: false,
    vectorTileLayerStyles: {
      eez: eezVectorTileStyle,
      eez_boundary: eezBoundaryTileStyle,
    },
  });
  const highSeasCapability = eezHighSeasCapability();
  const highSeasLayer = highSeasCapability.status === "supported" && highSeasCapability.tile_template
    ? new EezDomainGridLayer({ kind: "high_seas", pane: paneName })
    : null;
  const tileLayers = [highSeasLayer, eezLayer].filter(Boolean);
  return {
    layer: L.layerGroup(tileLayers),
    tileLayers,
  };
}

async function reloadEezLayer(options = {}) {
  const force = Boolean(options.force);
  if (!force && hasActiveEezVectorTiles()) {
    syncEezLayer();
    await refreshEezTileReadiness("瓦片快取");
    return;
  }
  const timing = TimingMetrics.stopwatch();
  TimingMetrics.setText("eez-ms", "載入中");
  const seq = ++state.eezSeq;
  const transaction = RenderState.begin("eez", ["eez"]);
  clearEezLayerForReload({ invalidatePending: false });
  if (!$("eez-toggle")?.checked) {
    TimingMetrics.setText("eez-ms", "關閉");
    RenderState.off("eez", "關閉");
    return;
  }
  if (canUseEezVectorTiles()) {
    const paneName = state.eezStagePane || otherEezPaneName(state.eezActivePane);
    setEezPaneVisibility(paneName, false);
    const staged = createEezVectorTileLayer(paneName);
    staged.layer.addTo(map);
    state.eezActivePane = paneName;
    state.eezStagePane = otherEezPaneName(paneName);
    state.eezMode = "mvt";
    state.eezLayer = staged.layer;
    state.eezTileLayers = staged.tileLayers;
    setRenderedLodZoom("eez");
    setEezPaneVisibility(state.eezActivePane, true);
    applyLayerOrder();
    let tileWaitTimedOut = false;
    try {
      await TimingMetrics.waitForLayers(staged.tileLayers, 8000);
    } catch (err) {
      tileWaitTimedOut = true;
    }
    if (seq !== state.eezSeq || !RenderState.isCurrent(transaction)) {
      if (map.hasLayer(staged.layer)) {
        map.removeLayer(staged.layer);
      }
      if (state.eezLayer === staged.layer) {
        state.eezLayer = null;
        state.eezTileLayers = [];
        state.eezMode = null;
        setEezPaneVisibility(paneName, false);
      }
      return;
    }
    TimingMetrics.setMs("eez-ms", timing.elapsed());
    TimingMetrics.updateSummary();
    RenderState.finish(transaction, { eez: tileWaitTimedOut ? "瓦片載入中" : "瓦片就緒" });
    setStatus(tileWaitTimedOut ? "EEZ MVT 瓦片載入中" : "EEZ MVT 瓦片就緒");
    return;
  }
  setStatus("正在載入 EEZ");
  const params = new URLSearchParams();
  params.set("bbox", currentBbox());
  params.set("zoom", String(map.getZoom()));
  const geojson = await fetchJson(`/api/overlays/eez?${params}`);
  if (seq !== state.eezSeq || !RenderState.isCurrent(transaction)) return;
  const paneName = state.eezStagePane || otherEezPaneName(state.eezActivePane);
  state.eezMode = "geojson";
  state.eezLayer = L.geoJSON(geojson, {
    pane: paneName,
    style: eezStyle,
    onEachFeature(feature, layer) {
      layer.bindPopup(eezPopup(feature));
    },
  });
  state.eezLayer.addTo(map);
  setRenderedLodZoom("eez");
  state.eezActivePane = paneName;
  state.eezStagePane = otherEezPaneName(paneName);
  setEezPaneVisibility(state.eezActivePane, true);
  applyLayerOrder();
  TimingMetrics.setMs("eez-ms", timing.elapsed());
  TimingMetrics.updateSummary();
  RenderState.finish(transaction, { eez: "GeoJSON 就緒" });
  setStatus(`EEZ GeoJSON 備援 ${geojson.feature_count}/${geojson.total_feature_count}，${geojson.detail}`);
}

function syncEezLayer() {
  if ($("eez-toggle")?.checked) {
    if (!state.eezLayer) {
      RenderState.off("eez", "未載入");
      return;
    }
    if (!map.hasLayer(state.eezLayer)) {
      state.eezLayer.addTo(map);
    }
    setEezPaneVisibility(state.eezActivePane, true);
    RenderState.ready("eez", "就緒");
    applyLayerOrder();
  } else {
    clearEezLayerForReload();
    RenderState.off("eez", "關閉");
  }
}

function repaintEezLayer() {
  if (!state.eezLayer) return;
  if (state.eezMode === "geojson" && state.eezLayer.setStyle) {
    state.eezLayer.setStyle(eezStyle);
    return;
  }
  const wasVisible = map.hasLayer(state.eezLayer);
  if (wasVisible) {
    map.removeLayer(state.eezLayer);
  }
  state.eezLayer = null;
  state.eezTileLayers = [];
  state.eezMode = null;
  if (wasVisible) {
    reloadEezLayer({ force: true }).catch((err) => console.error("EEZ overlay failed", err));
  }
}
