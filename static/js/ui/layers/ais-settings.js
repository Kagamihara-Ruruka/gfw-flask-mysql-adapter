function updateAisSettingsPanel() {
  const status = $("ais-config-status");
  if (!status) return;
  const settings = state.aisSettings || {};
  const ingest = state.aisIngestStatus || settings.ingest || {};
  const keyGate = settings.collector_key_gate || ingest.key_gate || {};
  const connectedPanel = $("ais-connected-panel");
  const configureButton = $("ais-open-config");
  if (settings.provider === "aishub_polling" && settings.has_aishub_username) {
    status.textContent = "AIS 來源：AISHub 輪詢，間隔 180 秒";
    status.classList.remove("is-warning");
  } else if (settings.has_api_key && settings.provider === "aisstream") {
    if (keyGate.authorized_sql_read) {
      status.textContent = "AIS 爬蟲心跳已匹配，SQL 讀取已解鎖。";
      status.classList.remove("is-warning");
    } else {
      const handoff = settings.collector_handoff || ingest.handoff || {};
      status.textContent =
        keyGate.message ||
        (handoff.exists
          ? "AIS 金鑰已交付到爬蟲，等待爬蟲心跳。"
          : "AIS 金鑰已儲存，但找不到爬蟲交接檔。");
      status.classList.add("is-warning");
    }
  } else {
    status.textContent = "AIS 收集器金鑰尚未設定，AIS SQL 讀取已鎖定。";
    status.classList.add("is-warning");
  }
  if (configureButton) {
    configureButton.hidden = Boolean(settings.has_api_key);
    configureButton.textContent = "交付到爬蟲";
  }
  if (connectedPanel) connectedPanel.hidden = !settings.has_api_key;
}

function renderAisDiagnostics(packet) {
  const result = $("ais-diagnostics-result");
  if (!result) return;
  result.hidden = false;
  result.classList.remove("is-ok", "is-warning", "is-error");
  const accepted = Number(packet.accepted_messages || 0);
  const raw = Number(packet.raw_messages || 0);
  const dropped = Number(packet.dropped_messages || 0);
  if (packet.status === "ok" && accepted > 0) {
    result.classList.add("is-ok");
  } else if (packet.status === "error" || packet.status === "missing_api_key") {
    result.classList.add("is-error");
  } else {
    result.classList.add("is-warning");
  }
  const elapsed = formatDisplayNumber(
    packet.total_elapsed_seconds || packet.duration_seconds || 0,
    { maximumFractionDigits: 1 },
  );
  result.innerHTML = [
    `<strong>診斷：${packet.status || "unknown"}</strong>`,
    `<span>${packet.diagnosis || "未回傳診斷。"}</span>`,
    `<span>${accepted.toLocaleString()} 筆接收 / ${raw.toLocaleString()} 筆原始 / ${dropped.toLocaleString()} 筆丟棄，耗時 ${elapsed} 秒。</span>`,
  ].join("");
}

function setAisConfigModal(open) {
  const modal = $("ais-config-modal");
  if (!modal) return;
  modal.hidden = !open;
  if (open) {
    const input = $("ais-api-key");
    if (input) input.focus();
  }
}

