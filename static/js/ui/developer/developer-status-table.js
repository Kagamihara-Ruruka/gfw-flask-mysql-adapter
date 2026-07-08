(function () {
  const { element: developerElement, escapeHtml } = window.DeveloperUtils;

  class DeveloperStatusTable {
    constructor({ bodyId, emptyText, columns }) {
      this.bodyId = bodyId;
      this.emptyText = emptyText;
      this.columns = columns;
    }

    render(rows) {
      const body = developerElement(this.bodyId);
      if (!body) {
        return;
      }
      this.syncColgroup(body);
      if (!rows.length) {
        body.innerHTML = `<tr><td colspan="${this.columns.length}">${escapeHtml(this.emptyText)}</td></tr>`;
        return;
      }
      body.innerHTML = "";
      for (const row of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = this.columns.map((column) => this.renderCell(column, row)).join("");
        body.appendChild(tr);
      }
    }

    syncColgroup(body) {
      const table = body.closest("table");
      if (!table) {
        return;
      }
      let colgroup = table.querySelector("colgroup[data-developer-status-table]");
      if (!colgroup) {
        colgroup = document.createElement("colgroup");
        colgroup.dataset.developerStatusTable = "true";
        table.insertBefore(colgroup, table.firstElementChild);
      }
      colgroup.innerHTML = this.columns.map((column) => {
        const width = column.width ? ` style="width: ${escapeHtml(column.width)}"` : "";
        return `<col${width}>`;
      }).join("");
    }

    renderCell(column, row) {
      const className = column.className ? ` class="${escapeHtml(column.className)}"` : "";
      const content = column.render ? column.render(row) : escapeHtml(row[column.key] ?? "");
      return `<td${className}>${content}</td>`;
    }
  }

  function bitCell(value) {
    return `<span class="developer-bit ${value ? "is-on" : "is-off"}">${value ? "1" : "0"}</span>`;
  }

  window.DeveloperStatusTable = {
    DeveloperStatusTable,
    bitCell,
  };
})();
