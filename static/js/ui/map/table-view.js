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
  const rowCount = state.recordsFrame?.rowCount ?? state.rows.length;
  const end = Math.min(rowCount, start + viewportRows);
  const topPad = start * rowHeight;
  const bottomPad = Math.max(0, (rowCount - end) * rowHeight);
  const visibleRows = state.recordsFrame
    ? state.recordsFrame.rows(start, end - start)
    : state.rows.slice(start, end);
  const cells = visibleRows.map((row) =>
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

function renderTable(source, columns = state.datasets[state.datasetId].display_columns, context = {}) {
  const frame = CanonicalGridFrame.isFrame(source) ? source : null;
  const rows = Array.isArray(source) ? source : [];
  const rowCount = frame?.rowCount ?? rows.length;
  state.recordsFrame = frame;
  state.rows = rows;
  state.columns = Array.isArray(columns) && columns.length ? columns : (frame?.fieldNames() || []);
  state.recordsContext = {
    ...context,
    datasetId: state.datasetId,
    rowCount,
  };
  $("records").querySelector("thead").innerHTML = state.columns.length
    ? `<tr>${state.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>`
    : "";
  $("table-note").textContent = `${tableContextLabel(context)} - 已載入 ${rowCount.toLocaleString()} 筆`;
  renderTableWindow();
  if (!context.loading && context.notify !== false) {
    window.dispatchEvent(new CustomEvent("rrkal:records-updated", {
      detail: { ...state.recordsContext },
    }));
  }
}
