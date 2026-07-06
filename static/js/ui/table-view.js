function renderTableWindow() {
  const scroll = $("table-scroll");
  const tbody = $("records").querySelector("tbody");
  if (!state.columns.length) {
    tbody.innerHTML = "";
    return;
  }
  const rowHeight = 30;
  const viewportRows = Math.ceil(scroll.clientHeight / rowHeight) + 8;
  const start = Math.max(0, Math.floor(scroll.scrollTop / rowHeight) - 4);
  const end = Math.min(state.rows.length, start + viewportRows);
  const topPad = start * rowHeight;
  const bottomPad = Math.max(0, (state.rows.length - end) * rowHeight);
  const cells = state.rows.slice(start, end).map((row) =>
    `<tr>${state.columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`
  ).join("");
  tbody.innerHTML = [
    topPad ? `<tr class="virtual-pad"><td colspan="${state.columns.length}" style="height:${topPad}px"></td></tr>` : "",
    cells,
    bottomPad ? `<tr class="virtual-pad"><td colspan="${state.columns.length}" style="height:${bottomPad}px"></td></tr>` : "",
  ].join("");
}

function tableContextLabel(context) {
  if (context?.layer === "none") {
    return "No primary data layer";
  }
  if (context?.layer === "ais") {
    const bboxCount = context.wrappedBboxCount || 1;
    return `AIS live viewport, ${bboxCount} wrapped bbox`;
  }
  if (context?.layer === "gfw" && context.date) {
    return context.loading
      ? `GFW date ${context.date}, loading`
      : `GFW date ${context.date}, viewport max`;
  }
  return "viewport records";
}

function renderTable(rows, columns = state.datasets[state.datasetId].display_columns, context = {}) {
  state.rows = rows;
  state.columns = columns;
  $("records").querySelector("thead").innerHTML = state.columns.length
    ? `<tr>${state.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>`
    : "";
  $("table-note").textContent = `${tableContextLabel(context)} - ${rows.length.toLocaleString()} loaded`;
  renderTableWindow();
}
