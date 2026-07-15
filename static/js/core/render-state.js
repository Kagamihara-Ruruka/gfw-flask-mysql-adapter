class RenderStateController {
  constructor({ elementById, labelForLayer, primaryLayerPredicate } = {}) {
  if (typeof elementById !== "function" || typeof primaryLayerPredicate !== "function") {
    throw new TypeError("RenderState requires DOM and primary-layer adapters");
  }
  const layers = {
    ais: { label: "AIS", bit: 0, status: "off", detail: "關閉" },
    eez: { label: "EEZ", bit: 0, status: "off", detail: "關閉" },
  };
  const scopes = new Map();

  function ensureLayer(layerId) {
    const id = String(layerId || "").trim().toLowerCase();
    if (!id) return null;
    if (!layers[id]) {
      const label = typeof labelForLayer === "function" ? labelForLayer(id) : id.toUpperCase();
      layers[id] = { label, bit: 0, status: "off", detail: "關閉" };
    }
    return id;
  }

  function element(id) {
    return elementById(id);
  }

  function setText(id, value) {
    const target = element(id);
    if (target) target.textContent = value;
  }

  function syncLayer(layerId) {
    const id = ensureLayer(layerId);
    const layer = id ? layers[id] : null;
    if (!layer) return;
    setText(`render-bit-${id}`, String(layer.bit));
    setText(`render-detail-${id}`, layer.detail);
    const light = element(`render-light-${id}`);
    const chip = element(`render-chip-${id}`);
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
    const bits = Object.values(layers).map((layer) => `${layer.label} ${layer.bit}`).join(" / ");
    setText("render-gate-summary", bits);
  }

  function enforcePrimaryExclusion(layerId, bit) {
    if (!bit || !primaryLayerPredicate(layerId)) return;
    for (const [otherLayerId, layer] of Object.entries(layers)) {
      if (otherLayerId === layerId || !primaryLayerPredicate(otherLayerId)) continue;
      layer.bit = 0;
      layer.status = "off";
      layer.detail = "互斥關閉";
      syncLayer(otherLayerId);
    }
  }

  function setLayer(layerId, bit, status, detail) {
    const id = ensureLayer(layerId);
    if (!id) return;
    enforcePrimaryExclusion(id, bit);
    layers[id].bit = bit ? 1 : 0;
    layers[id].status = status || (bit ? "ready" : "off");
    layers[id].detail = detail || layers[id].status;
    syncLayer(id);
    updateSummary();
  }

  function ready(layerId, detail) {
    setLayer(layerId, 1, "ready", detail || "就緒");
  }

  function loading(layerId, detail) {
    setLayer(layerId, 0, "loading", detail || "載入中");
  }

  function off(layerId, detail) {
    setLayer(layerId, 0, "off", detail || "關閉");
  }

  function error(layerId, detail) {
    setLayer(layerId, 0, "error", detail || "錯誤");
  }

  function begin(scope, layerIds) {
    const id = (scopes.get(scope) || 0) + 1;
    scopes.set(scope, id);
    for (const layerId of layerIds) {
      loading(layerId, "渲染中");
    }
    return { scope, id, layerIds: [...layerIds] };
  }

  function isCurrent(transaction) {
    return scopes.get(transaction.scope) === transaction.id;
  }

  function finish(transaction, detailByLayer = {}) {
    if (!isCurrent(transaction)) return false;
    for (const layerId of transaction.layerIds) {
      ready(layerId, detailByLayer[layerId] || "就緒");
    }
    return true;
  }

  function fail(transaction, message) {
    if (!isCurrent(transaction)) return false;
    for (const layerId of transaction.layerIds) {
      error(layerId, message || "失敗");
    }
    return true;
  }

  function sync() {
    for (const layerId of Object.keys(layers)) {
      syncLayer(layerId);
    }
    updateSummary();
  }

  function dispose() {
    scopes.clear();
  }

  Object.assign(this, {
    begin,
    isCurrent,
    finish,
    fail,
    ready,
    loading,
    off,
    error,
    sync,
    dispose,
  });
  Object.freeze(this);
  }
}

if (typeof globalThis !== "undefined") globalThis.RenderStateController = RenderStateController;
