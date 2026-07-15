(() => {
function widgetDateKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, 10);
}

function widgetFormatDateLabel(value) {
  const key = widgetDateKey(value);
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

function widgetColorFor(key, alpha = 0.9) {
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

globalThis.WidgetApplicationFunctions = Object.freeze({
  widgetDateKey,
  widgetFormatDateLabel,
  widgetMetricForDataset,
  widgetColorFor,
});
})();
