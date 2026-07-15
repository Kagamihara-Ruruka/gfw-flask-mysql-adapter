(() => {
const { lineChartEscape } = window.WidgetCore;

class SampledGridWidgetLayerFilter {
  constructor({ queryContext } = {}) {
    if (!queryContext) throw new TypeError("SampledGridWidgetLayerFilter requires queryContext");
    this.queryContext = queryContext;
    this.excludedLayerIds = new Set();
  }

  layers() {
    return this.queryContext.sampledGridLayers();
  }

  includedLayers() {
    return this.layers().filter((layer) => !this.excludedLayerIds.has(layer.layerId));
  }

  signature() {
    return this.includedLayers().map((layer) => layer.layerId).sort().join(",");
  }

  render({ title = "參與圖層", onChange } = {}) {
    const section = document.createElement("section");
    section.className = "widget-query-settings";
    const heading = document.createElement("h4");
    heading.textContent = title;
    const list = document.createElement("div");
    list.className = "widget-query-option-list";
    for (const layer of this.layers()) {
      const row = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !this.excludedLayerIds.has(layer.layerId);
      input.value = layer.layerId;
      input.addEventListener("change", () => {
        if (input.checked) this.excludedLayerIds.delete(layer.layerId);
        else this.excludedLayerIds.add(layer.layerId);
        onChange?.();
      });
      const label = document.createElement("span");
      label.textContent = layer.label;
      row.append(input, label);
      list.append(row);
    }
    if (!list.childElementCount) {
      const empty = document.createElement("p");
      empty.textContent = "沒有已導入的 sampled-grid 圖層";
      list.append(empty);
    }
    section.append(heading, list);
    return section;
  }
}


window.WidgetCapabilityShared = Object.freeze({
  lineChartEscape,
  SampledGridWidgetLayerFilter,
});
})();
