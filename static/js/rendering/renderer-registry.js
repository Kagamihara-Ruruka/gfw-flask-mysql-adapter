const RendererRegistry = (() => {
  function policy() {
    return state.renderCapability?.policy || {};
  }

  function browserWebgl() {
    return state.renderCapability?.browser?.webgl || { available: false };
  }

  function webglAllowed(rowCount) {
    const currentPolicy = policy();
    if (currentPolicy.force_cpu || currentPolicy.hardware_acceleration === "off") return false;
    if (currentPolicy.allow_webgl === false) return false;
    if (!browserWebgl().available) return false;
    const minRows = Number(currentPolicy.min_webgl_rows || 1);
    return Number(rowCount || 0) >= minRows;
  }

  function gpuAvailable() {
    const currentPolicy = policy();
    if (currentPolicy.force_cpu || currentPolicy.hardware_acceleration === "off") return false;
    if (currentPolicy.allow_webgl === false) return false;
    return Boolean(browserWebgl().available && window.GfwWebglLayer?.isSupported?.());
  }

  function chooseGfwLayer(rows, canvasLayerClass) {
    const rowCount = Array.isArray(rows) ? rows.length : 0;
    if (webglAllowed(rowCount) && window.GfwWebglLayer?.isSupported?.()) {
      return { backend: "webgl", LayerClass: window.GfwWebglLayer };
    }
    return { backend: "canvas", LayerClass: canvasLayerClass };
  }

  function recordGfwRender(backend, drawMs) {
    const formatted = TimingMetrics.formatMs(drawMs);
    state.rendering.gfwMode = backend;
    state.rendering.gfwBackend = `${backend} 渲染 ${formatted}`;
    TimingMetrics.setMetricMs?.("draw", drawMs, {
      label: backend === "webgl" ? "WebGL 繪製" : "Canvas 繪製",
      source: backend,
    });
    return state.rendering.gfwBackend;
  }

  return {
    chooseGfwLayer,
    gpuAvailable,
    recordGfwRender,
  };
})();
