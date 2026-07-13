function bboxStringFromBounds(bounds) {
  const segments = wrappedBboxesFromValues(
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth()
  );
  if (!segments.length) {
    return "-180.000000,-90.000000,180.000000,90.000000";
  }
  const centerLon = normalizeLongitude((bounds.getWest() + bounds.getEast()) / 2);
  const selected = segments.find(([west, , east]) => centerLon >= west && centerLon <= east)
    || [...segments].sort((left, right) => (right[2] - right[0]) - (left[2] - left[0]))[0];
  return selected.map((value) => value.toFixed(6)).join(",");
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

function wrappedBboxesFromValues(rawWest, rawSouth, rawEast, rawNorth) {
  const south = Math.max(-90, rawSouth);
  const north = Math.min(90, rawNorth);
  if (south >= north) return [];
  if (rawEast - rawWest >= 360) {
    return [[-180, south, 180, north]];
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
  return normalized.filter(([west, boxSouth, east, boxNorth]) => west < east && boxSouth < boxNorth);
}

function currentWrappedBboxes() {
  const bounds = map.getBounds();
  const normalized = wrappedBboxesFromValues(
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth()
  );
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
