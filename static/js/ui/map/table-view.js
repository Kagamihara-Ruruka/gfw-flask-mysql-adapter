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
    return "未選擇主要資料圖層";
  }
  if (context?.layer === "ais") {
    const bboxCount = context.wrappedBboxCount || 1;
    return `AIS 即時視窗，${bboxCount} 個循環邊界框`;
  }
  if (context?.date && typeof isSampledGridLayer === "function" && isSampledGridLayer(context.layer)) {
    const label = typeof layerLabel === "function" ? layerLabel(context.layer) : "取樣網格";
    return context.loading
      ? `${label} 日期 ${context.date}，載入中`
      : `${label} 日期 ${context.date}，視窗資料`;
  }
  return "視窗資料";
}

function renderTable(rows, columns = state.datasets[state.datasetId].display_columns, context = {}) {
  state.rows = rows;
  state.columns = columns;
  state.recordsContext = {
    ...context,
    datasetId: state.datasetId,
    rowCount: rows.length,
  };
  $("records").querySelector("thead").innerHTML = state.columns.length
    ? `<tr>${state.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>`
    : "";
  $("table-note").textContent = `${tableContextLabel(context)} - 已載入 ${rows.length.toLocaleString()} 筆`;
  renderTableWindow();
  if (!context.loading && context.notify !== false) {
    window.dispatchEvent(new CustomEvent("rrkal:records-updated", {
      detail: { ...state.recordsContext },
    }));
  }
}
