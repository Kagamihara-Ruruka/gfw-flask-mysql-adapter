function repaintGfwLayer() {
  if (state.dataLayer !== "gfw" || !state.gridLayer?.setRows) return;
  state.gridLayer.setRows(state.gridLayer._rows || state.rows || []);
}

function clampGfwRenderCellKm(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return GFW_MIN_RENDER_CELL_KM;
  return Math.max(GFW_MIN_RENDER_CELL_KM, numeric);
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

  const cellInput = $("gfw-render-cell-km");
  if (!cellInput) return;
  cellInput.min = String(GFW_MIN_RENDER_CELL_KM);
  cellInput.value = String(clampGfwRenderCellKm(state.gfwPaint.renderCellKm));
  const applyCellSize = () => {
    const value = clampGfwRenderCellKm(cellInput.value);
    state.gfwPaint.renderCellKm = value;
    cellInput.value = String(value);
    repaintGfwLayer();
  };
  cellInput.addEventListener("change", applyCellSize);
  cellInput.addEventListener("blur", applyCellSize);
}
