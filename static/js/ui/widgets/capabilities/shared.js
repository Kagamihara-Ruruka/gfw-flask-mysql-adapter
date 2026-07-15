(() => {
const { lineChartEscape } = window.WidgetCore;

function lineChartDateKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, 10);
}

function lineChartFormatDateLabel(value) {
  const key = lineChartDateKey(value);
  return key.length >= 10 ? key.slice(5) : key;
}

function widgetMetricForDataset(dataset) {
  if (dataset?.sampled_grid) return "value";
  const metrics = Array.isArray(dataset?.metric_columns) ? dataset.metric_columns : [];
  if (metrics.length) return metrics[0];
  const roles = new Set([
    dataset?.time_column,
    dataset?.id_column,
    dataset?.lat_column,
    dataset?.lon_column,
  ].filter(Boolean));
  return (dataset?.display_columns || []).find((column) => !roles.has(column)) || null;
}

class WidgetQueryContext {
  static sampledGridLayers({ excludedLayerIds = [] } = {}) {
    const excluded = new Set(excludedLayerIds);
    return (window.LayerRuntimeContractRegistry?.sampledGridLayers?.({ enabledOnly: true }) || [])
      .filter((layer) => !excluded.has(layer.layerId));
  }

  static selections() {
    const items = Array.isArray(state?.tileSelection?.items) ? state.tileSelection.items : [];
    return items.length ? items : [state?.tileSelection?.selected].filter(Boolean);
  }

  static currentDate(selection = null) {
    const locked = selection?.time_binding?.kind === "locked_axis"
      ? selection.time_binding.axis?.cursor
      : null;
    return locked
      || document.getElementById("date")?.value
      || selection?.date
      || state?.renderedSampledGridDate
      || "";
  }

  static bbox(selection) {
    if (!Array.isArray(selection?.bbox) || selection.bbox.length !== 4) return null;
    const values = selection.bbox.map(Number);
    if (!values.every(Number.isFinite)) return null;
    return values;
  }

  static resolutionFor(layer, selection) {
    const participant = selection?.selection_grid?.participants?.find((item) => (
      item.dataset_id === layer.datasetId || item.layer_id === layer.layerId
    ));
    const declared = participant?.effective_resolution_km
      ?? participant?.actual_resolution_km
      ?? participant?.requested_resolution_km;
    if (Number.isFinite(Number(declared))) return Number(declared);
    return SampledGridContract.queryResolution({
      datasetId: layer.datasetId,
      zoom: typeof map !== "undefined" ? map?.getZoom?.() : null,
      latitude: selection?.center?.lat ?? (typeof map !== "undefined" ? map?.getCenter?.().lat : null),
    });
  }

  static request(layer, selection) {
    const bbox = this.bbox(selection);
    const date = this.currentDate(selection);
    if (!layer?.datasetId || !bbox || !date) return null;
    const resolution = this.resolutionFor(layer, selection);
    return {
      datasetId: layer.datasetId,
      layerId: layer.layerId,
      label: layer.label,
      date,
      bbox: bbox.map((value) => value.toFixed(6)).join(","),
      limit: typeof RenderIntentService !== "undefined" ? RenderIntentService.unlimitedLimit() : "max",
      columns: "render",
      resolution,
      zoom: typeof map !== "undefined" ? map?.getZoom?.() : null,
      latitude: selection?.center?.lat ?? (bbox[1] + bbox[3]) / 2,
      selection,
      key: [layer.datasetId, date, bbox.join(","), resolution ?? "auto"].join("|"),
    };
  }

  static async fetchValue(layer, selection) {
    const request = this.request(layer, selection);
    if (!request) {
      return { status: "missing", layer, selection, request, value: null, rowCount: 0 };
    }
    if (typeof DataFrameStore === "undefined" || typeof FrameDemandService === "undefined") {
      return {
        status: "unavailable",
        layer,
        selection,
        request,
        value: null,
        rowCount: 0,
        error: "canonical snapshot cache unavailable",
      };
    }
    try {
      const cached = DataFrameStore.inspect(request);
      const result = cached.status === "ready"
        ? cached
        : await FrameDemandService.demand(request, {
          lane: "widget",
          scopeId: `widget:${layer.layerId}:${selection?.selection_id || "selected"}`,
          consumerId: `value:${request.date}`,
        });
      const rows = Array.isArray(result.packet?.rows) ? result.packet.rows : [];
      const values = rows
        .map((row) => row?.value)
        .filter((value) => value !== null && value !== undefined && value !== "")
        .map(Number)
        .filter(Number.isFinite);
      if (!values.length) {
        return { status: "missing", layer, selection, request, value: null, rowCount: rows.length, packet: result.packet };
      }
      return {
        status: values.some((value) => value !== 0) ? "observed" : "zero",
        layer,
        selection,
        request,
        value: values.reduce((total, value) => total + value, 0),
        rowCount: rows.length,
        packet: result.packet,
        cacheHit: Boolean(result.cacheHit),
      };
    } catch (error) {
      return {
        status: "unavailable",
        layer,
        selection,
        request,
        value: null,
        rowCount: 0,
        error: error?.message || "query failed",
      };
    }
  }

  static colorFor(key, alpha = 0.9) {
    const palette = [
      [56, 189, 248],
      [52, 211, 153],
      [251, 191, 36],
      [244, 114, 182],
      [167, 139, 250],
      [251, 113, 133],
    ];
    const hash = Array.from(String(key || "layer")).reduce((total, char) => (
      ((total * 31) + char.charCodeAt(0)) >>> 0
    ), 0);
    const [red, green, blue] = palette[hash % palette.length];
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
}

class SampledGridWidgetLayerFilter {
  constructor() {
    this.excludedLayerIds = new Set();
  }

  layers() {
    return WidgetQueryContext.sampledGridLayers();
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
  lineChartDateKey,
  lineChartFormatDateLabel,
  lineChartEscape,
  widgetMetricForDataset,
  WidgetQueryContext,
  SampledGridWidgetLayerFilter,
});
})();
