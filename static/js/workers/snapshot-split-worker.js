self.onmessage = (event) => {
  const { rows = [], dateColumn = "obs_date", allowedDates = [] } = event.data || {};
  const allowed = Array.isArray(allowedDates) && allowedDates.length
    ? new Set(allowedDates)
    : null;
  const snapshots = {};

  for (const row of rows) {
    const date = row?.[dateColumn];
    if (!date || (allowed && !allowed.has(date))) continue;
    if (!snapshots[date]) snapshots[date] = [];
    snapshots[date].push(row);
  }

  self.postMessage({ snapshots });
};
