(function () {
  const { jsonOrError } = window.DeveloperUtils;

  async function listConfigs() {
    const response = await fetch("/api/developer/configs");
    return jsonOrError(response, "config 列表讀取失敗");
  }

  async function getConfigContent(configPath) {
    const response = await fetch(`/api/developer/configs/content?path=${encodeURIComponent(configPath)}`);
    return jsonOrError(response, "config 內容讀取失敗");
  }

  async function saveConfigContent(configPath, content, group = "") {
    const response = await fetch("/api/developer/configs/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, content, group }),
    });
    return jsonOrError(response, "config 儲存失敗");
  }

  async function setLocked(configPath, locked) {
    const response = await fetch("/api/developer/configs/locked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, locked }),
    });
    return jsonOrError(response, "鎖定狀態更新失敗");
  }

  async function deleteConfig(configPath) {
    const response = await fetch("/api/developer/configs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath }),
    });
    return jsonOrError(response, "config 刪除失敗");
  }

  async function importConfig(file, group) {
    const form = new FormData();
    form.append("config", file);
    form.append("group", group);
    const response = await fetch("/api/developer/configs/import", {
      method: "POST",
      body: form,
    });
    return jsonOrError(response, "config 匯入失敗");
  }

  async function promoteStagingConfig(stagingPath, group) {
    const response = await fetch("/api/developer/config-staging/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: stagingPath, group }),
    });
    return jsonOrError(response, "暫存 config 導入失敗");
  }

  async function moveConfigSourceGroup(configPath, group) {
    const response = await fetch("/api/developer/configs/group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, group }),
    });
    return jsonOrError(response, "config 群組更新失敗");
  }

  async function deleteStagingConfig(stagingPath) {
    const response = await fetch("/api/developer/config-staging", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: stagingPath }),
    });
    return jsonOrError(response, "暫存 config 刪除失敗");
  }

  async function createSourceGroup(group) {
    const response = await fetch("/api/developer/source-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group }),
    });
    return jsonOrError(response, "資料源抽屜建立失敗");
  }

  async function updateSourceGroup(group, patch) {
    const response = await fetch("/api/developer/source-groups", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group, ...patch }),
    });
    return jsonOrError(response, "資料源抽屜更新失敗");
  }

  async function setActive(configPath, active) {
    const response = await fetch("/api/developer/configs/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, active }),
    });
    return jsonOrError(response, "啟用狀態更新失敗");
  }

  async function saveNote(configPath, note) {
    const response = await fetch("/api/developer/configs/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, note }),
    });
    return jsonOrError(response, "註記儲存失敗");
  }

  async function setLayerImport(layerId, imported) {
    const response = await fetch("/api/developer/layer-imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layer_id: layerId, imported }),
    });
    return jsonOrError(response, "資料圖層導入狀態更新失敗");
  }

  async function listSchemaProfiles() {
    const response = await fetch("/api/developer/schema-profiles");
    return jsonOrError(response, "schema profile 讀取失敗");
  }

  async function listLayerContracts() {
    const response = await fetch("/api/developer/layer-contracts");
    return jsonOrError(response, "layer contract 讀取失敗");
  }

  async function listLayerMappings() {
    const response = await fetch("/api/developer/layer-mappings");
    return jsonOrError(response, "layer mapping 讀取失敗");
  }

  async function saveLayerMapping(mapping) {
    const response = await fetch("/api/developer/layer-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapping),
    });
    return jsonOrError(response, "layer mapping 儲存失敗");
  }

  async function setLayerMappingEnabled(mappingId, enabled) {
    const response = await fetch("/api/developer/layer-mappings/enabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapping_id: mappingId, enabled }),
    });
    return jsonOrError(response, "layer mapping 啟用狀態更新失敗");
  }

  window.DeveloperConfigApi = {
    listConfigs,
    getConfigContent,
    saveConfigContent,
    setLocked,
    deleteConfig,
    importConfig,
    promoteStagingConfig,
    moveConfigSourceGroup,
    deleteStagingConfig,
    createSourceGroup,
    updateSourceGroup,
    setActive,
    saveNote,
    setLayerImport,
    listSchemaProfiles,
    listLayerContracts,
    listLayerMappings,
    saveLayerMapping,
    setLayerMappingEnabled,
  };
})();
