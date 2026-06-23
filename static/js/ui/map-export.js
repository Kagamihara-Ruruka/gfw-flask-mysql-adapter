function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function downloadCanvasAsPng(canvas, filename) {
  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png");
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function exportMapPng() {
  if (typeof html2canvas !== "function") {
    throw new Error("Map export library is not loaded");
  }
  const target = $("map");
  map.invalidateSize();
  const canvas = await html2canvas(target, {
    backgroundColor: "#05070a",
    allowTaint: false,
    useCORS: true,
    logging: false,
    scale: Math.min(2, window.devicePixelRatio || 1),
  });
  downloadCanvasAsPng(canvas, `rrkal-map-${timestampForFilename()}.png`);
}

function bindMapExportControls() {
  const button = $("map-export-png");
  if (!button) return;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Saving";
    try {
      await exportMapPng();
      setStatus("Map PNG saved");
    } catch (err) {
      console.error(err);
      setStatus(`Map export failed: ${err.message}`, true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}
