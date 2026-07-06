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
    throw new Error("地圖匯出套件尚未載入");
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
    button.textContent = "儲存中";
    try {
      await exportMapPng();
      setStatus("地圖 PNG 已儲存");
    } catch (err) {
      console.error(err);
      setStatus(`地圖匯出失敗：${err.message}`, true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}
