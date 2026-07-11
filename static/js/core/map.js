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
    label: "CARTO 淺色",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap, CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    },
  },
  carto_dark: {
    label: "CARTO 深色",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap, CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    },
  },
  carto_voyager: {
    label: "CARTO Voyager",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap, CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    },
  },
  osm_standard: {
    label: "OSM 標準",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap contributors",
      maxZoom: 19,
    },
  },
  osm_hot: {
    label: "OSM Humanitarian",
    url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap contributors, HOT",
      subdomains: "abc",
      maxZoom: 19,
    },
  },
  opentopo_terrain: {
    label: "OpenTopo 地形",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    options: {
      attribution: "OpenStreetMap, SRTM, OpenTopoMap",
      subdomains: "abc",
      maxZoom: 17,
    },
  },
  esri_ocean_basemap: {
    label: "Esri Ocean",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: "Esri, GEBCO, NOAA, National Geographic, Garmin, HERE, Geonames.org, and other contributors",
      maxZoom: 13,
    },
  },
  esri_topo: {
    label: "Esri 地形",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: "Esri and contributors",
      maxZoom: 19,
    },
  },
  esri_streets: {
    label: "Esri 街道",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: "Esri and contributors",
      maxZoom: 19,
    },
  },
  esri_imagery: {
    label: "Esri 衛星",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      maxZoom: 19,
    },
  },
};

const BASEMAP_ALIASES = {
  esri_ocean: "esri_ocean_basemap",
};

let currentBasemapLayer = null;

function setBasemap(basemapId) {
  const normalizedBasemapId = BASEMAP_ALIASES[basemapId] || basemapId;
  const nextBasemapId = BASEMAPS[normalizedBasemapId] ? normalizedBasemapId : "carto_light";
  const definition = BASEMAPS[nextBasemapId];
  if (currentBasemapLayer) {
    map.removeLayer(currentBasemapLayer);
  }
  currentBasemapLayer = L.tileLayer(definition.url, definition.options).addTo(map);
  currentBasemapLayer.setZIndex(100);
  state.mapSettings.basemapId = nextBasemapId;
}

function getCurrentBasemapAttribution() {
  const definition = BASEMAPS[state.mapSettings.basemapId] || BASEMAPS.carto_light;
  return definition.options.attribution;
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

const MapViewActions = Object.freeze({
  reset: resetMapView,
  world: fitWorldView,
  taiwan: fitTaiwanView,
});

window.MapViewActions = MapViewActions;
window.addEventListener("rrkal:map-view-action", (event) => {
  const run = MapViewActions[event.detail?.id];
  if (typeof run === "function") run();
});
