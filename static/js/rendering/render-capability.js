function probeBrowserWebgl() {
  const canvas = document.createElement("canvas");
  const contextNames = ["webgl2", "webgl", "experimental-webgl"];
  for (const contextName of contextNames) {
    const gl = canvas.getContext(contextName, {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) continue;
    let vendor = "";
    let renderer = "";
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "";
      renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "";
    }
    const capability = {
      available: true,
      context: contextName,
      vendor,
      renderer,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext?.();
    return capability;
  }
  return { available: false, context: null, vendor: "", renderer: "" };
}

async function loadRenderCapability() {
  let server = {
    status: "fallback",
    policy: {
      hardware_acceleration: "auto",
      allow_webgl: true,
      allow_webgpu: false,
      force_cpu: false,
      min_webgl_rows: 1,
    },
  };
  try {
    const response = await fetch("/api/render/capability");
    const payload = await response.json();
    if (response.ok) {
      server = payload;
    }
  } catch (err) {
    console.warn("render capability endpoint unavailable", err);
  }
  const browser = {
    webgl: probeBrowserWebgl(),
    webgpu: { available: Boolean(navigator.gpu) },
  };
  const capability = {
    server,
    policy: server.policy || {},
    browser,
    loadedMonotonicMs: ClockDomain.monotonic.now(),
  };
  if (!globalThis.RendererCapabilityState?.install) {
    throw new Error("RendererCapabilityState is not composed");
  }
  return globalThis.RendererCapabilityState.install(capability);
}
