const TimingMetrics = (() => {
  function formatMs(value) {
    if (value === undefined || value === null || !Number.isFinite(Number(value))) {
      return "-";
    }
    return `${Number(value).toFixed(1)} ms`;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
  }

  function setMs(id, value) {
    setText(id, formatMs(value));
  }

  function setCount(id, value) {
    setText(id, Number(value || 0).toLocaleString());
  }

  function updateSummary() {
    const rows = document.getElementById("row-count")?.textContent || "-";
    const client = document.getElementById("client-ms")?.textContent || "-";
    const eez = document.getElementById("eez-ms")?.textContent || "-";
    setText("metrics-summary", `Rows ${rows} / Render ${client} / EEZ ${eez}`);
  }

  function stopwatch() {
    const started = performance.now();
    return {
      elapsed() {
        return performance.now() - started;
      },
    };
  }

  function waitForLayerLoad(layer, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        layer.off?.("load", onLoad);
        layer.off?.("tileerror", onError);
      };
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("tile load failed"));
      };
      layer.once?.("load", onLoad);
      layer.once?.("tileerror", onError);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("tile load timeout"));
      }, timeoutMs);
    });
  }

  async function waitForLayers(layers, timeoutMs) {
    await Promise.all(layers.map((layer) => waitForLayerLoad(layer, timeoutMs)));
  }

  return {
    formatMs,
    setText,
    setMs,
    setCount,
    updateSummary,
    stopwatch,
    waitForLayers,
  };
})();
