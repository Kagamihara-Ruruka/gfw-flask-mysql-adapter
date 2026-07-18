const VirtualGridSettings = (() => {
  function element(id) {
    return document.getElementById(id);
  }

  function formatNumber(value, digits = 3) {
    return formatDisplayNumber(value, { maximumFractionDigits: digits });
  }

  function statusLabel(snapshot) {
    if (snapshot.status === "common") return "共同格網";
    if (snapshot.status === "single") return "單圖層格網";
    if (snapshot.status === "unavailable") return "不可用";
    return "等待合約";
  }

  function render(snapshot = state.virtualGrid) {
    const chip = element("virtual-grid-status-chip");
    const detail = element("virtual-grid-status-detail");
    const metrics = element("virtual-grid-status-metrics");
    const participants = element("virtual-grid-participants");
    if (!chip || !detail || !metrics || !participants) return;
    const multiplierInput = element("virtual-grid-multiplier");
    if (multiplierInput) multiplierInput.value = String(snapshot.multiplier || 1);
    chip.textContent = statusLabel(snapshot);
    chip.dataset.status = snapshot.status || "unresolved";
    detail.textContent = snapshot.detail || "等待已導入圖層。";
    metrics.replaceChildren();
    const geometry = snapshot.geometry;
    const rows = [
      ["參與圖層", String(snapshot.participants?.length || 0)],
      ["等效解析度", formatResolutionKm(snapshot.resolutionKm)],
      ["格網寬度", geometry ? `${formatNumber(geometry.cell_width_degrees, 6)}°` : "-"],
      ["格網高度", geometry ? `${formatNumber(geometry.cell_height_degrees, 6)}°` : "-"],
    ];
    rows.forEach(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      metrics.append(term, description);
    });
    participants.replaceChildren();
    for (const participant of snapshot.participants || []) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = participant.label || participant.layer_id;
      const resolution = document.createElement("strong");
      const requested = Number(participant.requested_resolution_km);
      const selection = Number(participant.selection_resolution_km ?? requested);
      const query = Number(participant.query_resolution_km ?? selection);
      resolution.textContent = Number.isFinite(selection)
        && Number.isFinite(query)
        && Math.abs(selection - query) > 1e-9
        ? `${formatResolutionKm(selection)} → ${formatResolutionKm(query)}`
        : formatResolutionKm(selection);
      item.append(label, resolution);
      participants.append(item);
    }
  }

  function bind() {
    const input = element("virtual-grid-strategy-lcm");
    const multiplierInput = element("virtual-grid-multiplier");
    input?.addEventListener("change", () => {
      if (input.checked) window.VirtualGridController?.setStrategy?.(input.value);
    });
    multiplierInput?.addEventListener("change", () => {
      const snapshot = window.VirtualGridController?.setMultiplier?.(multiplierInput.value);
      if (snapshot) render(snapshot);
    });
    window.addEventListener("rrkal:virtual-grid-changed", (event) => render(event.detail));
    window.addEventListener("rrkal:datasets-loaded", () => render(state.virtualGrid));
    render(state.virtualGrid);
  }

  return Object.freeze({ bind, render });
})();

window.VirtualGridSettings = VirtualGridSettings;
VirtualGridSettings.bind();
