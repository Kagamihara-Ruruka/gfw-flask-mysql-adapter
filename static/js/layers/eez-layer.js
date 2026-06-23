function eezStyle(feature) {
  const iso = feature?.properties?.iso3 || "";
  const hue = Array.from(iso).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 36;
  return {
    color: `hsl(${185 + hue}, 92%, 36%)`,
    weight: 2.4,
    opacity: 1,
    fillColor: "#34b6d7",
    fillOpacity: 0.08,
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
  const iso = properties?.iso3 || "";
  const hue = Array.from(iso).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 72;
  return {
    stroke: false,
    color: "transparent",
    weight: 0,
    opacity: 0,
    fill: true,
    fillColor: `hsl(${175 + hue}, 78%, 48%)`,
    fillOpacity: zoom <= 4 ? 0.055 : 0.11,
  };
}

function eezBoundaryTileStyle(properties, zoom) {
  const iso = properties?.iso3 || "";
  const hue = Array.from(iso).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 36;
  return {
    fill: false,
    color: `hsl(${185 + hue}, 92%, 32%)`,
    weight: zoom <= 4 ? 0.8 : 1.5,
    opacity: 0.88,
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

function ensureEezVectorTileLayer() {
  if (state.eezLayer && state.eezMode === "mvt") {
    return state.eezLayer;
  }
  if (state.eezLayer && map.hasLayer(state.eezLayer)) {
    map.removeLayer(state.eezLayer);
  }
  const rendererFactory = L.canvas?.tile || L.svg.tile;
  const fillLayer = createEezVectorGrid("/api/overlays/eez/tiles/{z}/{x}/{y}.pbf?v=eez-fill-v4", {
    pane: "eezPane",
    rendererFactory,
    maxNativeZoom: 14,
    interactive: false,
    vectorTileLayerStyles: {
      eez: eezVectorTileStyle,
    },
  });
  const boundaryLayer = createEezVectorGrid("/api/overlays/eez/boundary/tiles/{z}/{x}/{y}.pbf?v=eez-boundary-v5", {
    pane: "eezPane",
    rendererFactory,
    maxNativeZoom: 14,
    interactive: false,
    vectorTileLayerStyles: {
      eez_boundary: eezBoundaryTileStyle,
    },
  });
  state.eezMode = "mvt";
  state.eezTileLayers = [fillLayer, boundaryLayer];
  state.eezLayer = L.layerGroup([fillLayer, boundaryLayer]);
  return state.eezLayer;
}

async function reloadEezLayer() {
  const timing = TimingMetrics.stopwatch();
  TimingMetrics.setText("eez-ms", "loading");
  const seq = ++state.eezSeq;
  if (!$("eez-toggle").checked) {
    syncEezLayer();
    TimingMetrics.setText("eez-ms", "off");
    return;
  }
  if (canUseEezVectorTiles()) {
    const layer = ensureEezVectorTileLayer();
    if (!map.hasLayer(layer)) {
      layer.addTo(map);
    }
    applyLayerOrder();
    await TimingMetrics.waitForLayers(state.eezTileLayers, 8000);
    if (seq !== state.eezSeq) return;
    TimingMetrics.setMs("eez-ms", timing.elapsed());
    TimingMetrics.updateSummary();
    setStatus("EEZ MVT tiles");
    return;
  }
  setStatus("loading EEZ");
  const params = new URLSearchParams();
  params.set("bbox", currentBbox());
  params.set("zoom", String(map.getZoom()));
  const geojson = await fetchJson(`/api/overlays/eez?${params}`);
  if (seq !== state.eezSeq) return;
  if (state.eezLayer) {
    map.removeLayer(state.eezLayer);
  }
  state.eezMode = "geojson";
  state.eezLayer = L.geoJSON(geojson, {
    pane: "eezPane",
    style: eezStyle,
    onEachFeature(feature, layer) {
      layer.bindPopup(eezPopup(feature));
    },
  });
  state.eezLayer.addTo(map);
  applyLayerOrder();
  TimingMetrics.setMs("eez-ms", timing.elapsed());
  TimingMetrics.updateSummary();
  setStatus(`EEZ GeoJSON fallback ${geojson.feature_count}/${geojson.total_feature_count}, ${geojson.detail}`);
}

function syncEezLayer() {
  if (!state.eezLayer) return;
  if ($("eez-toggle").checked) {
    if (!map.hasLayer(state.eezLayer)) {
      state.eezLayer.addTo(map);
    }
    applyLayerOrder();
  } else if (map.hasLayer(state.eezLayer)) {
    map.removeLayer(state.eezLayer);
  }
}
