function bindEezPaintControls() {
  const controls = [
    ["eez-fill-color", "fillColor", "value"],
    ["eez-boundary-color", "boundaryColor", "value"],
    ["eez-fill-opacity", "fillOpacity", "number"],
    ["eez-boundary-opacity", "boundaryOpacity", "number"],
  ];
  let repaintTimer = null;
  const scheduleRepaint = () => {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => repaintEezLayer(), 140);
  };
  for (const [id, key, valueType] of controls) {
    const input = $(id);
    if (!input) continue;
    input.value = String(state.eezPaint[key]);
    for (const eventName of ["click", "pointerdown", "mousedown", "touchstart", "dragstart"]) {
      input.addEventListener(eventName, (event) => event.stopPropagation());
    }
    input.addEventListener("input", () => {
      state.eezPaint[key] = valueType === "number" ? Number(input.value) : input.value;
      scheduleRepaint();
    });
  }
}
