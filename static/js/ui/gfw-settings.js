function repaintGfwLayer() {
  if (state.dataLayer !== "gfw" || !state.gridLayer?.setRows) return;
  state.gridLayer.setRows(state.gridLayer._rows || state.rows || []);
}

function bindGfwPaintControls() {
  bindStateStyleControls({
    source: state.gfwPaint,
    controls: [
      ["gfw-low-color", "lowColor", "value"],
      ["gfw-high-color", "highColor", "value"],
      ["gfw-max-fish", "maxFish", "number"],
    ],
    repaint: repaintGfwLayer,
    repaintDelayMs: 80,
  });
}
