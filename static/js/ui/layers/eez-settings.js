function bindEezPaintControls() {
  const scheduleRepaint = scheduleStyleRepaintFactory(repaintEezLayer, 140);
  const highSeasField = $("eez-high-seas-style-field");
  const syncCapabilityControls = () => {
    const capability = window.LayerRuntimeContractRegistry?.capability?.("eez", "high_seas_overlay") || {};
    if (highSeasField) highSeasField.hidden = capability.status !== "supported";
  };
  syncCapabilityControls();
  window.addEventListener("rrkal:datasets-loaded", syncCapabilityControls);

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
    ["eez-high-seas-color", "high_seas"],
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
      notifyBrowserProfileChanged("eez_style_changed");
    });
  }
}
