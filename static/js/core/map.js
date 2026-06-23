const map = L.map("map", {
  preferCanvas: true,
  worldCopyJump: true,
  minZoom: 2,
}).setView([18, 122], 3);

window.__rrkalMap = map;

map.createPane("eezPane");
map.getPane("eezPane").style.zIndex = 520;
map.getPane("eezPane").style.pointerEvents = "none";

map.createPane("gfwPane");
map.getPane("gfwPane").style.zIndex = 570;
map.getPane("gfwPane").style.pointerEvents = "none";

map.createPane("aisPane");
map.getPane("aisPane").style.zIndex = 610;
map.getPane("aisPane").style.pointerEvents = "none";

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
  attribution: "OpenStreetMap, CARTO",
  subdomains: "abcd",
}).addTo(map);
