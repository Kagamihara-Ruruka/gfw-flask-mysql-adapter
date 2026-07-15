(function () {
  const { element: developerElement, escapeHtml } = window.DeveloperUtils;

  const ROLE_LABELS = {
    ignore: "不查詢",
    display: "顯示欄",
    metric: "指標值",
    category: "分類欄",
    time: "時間",
    lat: "緯度",
    lon: "經度",
    id: "識別",
    value: "取樣值",
    resolution: "解析度",
    coverage: "覆蓋率",
    status: "資料狀態",
    row: "網格列",
    column: "網格欄",
    west: "西界",
    south: "南界",
    east: "東界",
    north: "北界",
  };
  const CANONICAL_ROLE_KEYS = Object.freeze([
    "time", "lat", "lon", "id", "value", "resolution", "coverage", "status",
    "row", "column", "west", "south", "east", "north",
  ]);

  class DeveloperMappingController {
    constructor({
      listId = "developer-schema-profile-list",
      statusId = "developer-schema-profile-status",
      api = window.DeveloperConfigApi,
      setMessage = () => {},
      onSaved = async () => {},
    } = {}) {
      this.listId = listId;
      this.statusId = statusId;
      this.api = api;
      this.setMessage = setMessage;
      this.onSaved = onSaved;
      this.mappings = [];
      this.saveControlsBound = false;
    }

    bindSaveControls(root = document) {
      if (this.saveControlsBound) {
        return;
      }
      root.addEventListener("click", (event) => {
        this.handleSaveClick(event);
      });
      this.saveControlsBound = true;
    }

    async handleSaveClick(event) {
      const button = event.target.closest("[data-save-mapping]");
      if (!button) {
        return;
      }
      const tableElement = button.closest(".developer-schema-table");
      if (!tableElement) {
        return;
      }
      try {
        button.disabled = true;
        const payload = this.payloadFromTable(tableElement);
        const result = await this.api.saveLayerMapping(payload);
        tableElement.dataset.mappingId = result.mapping?.mapping_id || tableElement.dataset.mappingId || "";
        await this.onSaved(result, tableElement);
        this.setMessage("Mapping 已儲存。");
      } catch (err) {
        this.setMessage(err.message, true);
      } finally {
        button.disabled = false;
      }
    }

    renderProfiles(profiles, mappings, routerRows = []) {
      this.mappings = Array.isArray(mappings) ? mappings : [];
      const list = developerElement(this.listId);
      const status = developerElement(this.statusId);
      if (!list) {
        return;
      }
      if (!profiles.length) {
        const hasDatabaseRoutes = Array.isArray(routerRows) && routerRows.length > 0;
        list.innerHTML = `<div class="developer-schema-empty">${
          hasDatabaseRoutes
            ? "上方 DATABASE 路由目前沒有可注入的 Schema 探測 row。"
            : "沒有啟用中的 DATABASE 路由。"
        }</div>`;
        if (status) {
          status.className = "developer-status-badge is-idle";
          status.textContent = hasDatabaseRoutes ? "未注入" : "無路由";
        }
        return;
      }

      const tableCount = profiles.reduce((total, profile) => total + (profile.tables || []).length, 0);
      if (status) {
        const hasError = profiles.some((profile) => profile.status === "error");
        status.className = `developer-status-badge ${hasError ? "is-error" : "is-ok"}`;
        status.textContent = hasError ? "部分失敗" : `${tableCount} 表`;
      }

      list.innerHTML = "";
      for (const profile of profiles) {
        list.appendChild(this.renderProfile(profile));
      }
    }

    renderProfile(profile) {
      const profileCard = document.createElement("article");
      profileCard.className = "developer-schema-profile";
      const tables = profile.tables || [];
      const statusText = profile.status === "ok" ? "可探測" : profile.status === "unsupported" ? "未支援" : "錯誤";
      profileCard.innerHTML = `
        <header class="developer-schema-profile-header">
          <div>
            <strong>${escapeHtml(profile.route_ref || profile.connection_ref || "-")}</strong>
            <small>${escapeHtml(profile.config_path || "-")} / ${escapeHtml(profile.database || "-")}</small>
          </div>
          <span class="developer-status-badge ${profile.status === "ok" ? "is-ok" : "is-error"}">${escapeHtml(statusText)}</span>
        </header>
        <p class="developer-status-hint">${escapeHtml(profile.detail || "")}</p>
      `;

      if (!tables.length) {
        const empty = document.createElement("div");
        empty.className = "developer-schema-empty";
        empty.textContent = profile.status === "ok" ? "此路由沒有可列出的表格。" : "此路由目前無法產生 Schema 探測結果。";
        profileCard.appendChild(empty);
        return profileCard;
      }

      const tableList = document.createElement("div");
      tableList.className = "developer-schema-table-list";
      for (const table of tables) {
        tableList.appendChild(this.renderTable(profile, table));
      }
      profileCard.appendChild(tableList);
      return profileCard;
    }

    renderTable(profile, table) {
      const mapping = this.mappingForTable(profile, table);
      const tableDetails = document.createElement("details");
      tableDetails.className = "developer-schema-table";
      tableDetails.dataset.mappingId = mapping?.mapping_id || "";
      tableDetails.dataset.configPath = profile.config_path || "";
      tableDetails.dataset.connectionRef = profile.connection_ref || "";
      tableDetails.dataset.backend = profile.backend || "mysql";
      tableDetails.dataset.database = profile.database || "";
      tableDetails.dataset.table = table.name || "";
      tableDetails.dataset.datasetId = mapping?.dataset_id || "";
      const columns = table.columns || [];
      tableDetails.innerHTML = `
        <summary>
          <span>
            <strong>${escapeHtml(table.name || "-")}</strong>
            <small>${escapeHtml(table.type || "-")} / 欄位 ${columns.length}</small>
          </span>
          <span class="developer-schema-candidates">${escapeHtml(this.candidateSummary(columns))}</span>
        </summary>
        ${profile.mapping_readonly || table.mapping_readonly
          ? this.renderGeneratedMappingInfo(profile, table)
          : this.renderMappingToolbar(profile, table, mapping)}
        <div class="developer-status-table-wrap is-schema-columns-wrap">
          <table class="developer-status-table is-schema-columns">
            <thead>
              <tr>
                <th>角色</th>
                <th>欄位</th>
                <th>型別</th>
                <th>Key</th>
                <th>候選提示</th>
              </tr>
            </thead>
            <tbody>
              ${columns.map((column) => this.renderColumnRow(mapping, column)).join("")}
            </tbody>
          </table>
        </div>
      `;
      return tableDetails;
    }

    renderGeneratedMappingInfo(profile, table) {
      return `
        <div class="developer-mapping-toolbar is-generated-mapping">
          <span><strong>${escapeHtml(table.label || table.name || "-")}</strong></span>
          <span class="developer-status-badge is-ok">Catalog Mapping</span>
        </div>
        <p class="developer-status-hint">此表由 ${escapeHtml(profile.route_ref || profile.connection_ref || "route")} 的 Catalog Mapping 動態產生。</p>
      `;
    }

    renderColumnRow(mapping, column) {
      const role = this.roleForColumn(mapping, column);
      return `
        <tr>
          <td>${this.roleSelectMarkup(column, role)}</td>
          <td><strong>${escapeHtml(column.name || "-")}</strong><small>${column.nullable ? "nullable" : "not null"}</small></td>
          <td>${escapeHtml(column.column_type || column.data_type || "-")}</td>
          <td>${escapeHtml(column.key || "-")}</td>
          <td class="developer-long-value">${escapeHtml((column.semantic_hints || []).join(", ") || "-")}</td>
        </tr>
      `;
    }

    renderMappingToolbar(profile, table, mapping) {
      const layerId = mapping?.layer_id || this.safeLayerId(table.name);
      const label = mapping?.label || table.name;
      const mappingId = mapping?.mapping_id || `${profile.config_path || "-"} / ${profile.connection_ref || "-"} / ${table.name || "-"}`;
      const enabled = mapping?.enabled !== false ? "checked" : "";
      return `
        <div class="developer-mapping-toolbar">
          <label>
            <span>圖層 ID</span>
            <input data-mapping-layer-id type="text" value="${escapeHtml(layerId)}" spellcheck="false">
          </label>
          <label>
            <span>顯示名稱</span>
            <input data-mapping-label type="text" value="${escapeHtml(label)}" spellcheck="false">
          </label>
          <label class="developer-mapping-enabled">
            <input data-mapping-enabled type="checkbox" ${enabled}>
            <span>啟用 mapping</span>
          </label>
          <button class="small-button developer-primary-action" type="button" data-save-mapping>儲存 mapping</button>
        </div>
        <p class="developer-status-hint">Mapping 會寫入圖層合約，並決定後續 query request 只查詢哪些欄位。產生合約後會進入下方資料圖層導入。</p>
        <p class="developer-status-hint">Mapping 產物：${escapeHtml(mappingId)}</p>
      `;
    }

    payloadFromTable(tableElement) {
      const mappingId = tableElement.dataset.mappingId || "";
      const existingMapping = this.mappings.find((mapping) => mapping.mapping_id === mappingId) || null;
      const roleSelects = Array.from(tableElement.querySelectorAll("[data-column-role]"));
      const roles = {};
      const selectedColumns = [];
      const displayColumns = [];
      const metricColumns = [];
      const categoryColumns = [];
      for (const select of roleSelects) {
        const column = select.dataset.columnRole;
        const role = select.value;
        if (!column || role === "ignore") {
          continue;
        }
        selectedColumns.push(column);
        if (CANONICAL_ROLE_KEYS.includes(role)) {
          roles[role] = column;
          if (role === "value") metricColumns.push(column);
          if (role === "status") categoryColumns.push(column);
        } else if (role === "metric") {
          metricColumns.push(column);
        } else if (role === "category") {
          categoryColumns.push(column);
        } else {
          displayColumns.push(column);
        }
      }
      const payload = {
        mapping_id: mappingId,
        enabled: tableElement.querySelector("[data-mapping-enabled]")?.checked ?? true,
        config_path: tableElement.dataset.configPath,
        connection_ref: tableElement.dataset.connectionRef,
        backend: tableElement.dataset.backend || "mysql",
        database: tableElement.dataset.database || "",
        table: tableElement.dataset.table,
        dataset_id: tableElement.dataset.datasetId || "",
        layer_id: this.safeLayerId(tableElement.querySelector("[data-mapping-layer-id]")?.value),
        label: tableElement.querySelector("[data-mapping-label]")?.value || tableElement.dataset.table,
        roles,
        selected_columns: selectedColumns,
        display_columns: displayColumns,
        metric_columns: metricColumns,
        category_columns: categoryColumns,
      };
      for (const key of ["target_contract", "sampled_grid", "source_ref"]) {
        if (existingMapping?.[key] !== undefined) {
          payload[key] = existingMapping[key];
        }
      }
      return payload;
    }

    mappingForTable(profile, table) {
      return this.mappings.find((mapping) => (
        mapping.config_path === profile.config_path
        && mapping.connection_ref === profile.connection_ref
        && mapping.table === table.name
      ));
    }

    candidateSummary(columns) {
      const byHint = {
        time_candidate: [],
        latitude_candidate: [],
        longitude_candidate: [],
        identity_candidate: [],
      };
      for (const column of columns || []) {
        for (const hint of column.semantic_hints || []) {
          if (byHint[hint]) {
            byHint[hint].push(column.name);
          }
        }
      }
      return [
        ["時間", byHint.time_candidate],
        ["緯度", byHint.latitude_candidate],
        ["經度", byHint.longitude_candidate],
        ["識別", byHint.identity_candidate],
      ]
        .map(([label, values]) => `${label}: ${values.slice(0, 3).join(", ") || "-"}`)
        .join(" / ");
    }

    roleForColumn(mapping, column) {
      if (mapping) {
        const roles = mapping.roles || {};
        for (const role of CANONICAL_ROLE_KEYS) {
          if (roles[role] === column.name) return role;
        }
        if ((mapping.metric_columns || []).includes(column.name)) return "metric";
        if ((mapping.category_columns || []).includes(column.name)) return "category";
        if ((mapping.display_columns || []).includes(column.name)) return "display";
        if ((mapping.selected_columns || []).includes(column.name)) return "display";
        return "ignore";
      }
      return "ignore";
    }

    roleSelectMarkup(column, role) {
      const options = Object.entries(ROLE_LABELS).map(([value, label]) => (
        `<option value="${value}" ${value === role ? "selected" : ""}>${escapeHtml(label)}</option>`
      )).join("");
      return `<select class="developer-column-role-select" data-column-role="${escapeHtml(column.name)}">${options}</select>`;
    }

    safeLayerId(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "_")
        .replace(/^[^a-z]+/, "")
        .slice(0, 64) || "layer";
    }
  }

  window.DeveloperMappingController = {
    DeveloperMappingController,
  };
})();
