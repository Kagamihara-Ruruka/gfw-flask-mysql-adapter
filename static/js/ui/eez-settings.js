function bindEezPaintControls() {
  bindStateStyleControls({
    source: state.eezPaint,
    controls: [
      ["eez-fill-color", "fillColor", "value"],
      ["eez-boundary-color", "boundaryColor", "value"],
      ["eez-fill-opacity", "fillOpacity", "number"],
      ["eez-boundary-opacity", "boundaryOpacity", "number"],
    ],
    repaint: repaintEezLayer,
    repaintDelayMs: 140,
  });
}