function bindAisStreamControls() {
  const saveButton = $("ais-save-key");
  const disconnectButton = $("ais-disconnect-key");
  const diagnosticsButton = $("ais-run-diagnostics");
  const openButton = $("ais-open-config");
  const closeButton = $("ais-modal-close");
  const modal = $("ais-config-modal");
  const keyInput = $("ais-api-key");
  if (openButton) {
    openButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await loadAisSettings();
        setAisConfigModal(true);
      } catch (err) {
        console.error(err);
        setStatus(err.message, true);
      }
    });
  }
  if (closeButton) {
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setAisConfigModal(false);
    });
  }
  if (modal) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        setAisConfigModal(false);
      }
    });
  }
  if (saveButton && keyInput) {
    saveButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      const apiKey = keyInput.value.trim();
      if (!apiKey) {
        setStatus("請先貼上 AIS 收集器 API 金鑰", true);
        return;
      }
      saveButton.disabled = true;
      try {
        await saveAisApiKey(apiKey);
        keyInput.value = "";
        setAisConfigModal(false);
        await loadAisSettings();
        setStatus("AIS 金鑰已交付到爬蟲；爬蟲心跳匹配後才會解鎖 SQL 讀取");
        if (state.dataLayer === "ais") {
          await reloadAisRecords();
        }
      } catch (err) {
        console.error(err);
        setStatus(err.message, true);
      } finally {
        saveButton.disabled = false;
      }
    });
  }
  if (disconnectButton) {
    disconnectButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      disconnectButton.disabled = true;
      try {
        await disconnectAisApiKey();
        if (state.dataLayer === "ais") {
          clearPrimaryLayerRecords();
        }
        await loadAisSettings();
        setStatus("AIS 爬蟲交接已斷開");
      } catch (err) {
        console.error(err);
        setStatus(err.message, true);
      } finally {
        disconnectButton.disabled = false;
      }
    });
  }
  if (diagnosticsButton) {
    diagnosticsButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      diagnosticsButton.disabled = true;
      const result = $("ais-diagnostics-result");
      if (result) {
        result.hidden = false;
        result.classList.remove("is-ok", "is-warning", "is-error");
        result.textContent = "正在測試上游 AISStream 金鑰，約 12 秒...";
      }
      try {
        const packet = await runAisDiagnostics();
        renderAisDiagnostics(packet);
        if (packet.status === "ok" && Number(packet.accepted_messages || 0) > 0) {
          setStatus("AISStream 診斷已收到上游資料幀");
        } else {
          setStatus("AISStream 診斷完成，但沒有可用即時資料幀", true);
        }
      } catch (err) {
        console.error(err);
        if (result) {
          result.hidden = false;
          result.classList.add("is-error");
          result.textContent = err.message;
        }
        setStatus(err.message, true);
      } finally {
        diagnosticsButton.disabled = false;
      }
    });
  }
}

function bindAisHubControls() {
  const saveButton = $("aishub-save-username");
  const diagnosticsButton = $("aishub-run-diagnostics");
  const disconnectButton = $("aishub-disconnect");
  const usernameInput = $("aishub-username");
  if (saveButton && usernameInput) {
    saveButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      const username = usernameInput.value.trim();
      if (!username) {
        setStatus("請先貼上 AISHub 使用者名稱", true);
        return;
      }
      saveButton.disabled = true;
      try {
        await saveAishubUsername(username);
        usernameInput.value = "";
        setStatus("AISHub 已連接；輪詢間隔固定為 180 秒");
        if (state.dataLayer === "ais") {
          await reloadAisRecords();
        }
      } catch (err) {
        console.error(err);
        setStatus(err.message, true);
      } finally {
        saveButton.disabled = false;
      }
    });
  }
  if (diagnosticsButton) {
    diagnosticsButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (state.aisSettings?.provider !== "aishub_polling" || !state.aisSettings?.has_aishub_username) {
        setStatus("請先連接 AISHub 使用者名稱，再執行診斷", true);
        return;
      }
      diagnosticsButton.disabled = true;
      const result = $("ais-diagnostics-result");
      if (result) {
        result.hidden = false;
        result.classList.remove("is-ok", "is-warning", "is-error");
        result.textContent = "正在測試 AISHub...";
      }
      try {
        const packet = await runAisDiagnostics();
        renderAisDiagnostics(packet);
        if (packet.status === "ok" && Number(packet.accepted_messages || 0) > 0) {
          setStatus("AISHub 診斷已收到資料列");
        } else {
          setStatus("AISHub 診斷沒有回傳船舶資料", true);
        }
      } catch (err) {
        console.error(err);
        if (result) {
          result.hidden = false;
          result.classList.add("is-error");
          result.textContent = err.message;
        }
        setStatus(err.message, true);
      } finally {
        diagnosticsButton.disabled = false;
      }
    });
  }
  if (disconnectButton) {
    disconnectButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      disconnectButton.disabled = true;
      try {
        await disconnectAishubUsername();
        if (state.dataLayer === "ais") {
          clearPrimaryLayerRecords();
        }
        setStatus("AISHub 已斷開");
      } catch (err) {
        console.error(err);
        setStatus(err.message, true);
      } finally {
        disconnectButton.disabled = false;
      }
    });
  }
}

function bindAisSettingsControls() {
  bindAisStreamControls();
  bindAisHubControls();
}
