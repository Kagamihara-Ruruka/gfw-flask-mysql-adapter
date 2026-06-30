const GFW_CELL_HALF_DEGREES = 0.0416667;
const GFW_CELL_DEGREES = GFW_CELL_HALF_DEGREES * 2;

function gfwCellCenter(value) {
  return Math.round(value / GFW_CELL_DEGREES) * GFW_CELL_DEGREES;
}

function bboxStringFromBounds(bounds) {
  const west = Math.max(-180, bounds.getWest());
  const south = Math.max(-90, bounds.getSouth());
  const east = Math.min(180, bounds.getEast());
  const north = Math.min(90, bounds.getNorth());
  return [west, south, east, north].map((value) => value.toFixed(6)).join(",");
}

function currentBbox() {
  return bboxStringFromBounds(map.getBounds());
}

function bboxForCenterZoom(center, zoom) {
  const size = map.getSize();
  const projectedCenter = map.project(center, zoom);
  const northWest = map.unproject(
    L.point(projectedCenter.x - size.x / 2, projectedCenter.y - size.y / 2),
    zoom
  );
  const southEast = map.unproject(
    L.point(projectedCenter.x + size.x / 2, projectedCenter.y + size.y / 2),
    zoom
  );
  return bboxStringFromBounds(L.latLngBounds([southEast.lat, northWest.lng], [northWest.lat, southEast.lng]));
}

function currentLodZoom() {
  return Math.round(map.getZoom());
}

function setRenderedLodZoom(layerId, zoom = currentLodZoom()) {
  if (!state.renderedLodZoom) {
    state.renderedLodZoom = {};
  }
  state.renderedLodZoom[layerId] = zoom;
}

function clearRenderedLodZoom(layerId) {
  if (!state.renderedLodZoom) return;
  state.renderedLodZoom[layerId] = null;
}

function isLodZoomEvent(event) {
  return event?.type === "zoomstart" || event?.type === "zoomend";
}

function normalizeLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function currentWrappedBboxes() {
  const bounds = map.getBounds();
  const south = Math.max(-90, bounds.getSouth());
  const north = Math.min(90, bounds.getNorth());
  const rawWest = bounds.getWest();
  const rawEast = bounds.getEast();
  if (rawEast - rawWest >= 360) {
    return [[-180, south, 180, north].map((value) => value.toFixed(6)).join(",")];
  }
  const segments = [];
  const startWorld = Math.floor((rawWest + 180) / 360);
  const endWorld = Math.floor((rawEast + 180) / 360);
  for (let world = startWorld; world <= endWorld; world += 1) {
    const worldWest = -180 + world * 360;
    const worldEast = 180 + world * 360;
    const west = Math.max(rawWest, worldWest);
    const east = Math.min(rawEast, worldEast);
    if (east < west) continue;
    segments.push([normalizeLongitude(west), south, normalizeLongitude(east), north]);
  }
  const normalized = [];
  for (const [west, boxSouth, east, boxNorth] of segments) {
    if (west <= east) {
      normalized.push([west, boxSouth, east, boxNorth]);
    } else {
      normalized.push([west, boxSouth, 180, boxNorth], [-180, boxSouth, east, boxNorth]);
    }
  }
  return normalized.map((bbox) => bbox.map((value) => value.toFixed(6)).join(","));
}

function wrappedLongitudesForViewport(lon) {
  const bounds = map.getBounds();
  const startWorld = Math.floor((bounds.getWest() - lon) / 360) - 1;
  const endWorld = Math.ceil((bounds.getEast() - lon) / 360) + 1;
  const values = [];
  for (let world = startWorld; world <= endWorld; world += 1) {
    values.push(lon + world * 360);
  }
  return values;
}
