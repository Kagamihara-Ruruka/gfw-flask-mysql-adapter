class RenderArtifactCache {
  constructor({ targetState, rendererRegistry, clock } = {}) {
    if (!targetState || !rendererRegistry || !clock || typeof clock.now !== "function") {
      throw new TypeError("RenderArtifactCache requires state, RendererRegistry and a monotonic clock");
    }
    this.state = targetState;
    this.rendererRegistry = rendererRegistry;
    this.clock = clock;
    this.generation = 0;
  }

  webglAvailable() {
    return Boolean(this.rendererRegistry.gpuAvailable?.());
  }

  releaseLayer(layer) {
    if (!layer || typeof layer.releaseGpuResources !== "function") return false;
    layer.releaseGpuResources();
    return true;
  }

  clear({ reason = "manual", requireGpu = false } = {}) {
    if (requireGpu && !this.webglAvailable()) {
      return { cleared: false, generation: this.generation, reason, gpu: false };
    }

    this.generation += 1;
    let released = 0;
    if (this.releaseLayer(this.state.gridLayer)) released += 1;
    for (const layer of this.state.gfwRetiringLayers || []) {
      if (this.releaseLayer(layer)) released += 1;
    }

    this.state.gfwRenderArtifactCache = {
      generation: this.generation,
      released,
      reason,
      clearedMonotonicMs: this.clock.now(),
      gpu: this.webglAvailable(),
    };

    return {
      cleared: true,
      generation: this.generation,
      released,
      reason,
      gpu: this.webglAvailable(),
    };
  }

  currentGeneration() {
    return this.generation;
  }

  dispose() {
    this.clear({ reason: "disposed" });
  }
}

if (typeof globalThis !== "undefined") globalThis.RenderArtifactCache = RenderArtifactCache;
