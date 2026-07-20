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

function widgetSimpleMovingAverage(values, windowSize) {
  const source = Array.isArray(values) ? values : [];
  const size = Number.parseInt(windowSize, 10);
  const result = source.map(() => null);
  if (!Number.isInteger(size) || size < 1) return result;

  const numericValues = source.map((value) => {
    if (value === null || value === undefined || value === "") return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  });
  let sum = 0;
  let validCount = 0;
  for (let index = 0; index < numericValues.length; index += 1) {
    const entered = numericValues[index];
    if (entered !== null) {
      sum += entered;
      validCount += 1;
    }
    if (index >= size) {
      const exited = numericValues[index - size];
      if (exited !== null) {
        sum -= exited;
        validCount -= 1;
      }
    }
    if (index >= size - 1 && validCount === size) {
      result[index] = sum / size;
    }
  }
  return result;
}

globalThis.WidgetApplicationFunctions = Object.freeze({
  widgetDateKey,
  widgetFormatDateLabel,
  widgetMetricForDataset,
  widgetColorFor,
  widgetSimpleMovingAverage,
});
})();
