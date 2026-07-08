function eezStyle(feature) {
  return {
    color: state.eezPaint.boundaryColor,
    weight: 2.4,
    opacity: state.eezPaint.boundaryOpacity,
    fillColor: state.eezPaint.fillColor,
    fillOpacity: state.eezPaint.fillOpacity,
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
  return {
    stroke: false,
    color: "transparent",
    weight: 0,
    opacity: 0,
    fill: true,
    fillColor: state.eezPaint.fillColor,
    fillOpacity: state.eezPaint.fillOpacity,
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

function clearEezLayerForReload() {
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
  if (!$("eez-toggle").checked || !hasActiveEezVectorTiles()) return false;
  RenderState.loading("eez", reason);
  TimingMetrics.setText("eez-ms", "更新中");
  return true;
}

async function refreshEezTileReadiness(reason = "瓦片快取") {
  if (!$("eez-toggle").checked) {
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
  const fillLayer = createEezVectorGrid("/api/overlays/eez/tiles/{z}/{x}/{y}.pbf?v=eez-fill-lod-v6", {
    pane: paneName,
    rendererFactory,
    maxNativeZoom: 14,
    interactive: false,
    vectorTileLayerStyles: {
      eez: eezVectorTileStyle,
    },
  });
  const boundaryLayer = createEezVectorGrid("/api/overlays/eez/boundary/tiles/{z}/{x}/{y}.pbf?v=eez-boundary-lod-v6", {
    pane: paneName,
    rendererFactory,
    maxNativeZoom: 14,
    interactive: false,
    vectorTileLayerStyles: {
      eez_boundary: eezBoundaryTileStyle,
    },
  });
  return {
    layer: L.layerGroup([fillLayer, boundaryLayer]),
    tileLayers: [fillLayer, boundaryLayer],
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
  clearEezLayerForReload();
  if (!$("eez-toggle").checked) {
    TimingMetrics.setText("eez-ms", "關閉");
    RenderState.off("eez", "關閉");
    return;
  }
  if (canUseEezVectorTiles()) {
    const paneName = state.eezStagePane || otherEezPaneName(state.eezActivePane);
    setEezPaneVisibility(paneName, false);
    const staged = createEezVectorTileLayer(paneName);
    staged.layer.addTo(map);
    applyLayerOrder();
    try {
      await TimingMetrics.waitForLayers(staged.tileLayers, 8000);
    } catch (err) {
      if (map.hasLayer(staged.layer)) {
        map.removeLayer(staged.layer);
      }
      if (seq === state.eezSeq) {
        TimingMetrics.setText("eez-ms", "失敗");
        RenderState.fail(transaction, "瓦片載入失敗");
        setStatus(err.message || "EEZ 瓦片載入失敗", true);
      }
      return;
    }
    if (seq !== state.eezSeq || !RenderState.isCurrent(transaction)) {
      if (map.hasLayer(staged.layer)) {
        map.removeLayer(staged.layer);
      }
      return;
    }
    state.eezActivePane = paneName;
    state.eezStagePane = otherEezPaneName(paneName);
    state.eezMode = "mvt";
    state.eezLayer = staged.layer;
    state.eezTileLayers = staged.tileLayers;
    setRenderedLodZoom("eez");
    setEezPaneVisibility(state.eezActivePane, true);
    TimingMetrics.setMs("eez-ms", timing.elapsed());
    TimingMetrics.updateSummary();
    RenderState.finish(transaction, { eez: "瓦片就緒" });
    setStatus("EEZ MVT 瓦片就緒");
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
  if ($("eez-toggle").checked) {
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
