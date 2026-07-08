const GfwRenderArtifactCache = (() => {
  let generation = 0;

  function webglAvailable() {
    return Boolean(RendererRegistry?.gpuAvailable?.());
  }

  function releaseLayer(layer) {
    if (!layer || typeof layer.releaseGpuResources !== "function") return false;
    layer.releaseGpuResources();
    return true;
  }

  function clear({ reason = "manual", requireGpu = false } = {}) {
    if (requireGpu && !webglAvailable()) {
      return { cleared: false, generation, reason, gpu: false };
    }

    generation += 1;
    let released = 0;
    if (releaseLayer(state.gridLayer)) released += 1;
    for (const layer of state.gfwRetiringLayers || []) {
      if (releaseLayer(layer)) released += 1;
    }

    state.gfwRenderArtifactCache = {
      generation,
      released,
      reason,
      clearedAt: Date.now(),
      gpu: webglAvailable(),
    };

    return { cleared: true, generation, released, reason, gpu: webglAvailable() };
  }

  function currentGeneration() {
    return generation;
  }

  return {
    clear,
    currentGeneration,
    webglAvailable,
  };
})();
