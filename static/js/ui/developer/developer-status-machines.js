(function () {
  const {
    element: developerElement,
    setMessage: setDeveloperMessage,
    escapeHtml,
  } = window.DeveloperUtils;
  const { DeveloperStatusTable, bitCell } = window.DeveloperStatusTable;
  const { DeveloperMappingController } = window.DeveloperMappingController;

  let statusMachineLoading = false;
  let statusMachineErrorMessage = "";
  let schemaProfilesLoadedAt = 0;
  const SCHEMA_PROFILE_REFRESH_MS = 60000;

  const mappingController = new DeveloperMappingController({
    api: window.DeveloperConfigApi,
    setMessage: setDeveloperMessage,
    onSaved: async () => {
      schemaProfilesLoadedAt = 0;
      await Promise.all([loadDeveloperSchemaProfiles({ force: true }), loadDeveloperLayerImports()]);
    },
  });

  function renderDeveloperRouterStatus(rows) {
    new DeveloperStatusTable({
      bodyId: "developer-router-status-body",
      emptyText: "沒有啟用中的 DATABASE 路由。",
      columns: [
        { key: "config_path", width: "24%", render: (row) => escapeHtml(row.config_path) },
        { key: "connection_ref", width: "12%", render: (row) => escapeHtml(row.connection_ref) },
        { key: "backend", width: "10%", render: (row) => escapeHtml(row.backend) },
        { key: "enabled", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.enabled) },
        { key: "connected", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.connected) },
        { key: "schema_inspectable", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.schema_inspectable) },
        { key: "detail", className: "developer-long-value", render: (row) => escapeHtml(row.detail || "") },
      ],
    }).render(rows);
  }

  function renderDeveloperWebsocketStatus(rows) {
    new DeveloperStatusTable({
      bodyId: "developer-websocket-status-body",
      emptyText: "沒有啟用中的 WebSocket config。",
      columns: [
        { key: "config_path", width: "24%", render: (row) => escapeHtml(row.config_path) },
        { key: "provider", width: "10rem", render: (row) => escapeHtml(row.provider || "-") },
        { key: "endpoint", width: "28%", className: "developer-long-value", render: (row) => escapeHtml(row.endpoint || "-") },
        { key: "enabled", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.enabled) },
        { key: "configured", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.configured) },
        { key: "detail", className: "developer-long-value", render: (row) => escapeHtml(row.detail || "") },
      ],
    }).render(rows);
  }

  function renderDeveloperEndpointStatus(rows) {
    new DeveloperStatusTable({
      bodyId: "developer-endpoint-status-body",
      emptyText: "沒有啟用中的 Endpoint config。",
      columns: [
        { key: "config_path", width: "22%", render: (row) => escapeHtml(row.config_path) },
        { key: "endpoint_ref", width: "10rem", render: (row) => escapeHtml(row.endpoint_ref || "-") },
        { key: "base_url", width: "28%", className: "developer-long-value", render: (row) => escapeHtml(row.base_url || "-") },
        { key: "enabled", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.enabled) },
        { key: "configured", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.configured) },
        { key: "reachable", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.reachable) },
        { key: "contract_detected", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.contract_detected) },
        { key: "detail", className: "developer-long-value", render: (row) => escapeHtml(row.detail || "") },
      ],
    }).render(rows);
  }

  function spatialTableStatusLabel(state) {
    if (state?.label) {
      return state.label;
    }
    if (state?.status === "ok") {
      return "就緒";
    }
    if (state?.status === "missing") {
      return "缺表";
    }
    if (state?.status === "empty") {
      return "空表";
    }
    return "未檢查";
  }

  function renderSpatialTableStates(row) {
    const states = Array.isArray(row.table_states) ? row.table_states : [];
    if (!states.length) {
      return escapeHtml(row.tables || "-");
    }
    return states
      .map((state) => `${escapeHtml(state.name || "-")}: ${escapeHtml(spatialTableStatusLabel(state))}`)
      .join("<br>");
  }

  function renderDeveloperSpatialStatus(rows) {
    new DeveloperStatusTable({
      bodyId: "developer-spatial-status-body",
      emptyText: "沒有啟用中的 Spatial / PostGIS config。",
      columns: [
        { key: "config_path", width: "22%", render: (row) => escapeHtml(row.config_path) },
        { key: "overlay_ref", width: "8rem", render: (row) => escapeHtml(row.overlay_ref || "-") },
        { key: "backend", width: "8rem", render: (row) => escapeHtml(row.backend || "-") },
        { key: "enabled", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.enabled) },
        { key: "connected", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.connected) },
        { key: "ready", width: "5rem", className: "developer-status-bit-cell", render: (row) => bitCell(row.ready) },
        {
          key: "detail",
          className: "developer-long-value",
          render: (row) => `${renderSpatialTableStates(row)}<br>${escapeHtml(row.detail || "-")}`,
        },
      ],
    }).render(rows);
  }

  function renderDeveloperLayerImports(rows) {
    new DeveloperStatusTable({
      bodyId: "developer-layer-imports-body",
      emptyText: "尚未生成可導入的資料圖層合約。",
      columns: [
        {
          key: "imported",
          width: "5rem",
          render: (row) => {
            const checked = row.imported ? "checked" : "";
            return `
              <label class="developer-layer-import-toggle">
                <input type="checkbox" data-layer-import-toggle="${escapeHtml(row.layer_id)}" ${checked}>
                <span>${row.imported ? "導入" : "停用"}</span>
              </label>
            `;
          },
        },
        {
          key: "layer",
          width: "13rem",
          render: (row) => `<strong>${escapeHtml(row.label || row.layer_id)}</strong><small>${escapeHtml(row.layer_id)}</small>`,
        },
        {
          key: "contract_group",
          width: "7rem",
          render: (row) => escapeHtml((row.contract_group || row.contract_source || "-").toUpperCase()),
        },
        {
          key: "source_route_group",
          width: "13rem",
          render: (row) => `${escapeHtml((row.source_route_group || row.route_group || "-").toUpperCase())}<small>${escapeHtml(row.source_config_path || "")}</small>`,
        },
        {
          key: "source_label",
          width: "14rem",
          render: (row) => `${escapeHtml(row.source_label || row.source_ref || "-")}<small>${escapeHtml(row.source_ref || "")}</small>`,
        },
        {
          key: "config_path",
          width: "16rem",
          className: "developer-long-value",
          render: (row) => escapeHtml(row.config_path || "-"),
        },
        { key: "detail", className: "developer-long-value", render: (row) => escapeHtml(row.detail || "-") },
      ],
    }).render(rows);
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

  async function loadDeveloperEndpointStatus() {
    const response = await fetch("/api/developer/endpoint-status");
    const packet = await response.json();
    if (!response.ok) {
      throw new Error(packet.error || "Endpoint 狀態讀取失敗。");
    }
    renderDeveloperEndpointStatus(packet.rows || []);
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
    mappingController.renderProfiles(packet.profiles || [], packet.mappings || [], packet.router_rows || []);
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
        loadDeveloperEndpointStatus(),
        loadDeveloperSpatialStatus(),
        loadDeveloperSchemaProfiles(),
        loadDeveloperLayerImports(),
      ]);
      clearStatusMachineError();
    } finally {
      statusMachineLoading = false;
    }
  }

  function setStatusMachineError(err) {
    statusMachineErrorMessage = err.message;
    setDeveloperMessage(statusMachineErrorMessage, true);
  }

  function clearStatusMachineError() {
    if (!statusMachineErrorMessage) {
      return;
    }
    const messageTarget = developerElement("developer-config-message");
    if (messageTarget?.textContent === statusMachineErrorMessage) {
      setDeveloperMessage("");
    }
    statusMachineErrorMessage = "";
  }

  function startDeveloperStatusMonitor() {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        loadDeveloperStatusMachines().catch(setStatusMachineError);
      }
    });
    window.addEventListener("focus", () => {
      if (!document.hidden) {
        loadDeveloperStatusMachines().catch(setStatusMachineError);
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

    mappingController.bindSaveControls(document);
  }

  window.loadDeveloperStatusMachines = loadDeveloperStatusMachines;
  window.startDeveloperStatusMonitor = startDeveloperStatusMonitor;
  window.bindDeveloperLayerImportControls = bindDeveloperLayerImportControls;
})();
