function updateAisSettingsPanel() {
  const status = $("ais-config-status");
  if (!status) return;
  const settings = state.aisSettings || {};
  const connectedPanel = $("ais-connected-panel");
  const configureButton = $("ais-open-config");
  if (settings.provider === "aishub_polling" && settings.has_aishub_username) {
    status.textContent = "AIS provider: AISHub polling, 180s interval";
    status.classList.remove("is-warning");
  } else if (settings.has_api_key && settings.provider === "aisstream") {
    status.textContent = "AIS provider: AISStream WebSocket";
    status.classList.remove("is-warning");
  } else {
    status.textContent = "AIS provider: not connected";
    status.classList.add("is-warning");
  }
  if (configureButton) {
    configureButton.hidden = Boolean(settings.has_api_key);
    configureButton.textContent = "Setup AISStream";
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
  const elapsed = Number(packet.total_elapsed_seconds || packet.duration_seconds || 0).toFixed(1);
  result.innerHTML = [
    `<strong>Diagnostics: ${packet.status || "unknown"}</strong>`,
    `<span>${packet.diagnosis || "No diagnosis returned."}</span>`,
    `<span>${accepted.toLocaleString()} accepted / ${raw.toLocaleString()} raw / ${dropped.toLocaleString()} dropped frames in ${elapsed}s.</span>`,
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
    openButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setAisConfigModal(true);
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
        setStatus("Paste an AISStream API key first", true);
        return;
      }
      saveButton.disabled = true;
      try {
        await saveAisApiKey(apiKey);
        keyInput.value = "";
        setAisConfigModal(false);
        setStatus("AISStream key connected; live mode is ready");
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
        setStatus("AISStream key disconnected");
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
        result.textContent = "Testing AISStream for 12 seconds...";
      }
      try {
        const packet = await runAisDiagnostics();
        renderAisDiagnostics(packet);
        if (packet.status === "ok" && Number(packet.accepted_messages || 0) > 0) {
          setStatus("AISStream diagnostics received live frames");
        } else {
          setStatus("AISStream diagnostics completed with no usable live frames", true);
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
        setStatus("Paste an AISHub username first", true);
        return;
      }
      saveButton.disabled = true;
      try {
        await saveAishubUsername(username);
        usernameInput.value = "";
        setStatus("AISHub connected; polling interval fixed at 180 seconds");
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
        setStatus("Connect AISHub username before running AISHub diagnostics", true);
        return;
      }
      diagnosticsButton.disabled = true;
      const result = $("ais-diagnostics-result");
      if (result) {
        result.hidden = false;
        result.classList.remove("is-ok", "is-warning", "is-error");
        result.textContent = "Testing AISHub...";
      }
      try {
        const packet = await runAisDiagnostics();
        renderAisDiagnostics(packet);
        if (packet.status === "ok" && Number(packet.accepted_messages || 0) > 0) {
          setStatus("AISHub diagnostics received rows");
        } else {
          setStatus("AISHub diagnostics returned no vessel rows", true);
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
        setStatus("AISHub disconnected");
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
  loadAisSettings().catch((err) => {
    console.error(err);
    setStatus(err.message, true);
  });
}
