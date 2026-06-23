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
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        layer.off?.("load", finish);
        layer.off?.("tileerror", finish);
        resolve();
      };
      layer.once?.("load", finish);
      layer.once?.("tileerror", finish);
      timer = setTimeout(finish, timeoutMs);
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
