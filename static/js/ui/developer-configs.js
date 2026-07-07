(function () {
  const Utils = window.DeveloperUtils;
  const Api = window.DeveloperConfigApi;
  const ConfigList = window.DeveloperConfigList;

  let selectedConfigPath = null;
  let selectedConfig = null;
  let originalEditorContent = "";
  let isEditingConfig = false;
  let noteModalConfigPath = null;

  const configGroupOpen = {
    database: true,
    websocket: true,
    demo: false,
  };

  function syncEditorControls() {
    const editor = Utils.element("developer-config-editor");
    const saveButton = Utils.element("developer-config-save");
    const cancelButton = Utils.element("developer-config-cancel");
    const groupSelect = Utils.element("developer-config-group");
    const hasConfig = Boolean(selectedConfigPath);
    const canEdit = Boolean(selectedConfig?.edit_allowed) && !selectedConfig?.example;

    if (editor) {
      editor.readOnly = !isEditingConfig || !canEdit;
    }
    if (groupSelect) {
      groupSelect.value = selectedConfig?.group || "database";
      groupSelect.disabled = !hasConfig || !selectedConfig?.group_edit_allowed;
    }
    if (saveButton) {
      Utils.setHidden(saveButton, !isEditingConfig);
      saveButton.disabled = !hasConfig || !canEdit;
    }
    if (cancelButton) {
      Utils.setHidden(cancelButton, !isEditingConfig);
    }
  }

  function clearEditor() {
    selectedConfigPath = null;
    selectedConfig = null;
    originalEditorContent = "";
    const editor = Utils.element("developer-config-editor");
    if (editor) {
      editor.value = "";
    }
    Utils.setParseBadge("待命", "is-idle");
    syncEditorControls();
  }

  function renderConfigList(configs) {
    ConfigList.render(Utils.element("developer-config-list"), configs, {
      selectedPath: selectedConfigPath,
      groupOpen: configGroupOpen,
      onSelect: (config) => {
        loadDeveloperConfig(config.path).catch((err) => Utils.setMessage(err.message, true));
      },
      onActive: (config, active, control) => {
        setDeveloperConfigActive(config.path, active).catch((err) => {
          Utils.setMessage(err.message, true);
          control.checked = config.active;
        });
      },
      onAction: (config, action, isDemo) => {
        if (action === "view") {
          loadDeveloperConfig(config.path)
            .then(() => {
              if (config.edit_allowed && !isDemo) {
                isEditingConfig = true;
                syncEditorControls();
                Utils.element("developer-config-editor")?.focus();
              }
            })
            .catch((err) => Utils.setMessage(err.message, true));
        } else if (action === "lock") {
          setDeveloperConfigLocked(config.path, !config.locked).catch((err) => Utils.setMessage(err.message, true));
        } else if (action === "note") {
          openConfigNoteModal(config);
        } else if (action === "delete") {
          deleteDeveloperConfig(config).catch((err) => Utils.setMessage(err.message, true));
        }
      },
    });
  }

  async function loadDeveloperConfigs() {
    const packet = await Api.listConfigs();
    renderConfigList(packet.configs || []);
    if (!selectedConfigPath && packet.configs?.length) {
      await loadDeveloperConfig(packet.configs[0].path);
    }
    return packet;
  }

  async function loadDeveloperConfig(configPath) {
    selectedConfigPath = configPath;
    isEditingConfig = false;

    const packet = await Api.getConfigContent(configPath);
    const editor = Utils.element("developer-config-editor");
    const meta = Utils.element("developer-config-editor-meta");

    selectedConfig = packet.summary || null;
    originalEditorContent = packet.content || "";
    if (editor) {
      editor.value = originalEditorContent;
    }
    if (meta) {
      meta.textContent = `${packet.path} / ${Utils.formatBytes(packet.summary?.size_bytes || 0)}`;
    }
    Utils.setParseBadge(packet.parse_ok ? "JSON 正常" : "JSON 錯誤", packet.parse_ok ? "is-ok" : "is-error");
    syncEditorControls();
    await loadDeveloperConfigs();
    if (selectedConfig?.example) {
      Utils.setMessage("DEMO 範本為唯讀參考，不會啟用，也不會進入路由狀態機。");
    }
  }

  async function saveDeveloperConfigContent() {
    const editor = Utils.element("developer-config-editor");
    if (!selectedConfigPath || !editor) {
      return;
    }
    await Api.saveConfigContent(selectedConfigPath, editor.value);
    Utils.setMessage("config 已儲存");
    await loadDeveloperConfig(selectedConfigPath);
    await loadDeveloperStatusMachines();
  }

  async function setDeveloperConfigLocked(configPath, locked) {
    await Api.setLocked(configPath, locked);
    Utils.setMessage(locked ? "config 已鎖定" : "config 已解鎖");
    if (configPath === selectedConfigPath) {
      await loadDeveloperConfig(configPath);
    } else {
      await loadDeveloperConfigs();
    }
  }

  async function deleteDeveloperConfig(config) {
    if (!config.delete_allowed) {
      throw new Error("這份 config 目前不可刪除");
    }
    if (!window.confirm(`刪除 ${config.name}？此動作無法復原。`)) {
      return;
    }
    await Api.deleteConfig(config.path);
    if (selectedConfigPath === config.path) {
      clearEditor();
    }
    Utils.setMessage("config 已刪除");
    await loadDeveloperConfigs();
    await loadDeveloperStatusMachines();
  }

  async function importDeveloperConfig(file, group = "database") {
    if (!file) {
      return null;
    }
    Utils.setMessage(`匯入 ${file.name} 中...`);
    const packet = await Api.importConfig(file, group);
    selectedConfigPath = packet.config.path;
    Utils.setMessage(packet.message || "config 已匯入");
    await loadDeveloperConfigs();
    await loadDeveloperStatusMachines();
    return packet;
  }

  async function setDeveloperConfigGroup(configPath, group) {
    const packet = await Api.setGroup(configPath, group);
    selectedConfig = packet.config || selectedConfig;
    Utils.setMessage(`config 已移到 ${ConfigList.groupLabel(packet.config?.group || group)}`);
    await loadDeveloperConfigs();
    await loadDeveloperStatusMachines();
  }

  async function setDeveloperConfigActive(configPath, active) {
    await Api.setActive(configPath, active);
    Utils.setMessage(active ? "config 已啟用" : "config 已停用");
    await loadDeveloperConfigs();
    await loadDeveloperStatusMachines();
  }

  function openConfigNoteModal(config) {
    if (!config || config.example) {
      return;
    }
    noteModalConfigPath = config.path;
    const modal = Utils.element("developer-config-note-modal");
    const textarea = Utils.element("developer-config-note-modal-text");
    const meta = Utils.element("developer-config-note-modal-meta");
    if (meta) {
      meta.textContent = `${config.name} / ${config.path}`;
    }
    if (textarea) {
      textarea.value = config.note || "";
    }
    Utils.setHidden(modal, false);
    textarea?.focus();
  }

  function closeConfigNoteModal() {
    Utils.setHidden(Utils.element("developer-config-note-modal"), true);
    noteModalConfigPath = null;
  }

  async function saveConfigNoteModal() {
    const textarea = Utils.element("developer-config-note-modal-text");
    if (!noteModalConfigPath || !textarea) {
      return;
    }
    const packet = await Api.saveNote(noteModalConfigPath, textarea.value);
    if (noteModalConfigPath === selectedConfigPath) {
      selectedConfig = packet.config || selectedConfig;
    }
    Utils.setMessage("註記已更新");
    closeConfigNoteModal();
    await loadDeveloperConfigs();
  }

  function bindConfigNoteModalControls() {
    Utils.element("developer-config-note-close")?.addEventListener("click", closeConfigNoteModal);
    Utils.element("developer-config-note-cancel")?.addEventListener("click", closeConfigNoteModal);
    Utils.element("developer-config-note-save")?.addEventListener("click", () => {
      saveConfigNoteModal().catch((err) => Utils.setMessage(err.message, true));
    });
    Utils.element("developer-config-note-modal")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closeConfigNoteModal();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !Utils.isHidden(Utils.element("developer-config-note-modal"))) {
        closeConfigNoteModal();
      }
    });
  }

  function bindDeveloperConfigControls() {
    Utils.element("developer-config-group")?.addEventListener("change", (event) => {
      if (!selectedConfigPath) {
        return;
      }
      setDeveloperConfigGroup(selectedConfigPath, event.currentTarget.value).catch((err) => Utils.setMessage(err.message, true));
    });
    Utils.element("developer-config-save")?.addEventListener("click", () => {
      saveDeveloperConfigContent().catch((err) => Utils.setMessage(err.message, true));
    });
    Utils.element("developer-config-cancel")?.addEventListener("click", () => {
      const editor = Utils.element("developer-config-editor");
      if (editor) {
        editor.value = originalEditorContent;
      }
      isEditingConfig = false;
      syncEditorControls();
    });

    bindConfigWizardControls();
    bindConfigNoteModalControls();
    bindConfigImportModalControls();
    bindDropzone();
    startDeveloperStatusMonitor();
    loadDeveloperConfigs()
      .then(() => loadDeveloperStatusMachines())
      .catch((err) => Utils.setMessage(err.message, true));
  }

  window.importDeveloperConfig = importDeveloperConfig;
  window.loadDeveloperConfig = loadDeveloperConfig;
  window.setDeveloperMessage = Utils.setMessage;
  window.bindDeveloperConfigControls = bindDeveloperConfigControls;
})();
