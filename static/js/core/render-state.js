const RenderState = (() => {
  const layers = {
    gfw: { label: "GFW", bit: 0, status: "off", detail: "off" },
    ais: { label: "AIS", bit: 0, status: "off", detail: "off" },
    eez: { label: "EEZ", bit: 0, status: "off", detail: "off" },
  };
  const primaryExclusive = {
    gfw: "ais",
    ais: "gfw",
  };
  const scopes = new Map();

  function element(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const target = element(id);
    if (target) target.textContent = value;
  }

  function syncLayer(layerId) {
    const layer = layers[layerId];
    if (!layer) return;
    setText(`render-bit-${layerId}`, String(layer.bit));
    setText(`render-detail-${layerId}`, layer.detail);
    const light = element(`render-light-${layerId}`);
    const chip = element(`render-chip-${layerId}`);
    if (!light || !chip) return;
    light.className = "render-light";
    chip.classList.remove("is-ready", "is-loading", "is-error", "is-off");
    if (layer.bit === 1) {
      light.classList.add("is-ready");
      chip.classList.add("is-ready");
    } else if (layer.status === "loading") {
      light.classList.add("is-loading");
      chip.classList.add("is-loading");
    } else if (layer.status === "error") {
      light.classList.add("is-error");
      chip.classList.add("is-error");
    } else {
      light.classList.add("is-off");
      chip.classList.add("is-off");
    }
  }

  function updateSummary() {
    const bits = Object.entries(layers).map(([id, layer]) => `${id.toUpperCase()} ${layer.bit}`).join(" / ");
    setText("render-gate-summary", bits);
  }

  function enforcePrimaryExclusion(layerId, bit) {
    if (!bit || !primaryExclusive[layerId]) return;
    const otherLayerId = primaryExclusive[layerId];
    layers[otherLayerId].bit = 0;
    layers[otherLayerId].status = "off";
    layers[otherLayerId].detail = "exclusive off";
    syncLayer(otherLayerId);
  }

  function setLayer(layerId, bit, status, detail) {
    if (!layers[layerId]) return;
    enforcePrimaryExclusion(layerId, bit);
    layers[layerId].bit = bit ? 1 : 0;
    layers[layerId].status = status || (bit ? "ready" : "off");
    layers[layerId].detail = detail || layers[layerId].status;
    syncLayer(layerId);
    updateSummary();
  }

  function ready(layerId, detail) {
    setLayer(layerId, 1, "ready", detail || "ready");
  }

  function loading(layerId, detail) {
    setLayer(layerId, 0, "loading", detail || "loading");
  }

  function off(layerId, detail) {
    setLayer(layerId, 0, "off", detail || "off");
  }

  function error(layerId, detail) {
    setLayer(layerId, 0, "error", detail || "error");
  }

  function begin(scope, layerIds) {
    const id = (scopes.get(scope) || 0) + 1;
    scopes.set(scope, id);
    for (const layerId of layerIds) {
      loading(layerId, "rendering");
    }
    return { scope, id, layerIds: [...layerIds] };
  }

  function isCurrent(transaction) {
    return scopes.get(transaction.scope) === transaction.id;
  }

  function finish(transaction, detailByLayer = {}) {
    if (!isCurrent(transaction)) return false;
    for (const layerId of transaction.layerIds) {
      ready(layerId, detailByLayer[layerId] || "ready");
    }
    return true;
  }

  function fail(transaction, message) {
    if (!isCurrent(transaction)) return false;
    for (const layerId of transaction.layerIds) {
      error(layerId, message || "failed");
    }
    return true;
  }

  function sync() {
    for (const layerId of Object.keys(layers)) {
      syncLayer(layerId);
    }
    updateSummary();
  }

  return {
    begin,
    isCurrent,
    finish,
    fail,
    ready,
    loading,
    off,
    error,
    sync,
  };
})();
