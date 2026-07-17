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
    if (currentPolicy.allow_webgl === false || !browserWebgl().available) return false;
    const minRows = Number(currentPolicy.min_webgl_rows || 1);
    return Number(rowCount || 0) >= minRows;
  }

  function gpuAvailable() {
    const currentPolicy = policy();
    if (currentPolicy.force_cpu || currentPolicy.hardware_acceleration === "off") return false;
    if (currentPolicy.allow_webgl === false) return false;
    return Boolean(browserWebgl().available && window.SampledGridWebglLayer?.isSupported?.());
  }

  function chooseSampledGridLayer(frame, canvasLayerClass) {
    const rowCount = CanonicalGridFrame.isFrame(frame) ? frame.rowCount : 0;
    if (webglAllowed(rowCount) && window.SampledGridWebglLayer?.isSupported?.()) {
      return { backend: "webgl", LayerClass: window.SampledGridWebglLayer };
    }
    return { backend: "canvas", LayerClass: canvasLayerClass };
  }

  function recordSampledGridRender(backend, drawMs) {
    const formatted = TimingMetrics.formatMs(drawMs);
    const detail = `${backend} / ${formatted}`;
    state.rendering.sampledGridMode = backend;
    state.rendering.sampledGridBackend = detail;
    TimingMetrics.setMetricMs?.("draw", drawMs, {
      label: backend === "webgl" ? "WebGL 渲染" : "Canvas 渲染",
      source: backend,
    });
    return detail;
  }

  return {
    chooseSampledGridLayer,
    gpuAvailable,
    recordSampledGridRender,
  };
})();
