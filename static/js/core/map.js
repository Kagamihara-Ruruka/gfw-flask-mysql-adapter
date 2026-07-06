const map = L.map("map", {
  preferCanvas: true,
  worldCopyJump: true,
  minZoom: 2,
  maxBounds: [[-85.05112878, -Infinity], [85.05112878, Infinity]],
  maxBoundsViscosity: 1,
}).setView([18, 122], 3);

window.__rrkalMap = map;

const BASEMAPS = {
  carto_light: {
    label: "Light",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap, CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    },
  },
  carto_dark: {
    label: "Dark",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap, CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    },
  },
  osm_standard: {
    label: "OSM",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap contributors",
      maxZoom: 19,
    },
  },
  opentopo_terrain: {
    label: "Terrain",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap, SRTM, OpenTopoMap",
      subdomains: "abc",
      maxZoom: 17,
    },
  },
  esri_imagery: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      maxZoom: 19,
    },
  },
};

let currentBasemapLayer = null;

function setBasemap(basemapId) {
  const nextBasemapId = BASEMAPS[basemapId] ? basemapId : "carto_light";
  const definition = BASEMAPS[nextBasemapId];
  if (currentBasemapLayer) {
    map.removeLayer(currentBasemapLayer);
  }
  currentBasemapLayer = L.tileLayer(definition.url, definition.options).addTo(map);
  currentBasemapLayer.setZIndex(100);
  state.mapSettings.basemapId = nextBasemapId;
}

function createOverlayPane(name, zIndex) {
  map.createPane(name);
  const pane = map.getPane(name);
  pane.style.zIndex = String(zIndex);
  pane.style.pointerEvents = "none";
  return pane;
}

createOverlayPane("eezPaneA", 520);
createOverlayPane("eezPaneB", 520);
map.getPane("eezPaneA").style.opacity = String(state.layerAlpha.eez);
map.getPane("eezPaneB").style.opacity = "0";

createOverlayPane("graticulePane", 545);

createOverlayPane("gfwPane", 570);
map.getPane("gfwPane").style.opacity = "1";
map.getPane("gfwPane").style.transition = `opacity ${state.gfwTransitionMs}ms ease, filter ${state.gfwTransitionMs}ms ease`;

createOverlayPane("aisPane", 610);

setBasemap(state.mapSettings.basemapId);

const mapScaleControl = L.control.scale({
  position: "bottomleft",
  metric: true,
  imperial: false,
  maxWidth: 160,
});

let isMapScaleVisible = true;
mapScaleControl.addTo(map);

function setMapScaleVisible(visible) {
  isMapScaleVisible = Boolean(visible);
  state.mapSettings.scaleVisible = isMapScaleVisible;
  if (isMapScaleVisible) {
    mapScaleControl.addTo(map);
  } else {
    mapScaleControl.remove();
  }
}

function setMapZoomControlVisible(visible) {
  state.mapSettings.zoomControlVisible = Boolean(visible);
  if (state.mapSettings.zoomControlVisible) {
    map.zoomControl.addTo(map);
  } else {
    map.zoomControl.remove();
  }
}

function setMapInteraction(name, enabled) {
  state.mapSettings[name] = Boolean(enabled);
  const interaction = map[name];
  if (!interaction) return;
  if (state.mapSettings[name]) {
    interaction.enable();
  } else {
    interaction.disable();
  }
}

function resetMapView() {
  map.setView([18, 122], 3);
}

function fitTaiwanView() {
  map.fitBounds([[20.6, 118.0], [26.6, 123.9]], {
    animate: false,
    padding: [20, 20],
  });
}

function fitWorldView() {
  map.fitWorld({
    animate: false,
    padding: [10, 10],
  });
}
