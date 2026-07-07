(function () {
  const {
    element: developerElement,
    setMessage: setDeveloperMessage,
    escapeHtml,
  } = window.DeveloperUtils;

  let statusMachineTimer = null;
  let statusMachineLoading = false;
  let schemaProfilesLoadedAt = 0;
  let schemaMappings = [];
  const SCHEMA_PROFILE_REFRESH_MS = 60000;

  const ROLE_LABELS = {
    ignore: "不查詢",
    display: "顯示欄",
    metric: "指標值",
    category: "分類欄",
    time: "時間",
    lat: "緯度",
    lon: "經度",
    id: "識別",
  };

  function renderDeveloperRouterStatus(rows) {
    const body = developerElement("developer-router-status-body");
    if (!body) {
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6">沒有啟用中的 DATABASE 路由。</td></tr>';
      return;
    }
    body.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.config_path)}</td>
        <td>${escapeHtml(row.connection_ref)}</td>
        <td>${escapeHtml(row.backend)}</td>
        <td><span class="developer-bit ${row.enabled ? "is-on" : "is-off"}">${row.enabled ? "1" : "0"}</span></td>
        <td><span class="developer-bit ${row.connected ? "is-on" : "is-off"}">${row.connected ? "1" : "0"}</span></td>
        <td class="developer-long-value">${escapeHtml(row.detail || "")}</td>
      `;
      body.appendChild(tr);
    }
  }

  function renderDeveloperWebsocketStatus(rows) {
    const body = developerElement("developer-websocket-status-body");
    if (!body) {
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6">沒有啟用中的 WebSocket config。</td></tr>';
      return;
    }
    body.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.config_path)}</td>
        <td>${escapeHtml(row.provider || "-")}</td>
        <td class="developer-long-value">${escapeHtml(row.endpoint || "-")}</td>
        <td><span class="developer-bit ${row.enabled ? "is-on" : "is-off"}">${row.enabled ? "1" : "0"}</span></td>
        <td><span class="developer-bit ${row.configured ? "is-on" : "is-off"}">${row.configured ? "1" : "0"}</span></td>
        <td class="developer-long-value">${escapeHtml(row.detail || "")}</td>
      `;
      body.appendChild(tr);
    }
  }

  function renderDeveloperSpatialStatus(rows) {
    const body = developerElement("developer-spatial-status-body");
    if (!body) {
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7">沒有啟用中的 Spatial / PostGIS config。</td></tr>';
      return;
    }
    body.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.config_path)}</td>
        <td>${escapeHtml(row.overlay_ref || "-")}</td>
        <td>${escapeHtml(row.backend || "-")}</td>
        <td><span class="developer-bit ${row.enabled ? "is-on" : "is-off"}">${row.enabled ? "1" : "0"}</span></td>
        <td><span class="developer-bit ${row.connected ? "is-on" : "is-off"}">${row.connected ? "1" : "0"}</span></td>
        <td><span class="developer-bit ${row.ready ? "is-on" : "is-off"}">${row.ready ? "1" : "0"}</span></td>
        <td class="developer-long-value">${escapeHtml(`${row.tables || "-"} / ${row.detail || ""}`)}</td>
      `;
      body.appendChild(tr);
    }
  }

  function renderDeveloperLayerImports(rows) {
    const body = developerElement("developer-layer-imports-body");
    if (!body) {
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6">啟用路由尚未提供可導入的資料圖層。</td></tr>';
      return;
    }
    body.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      const checked = row.imported ? "checked" : "";
      tr.innerHTML = `
        <td>
          <label class="developer-layer-import-toggle">
            <input type="checkbox" data-layer-import-toggle="${escapeHtml(row.layer_id)}" ${checked}>
            <span>${row.imported ? "導入" : "停用"}</span>
          </label>
        </td>
        <td><strong>${escapeHtml(row.label || row.layer_id)}</strong><small>${escapeHtml(row.layer_id)}</small></td>
        <td>${escapeHtml((row.route_group || "").toUpperCase())}</td>
        <td>${escapeHtml(row.source_label || row.source_ref || "-")}<small>${escapeHtml(row.source_ref || "")}</small></td>
        <td class="developer-long-value">${escapeHtml(row.config_path || "-")}</td>
        <td class="developer-long-value">${escapeHtml(row.detail || "-")}</td>
      `;
      body.appendChild(tr);
    }
  }

  function candidateSummary(columns) {
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

  function safeLayerId(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .slice(0, 64) || "layer";
  }

  function mappingForTable(profile, table) {
    return schemaMappings.find((mapping) => (
      mapping.config_path === profile.config_path
      && mapping.connection_ref === profile.connection_ref
      && mapping.table === table.name
    ));
  }

  function guessedRole(column) {
    const hints = column.semantic_hints || [];
    if (hints.includes("time_candidate")) return "time";
    if (hints.includes("latitude_candidate")) return "lat";
    if (hints.includes("longitude_candidate")) return "lon";
    if (hints.includes("identity_candidate")) return "id";
    if (hints.includes("numeric_candidate")) return "metric";
    return "display";
  }

  function roleForColumn(mapping, column) {
    if (mapping) {
      const roles = mapping.roles || {};
      if (roles.time === column.name) return "time";
      if (roles.lat === column.name) return "lat";
      if (roles.lon === column.name) return "lon";
      if (roles.id === column.name) return "id";
      if ((mapping.metric_columns || []).includes(column.name)) return "metric";
      if ((mapping.category_columns || []).includes(column.name)) return "category";
      if ((mapping.display_columns || []).includes(column.name)) return "display";
      if ((mapping.selected_columns || []).includes(column.name)) return "display";
      return "ignore";
    }
    return guessedRole(column);
  }

  function roleSelectMarkup(column, role) {
    const options = Object.entries(ROLE_LABELS).map(([value, label]) => (
      `<option value="${value}" ${value === role ? "selected" : ""}>${label}</option>`
    )).join("");
    return `<select class="developer-column-role-select" data-column-role="${escapeHtml(column.name)}">${options}</select>`;
  }

  function mappingPayloadFromTable(tableElement) {
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
      if (role === "time" || role === "lat" || role === "lon" || role === "id") {
        roles[role] = column;
      } else if (role === "metric") {
        metricColumns.push(column);
      } else if (role === "category") {
        categoryColumns.push(column);
      } else {
        displayColumns.push(column);
      }
    }
    return {
      mapping_id: tableElement.dataset.mappingId || "",
      enabled: tableElement.querySelector("[data-mapping-enabled]")?.checked ?? true,
      config_path: tableElement.dataset.configPath,
      connection_ref: tableElement.dataset.connectionRef,
      backend: tableElement.dataset.backend || "mysql",
      database: tableElement.dataset.database || "",
      table: tableElement.dataset.table,
      layer_id: safeLayerId(tableElement.querySelector("[data-mapping-layer-id]")?.value),
      label: tableElement.querySelector("[data-mapping-label]")?.value || tableElement.dataset.table,
      roles,
      selected_columns: selectedColumns,
      display_columns: displayColumns,
      metric_columns: metricColumns,
      category_columns: categoryColumns,
    };
  }

  function renderMappingToolbar(profile, table, mapping) {
    const layerId = mapping?.layer_id || safeLayerId(table.legacy_dataset_refs?.[0] || table.name);
    const label = mapping?.label || table.legacy_dataset_refs?.[0] || table.name;
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
      <p class="developer-status-hint">只會查詢被指定角色的欄位；不查詢的欄位不會進入 Layer Contract。</p>
    `;
  }

  function renderDeveloperSchemaProfiles(profiles, mappings) {
    schemaMappings = Array.isArray(mappings) ? mappings : [];
    const list = developerElement("developer-schema-profile-list");
    const status = developerElement("developer-schema-profile-status");
    if (!list) {
      return;
    }
    if (!profiles.length) {
      list.innerHTML = '<div class="developer-schema-empty">沒有啟用中的關聯式 DATABASE 路由。</div>';
      if (status) {
        status.className = "developer-status-badge is-idle";
        status.textContent = "無路由";
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
      const profileCard = document.createElement("article");
      profileCard.className = "developer-schema-profile";
      const tables = profile.tables || [];
      const statusText = profile.status === "ok" ? "可探測" : profile.status === "unsupported" ? "未支援" : "錯誤";
      profileCard.innerHTML = `
        <header class="developer-schema-profile-header">
          <div>
            <strong>${escapeHtml(profile.connection_ref || "-")}</strong>
            <small>${escapeHtml(profile.config_path || "-")} / ${escapeHtml(profile.database || "-")}</small>
          </div>
          <span class="developer-status-badge ${profile.status === "ok" ? "is-ok" : "is-error"}">${escapeHtml(statusText)}</span>
        </header>
        <p class="developer-status-hint">${escapeHtml(profile.detail || "")}</p>
      `;
      if (!tables.length) {
        const empty = document.createElement("div");
        empty.className = "developer-schema-empty";
        empty.textContent = profile.status === "ok" ? "此路由沒有可列出的表格。" : "此路由目前無法產生 schema profile。";
        profileCard.appendChild(empty);
      } else {
        const tableList = document.createElement("div");
        tableList.className = "developer-schema-table-list";
        for (const table of tables) {
          const mapping = mappingForTable(profile, table);
          const tableDetails = document.createElement("details");
          tableDetails.className = "developer-schema-table";
          tableDetails.dataset.mappingId = mapping?.mapping_id || "";
          tableDetails.dataset.configPath = profile.config_path || "";
          tableDetails.dataset.connectionRef = profile.connection_ref || "";
          tableDetails.dataset.backend = profile.backend || "mysql";
          tableDetails.dataset.database = profile.database || "";
          tableDetails.dataset.table = table.name || "";
          const columns = table.columns || [];
          const legacy = (table.legacy_dataset_refs || []).join(", ") || "-";
          tableDetails.innerHTML = `
            <summary>
              <span>
                <strong>${escapeHtml(table.name || "-")}</strong>
                <small>${escapeHtml(table.type || "-")} / 欄位 ${columns.length} / 舊合約 ${escapeHtml(legacy)}</small>
              </span>
              <span class="developer-schema-candidates">${escapeHtml(candidateSummary(columns))}</span>
            </summary>
            ${renderMappingToolbar(profile, table, mapping)}
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
                  ${columns.map((column) => {
                    const role = roleForColumn(mapping, column);
                    return `
                      <tr>
                        <td>${roleSelectMarkup(column, role)}</td>
                        <td><strong>${escapeHtml(column.name || "-")}</strong><small>${column.nullable ? "nullable" : "not null"}</small></td>
                        <td>${escapeHtml(column.column_type || column.data_type || "-")}</td>
                        <td>${escapeHtml(column.key || "-")}</td>
                        <td class="developer-long-value">${escapeHtml((column.semantic_hints || []).join(", ") || "-")}</td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>
          `;
          tableList.appendChild(tableDetails);
        }
        profileCard.appendChild(tableList);
      }
      list.appendChild(profileCard);
    }
  }

  async function loadDeveloperRouterStatus() {
    const response = await fetch("/api/developer/router-status");
    const packet = await response.json();
    if (!response.ok) {
      throw new Error(packet.error || "路由狀態讀取失敗");
    }
    renderDeveloperRouterStatus(packet.rows || []);
  }

  async function loadDeveloperWebsocketStatus() {
    const response = await fetch("/api/developer/websocket-status");
    const packet = await response.json();
    if (!response.ok) {
      throw new Error(packet.error || "WebSocket 狀態讀取失敗");
    }
    renderDeveloperWebsocketStatus(packet.rows || []);
  }

  async function loadDeveloperSpatialStatus() {
    const response = await fetch("/api/developer/spatial-status");
    const packet = await response.json();
    if (!response.ok) {
      throw new Error(packet.error || "Spatial 狀態讀取失敗");
    }
    renderDeveloperSpatialStatus(packet.rows || []);
  }

  async function loadDeveloperLayerImports() {
    const response = await fetch("/api/developer/layer-imports");
    const packet = await response.json();
    if (!response.ok) {
      throw new Error(packet.error || "資料圖層導入狀態讀取失敗");
    }
    renderDeveloperLayerImports(packet.rows || []);
  }

  async function loadDeveloperSchemaProfiles(options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (!force && schemaProfilesLoadedAt && now - schemaProfilesLoadedAt < SCHEMA_PROFILE_REFRESH_MS) {
      return;
    }
    const packet = await window.DeveloperConfigApi.listSchemaProfiles();
    schemaProfilesLoadedAt = now;
    renderDeveloperSchemaProfiles(packet.profiles || [], packet.mappings || []);
  }

  async function loadDeveloperStatusMachines() {
    if (statusMachineLoading) {
      return;
    }
    statusMachineLoading = true;
    try {
      await Promise.all([
        loadDeveloperRouterStatus(),
        loadDeveloperWebsocketStatus(),
        loadDeveloperSpatialStatus(),
        loadDeveloperSchemaProfiles(),
        loadDeveloperLayerImports(),
      ]);
    } finally {
      statusMachineLoading = false;
    }
  }

  function startDeveloperStatusMonitor() {
    if (statusMachineTimer) {
      window.clearInterval(statusMachineTimer);
    }
    statusMachineTimer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      loadDeveloperStatusMachines().catch((err) => setDeveloperMessage(err.message, true));
    }, 5000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        loadDeveloperStatusMachines().catch((err) => setDeveloperMessage(err.message, true));
      }
    });
  }

  function bindDeveloperLayerImportControls() {
    document.addEventListener("change", async (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.matches("[data-layer-import-toggle]")) {
        return;
      }
      const layerId = input.dataset.layerImportToggle;
      try {
        input.disabled = true;
        await window.DeveloperConfigApi.setLayerImport(layerId, input.checked);
        await loadDeveloperLayerImports();
        window.parent?.postMessage({ type: "rrkal:layer-imports-changed", layerId, imported: input.checked }, "*");
      } catch (err) {
        input.checked = !input.checked;
        setDeveloperMessage(err.message, true);
      } finally {
        input.disabled = false;
      }
    });

    document.addEventListener("click", async (event) => {
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
        const payload = mappingPayloadFromTable(tableElement);
        const result = await window.DeveloperConfigApi.saveLayerMapping(payload);
        tableElement.dataset.mappingId = result.mapping?.mapping_id || tableElement.dataset.mappingId || "";
        schemaProfilesLoadedAt = 0;
        await Promise.all([loadDeveloperSchemaProfiles({ force: true }), loadDeveloperLayerImports()]);
        setDeveloperMessage("Mapping 已儲存。");
      } catch (err) {
        setDeveloperMessage(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
  }

  window.loadDeveloperStatusMachines = loadDeveloperStatusMachines;
  window.startDeveloperStatusMonitor = startDeveloperStatusMonitor;
  window.bindDeveloperLayerImportControls = bindDeveloperLayerImportControls;
})();
