(function () {
  const Utils = window.DeveloperUtils;
  const Api = window.DeveloperConfigApi;
  const ConfigList = window.DeveloperConfigList;
  const SourceGroupSelector = window.DeveloperSourceGroupSelector;
  const ConfigEditor = window.DeveloperConfigEditor;
  const NoteModal = window.DeveloperConfigNoteModal;

  const configDrawerOpen = {};

  const sourceGroupSelector = new SourceGroupSelector({
    Utils,
    Api,
    onCreated: async () => {
      await loadDeveloperConfigs();
    },
  });
  const editor = new ConfigEditor({ Utils, sourceGroupSelector });
  const noteModal = new NoteModal({
    Utils,
    Api,
    onSaved: async (packet, targetPath) => {
      if (editor.isSelected(targetPath)) {
        editor.refreshSelectedConfig(packet.config);
      }
      await loadDeveloperConfigs();
    },
  });

  function renderConfigList(configs, staging, sourceGroups) {
    ConfigList.render(Utils.element("developer-config-list"), configs, staging, sourceGroups, {
      selectedPath: editor.path(),
      drawerOpen: configDrawerOpen,
      onSelect: (config) => {
        loadDeveloperConfig(config.path).catch((err) => Utils.setMessage(err.message, true));
      },
      onStagingSelect: (item) => {
        loadDeveloperConfig(item.path).catch((err) => Utils.setMessage(err.message, true));
      },
      onStagingPromote: (item, group, control) => {
        promoteStagingConfig(item, group, control).catch((err) => Utils.setMessage(err.message, true));
      },
      onStagingDelete: (item, control) => {
        deleteStagingConfig(item, control).catch((err) => Utils.setMessage(err.message, true));
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
                editor.beginEdit();
              }
            })
            .catch((err) => Utils.setMessage(err.message, true));
        } else if (action === "lock") {
          setDeveloperConfigLocked(config.path, !config.locked).catch((err) => Utils.setMessage(err.message, true));
        } else if (action === "note") {
          noteModal.open(config);
        } else if (action === "delete") {
          deleteDeveloperConfig(config).catch((err) => Utils.setMessage(err.message, true));
        }
      },
    });
  }

  async function loadDeveloperConfigs() {
    const packet = await Api.listConfigs();
    const sourceGroups = packet.source_groups || [];
    sourceGroupSelector.setDrawers(sourceGroups);
    renderConfigList(packet.configs || [], packet.staging || null, sourceGroups);
    if (!editor.path() && packet.configs?.length) {
      const initialConfig =
        packet.configs.find((config) => config.active && config.routable) ||
        packet.configs.find((config) => config.routable);
      if (initialConfig) {
        await loadDeveloperConfig(initialConfig.path);
      }
    }
    return packet;
  }

  async function loadDeveloperConfig(configPath) {
    editor.selectPath(configPath);
    const packet = await Api.getConfigContent(configPath);
    const selectedConfig = editor.applyPacket(packet);
    await loadDeveloperConfigs();
    if (selectedConfig?.runtime_current) {
      Utils.setMessage("這是目前服務啟動 JSON；實際資料來源由已勾選的 source config 接管。");
    } else if (selectedConfig?.example) {
      Utils.setMessage("範本為唯讀參考，不會啟用，也不會進入資料源狀態機。");
    }
  }

  async function saveDeveloperConfigContent() {
    if (!editor.path()) {
      return;
    }
    const requestedGroup = editor.requestedGroup();
    const packet = await Api.saveConfigContent(editor.path(), editor.content(), requestedGroup);
    const currentPath = packet.path || packet.config?.path || editor.path();
    editor.applyMove({ moved: currentPath, config: packet.config });
    Utils.setMessage("config 已儲存為待套用版本；請由啟動器受控重啟。", false);
    await loadDeveloperConfig(currentPath);
    await loadDeveloperStatusMachines();
  }

  async function setDeveloperConfigLocked(configPath, locked) {
    await Api.setLocked(configPath, locked);
    Utils.setMessage(locked ? "config 已鎖定" : "config 已解鎖");
    if (editor.isSelected(configPath)) {
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
    if (editor.isSelected(config.path)) {
      editor.clear();
    }
    Utils.setMessage("config 已刪除");
    await loadDeveloperConfigs();
    await loadDeveloperStatusMachines();
  }

  async function importDeveloperConfig(file, group = "auto") {
    if (!file) {
      return null;
    }
    Utils.setMessage(`暫存 ${file.name} 中...`);
    const packet = await Api.importConfig(file, group);
    const importedPath = packet.item?.path || null;
    editor.selectPath(importedPath);
    Utils.setMessage(packet.message || "config 已暫存");
    await loadDeveloperConfigs();
    if (importedPath) {
      await loadDeveloperConfig(importedPath);
    }
    return packet;
  }

  async function promoteStagingConfig(item, group, control) {
    if (!item?.path) {
      throw new Error("找不到暫存 config。");
    }
    if (!group) {
      throw new Error("請先選擇資料源 group。");
    }
    if (control) {
      control.disabled = true;
    }
    try {
      const packet = await Api.promoteStagingConfig(item.path, group);
      editor.selectPath(packet.config?.path || packet.promoted || null);
      Utils.setMessage(packet.message || "暫存 config 已導入");
      await loadDeveloperConfigs();
      await loadDeveloperStatusMachines();
      return packet;
    } finally {
      if (control) {
        control.disabled = false;
      }
    }
  }

  async function deleteStagingConfig(item, control) {
    if (!item?.path) {
      throw new Error("找不到暫存 config。");
    }
    if (control) {
      control.disabled = true;
    }
    try {
      const packet = await Api.deleteStagingConfig(item.path);
      if (editor.isSelected(item.path)) {
        editor.clear();
      }
      Utils.setMessage(packet.message || "暫存 config 已刪除");
      await loadDeveloperConfigs();
      return packet;
    } finally {
      if (control) {
        control.disabled = false;
      }
    }
  }

  async function setDeveloperConfigActive(configPath, active) {
    await Api.setActive(configPath, active);
    Utils.setMessage(
      active ? "config 啟用狀態已儲存，待啟動器重啟套用。" : "config 停用狀態已儲存，待啟動器重啟套用。",
    );
    await loadDeveloperConfigs();
    await loadDeveloperStatusMachines();
  }

  function bindDeveloperConfigControls() {
    Utils.element("developer-config-save")?.addEventListener("click", () => {
      saveDeveloperConfigContent().catch((err) => Utils.setMessage(err.message, true));
    });
    Utils.element("developer-config-cancel")?.addEventListener("click", () => {
      editor.cancel();
    });
    sourceGroupSelector.bind();
    noteModal.bind();

    bindConfigWizardControls();
    bindConfigImportModalControls();
    bindDeveloperLayerImportControls();
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
