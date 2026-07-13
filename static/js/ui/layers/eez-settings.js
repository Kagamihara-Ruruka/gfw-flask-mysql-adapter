function bindEezPaintControls() {
  const scheduleRepaint = scheduleStyleRepaintFactory(repaintEezLayer, 140);

  bindStateStyleControls({
    source: state.eezPaint,
    controls: [
      ["eez-fill-color", "fillColor", "value"],
      ["eez-boundary-color", "boundaryColor", "value"],
    ],
    repaint: repaintEezLayer,
    repaintDelayMs: 140,
  });

  for (const [id, key] of [
    ["eez-disputed-color", "disputed"],
    ["eez-joint-color", "joint"],
    ["eez-other-color", "other"],
  ]) {
    const input = $(id);
    if (!input) continue;
    input.value = state.eezPaint.polTypeColors?.[key] || input.value;
    stopStyleControlPropagation(input);
    input.addEventListener("input", () => {
      state.eezPaint.polTypeColors = state.eezPaint.polTypeColors || {};
      state.eezPaint.polTypeColors[key] = input.value;
      scheduleRepaint();
    });
  }
}
