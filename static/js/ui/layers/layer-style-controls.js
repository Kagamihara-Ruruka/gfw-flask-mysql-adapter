function stopStyleControlPropagation(input) {
  for (const eventName of ["click", "pointerdown", "mousedown", "touchstart", "dragstart"]) {
    input.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

function scheduleStyleRepaintFactory(repaint, delayMs = 0) {
  let repaintTimer = null;
  return () => {
    if (typeof repaint !== "function") return;
    clearTimeout(repaintTimer);
    if (!delayMs) {
      repaint();
      return;
    }
    repaintTimer = setTimeout(() => repaint(), delayMs);
  };
}

function bindStateStyleControls({ source, controls, repaint, repaintDelayMs = 0 }) {
  const scheduleRepaint = scheduleStyleRepaintFactory(repaint, repaintDelayMs);
  for (const [id, key, valueType] of controls) {
    const input = $(id);
    if (!input || !source) continue;
    input.value = String(source[key]);
    stopStyleControlPropagation(input);
    input.addEventListener("input", () => {
      source[key] = valueType === "number" ? Number(input.value) : input.value;
      scheduleRepaint();
    });
  }
}

function bindLayerAlphaControls() {
  for (const input of document.querySelectorAll(".alpha-slider")) {
    let layerId = input.dataset.alphaLayer;
    if (layerId) {
      input.value = String(state.layerAlpha[layerId] ?? Number(input.value));
    }
    stopStyleControlPropagation(input);
    input.addEventListener("input", () => {
      layerId = input.dataset.alphaLayer;
      if (!layerId) return;
      state.layerAlpha[layerId] = Number(input.value);
      applyLayerAlpha(layerId);
    });
  }
  for (const layerId of Object.keys(state.layerAlpha)) {
    applyLayerAlpha(layerId);
  }
}
