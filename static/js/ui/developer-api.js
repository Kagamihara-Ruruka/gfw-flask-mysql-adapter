(function () {
  const { jsonOrError } = window.DeveloperUtils;

  async function listConfigs() {
    const response = await fetch("/api/developer/configs");
    return jsonOrError(response, "config 清單讀取失敗");
  }

  async function getConfigContent(configPath) {
    const response = await fetch(`/api/developer/configs/content?path=${encodeURIComponent(configPath)}`);
    return jsonOrError(response, "config 內容讀取失敗");
  }

  async function saveConfigContent(configPath, content) {
    const response = await fetch("/api/developer/configs/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, content }),
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

  async function setGroup(configPath, group) {
    const response = await fetch("/api/developer/configs/group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, group }),
    });
    return jsonOrError(response, "config group update failed");
  }

  async function setActive(configPath, active) {
    const response = await fetch("/api/developer/configs/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, active }),
    });
    return jsonOrError(response, "config 啟用狀態更新失敗");
  }

  async function saveNote(configPath, note) {
    const response = await fetch("/api/developer/configs/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configPath, note }),
    });
    return jsonOrError(response, "註記儲存失敗");
  }

  window.DeveloperConfigApi = {
    listConfigs,
    getConfigContent,
    saveConfigContent,
    setLocked,
    deleteConfig,
    importConfig,
    setGroup,
    setActive,
    saveNote,
  };
})();
