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


window.WidgetCapabilityShared = Object.freeze({
  lineChartDateKey,
  lineChartFormatDateLabel,
  lineChartEscape,
  widgetMetricForDataset,
});
})();
