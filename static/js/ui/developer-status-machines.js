(function () {
  const {
    element: developerElement,
    setMessage: setDeveloperMessage,
    escapeHtml,
  } = window.DeveloperUtils;

  let statusMachineTimer = null;
  let statusMachineLoading = false;

  function renderDeveloperRouterStatus(rows) {
    const body = developerElement("developer-router-status-body");
    if (!body) {
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6">尚未找到可檢查的連線。</td></tr>';
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
        <td>${escapeHtml(row.detail || "")}</td>
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
      body.innerHTML = '<tr><td colspan="6">尚未找到 WebSocket 類 config。</td></tr>';
      return;
    }
    body.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.config_path)}</td>
        <td>${escapeHtml(row.provider || "-")}</td>
        <td>${escapeHtml(row.endpoint || "-")}</td>
        <td><span class="developer-bit ${row.enabled ? "is-on" : "is-off"}">${row.enabled ? "1" : "0"}</span></td>
        <td><span class="developer-bit ${row.configured ? "is-on" : "is-off"}">${row.configured ? "1" : "0"}</span></td>
        <td>${escapeHtml(row.detail || "")}</td>
      `;
      body.appendChild(tr);
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

  async function loadDeveloperStatusMachines() {
    if (statusMachineLoading) {
      return;
    }
    statusMachineLoading = true;
    try {
      await Promise.all([loadDeveloperRouterStatus(), loadDeveloperWebsocketStatus()]);
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


  window.loadDeveloperStatusMachines = loadDeveloperStatusMachines;
  window.startDeveloperStatusMonitor = startDeveloperStatusMonitor;
})();
