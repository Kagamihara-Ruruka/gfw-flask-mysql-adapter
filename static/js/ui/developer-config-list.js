(function () {
  const { escapeHtml, formatBytes } = window.DeveloperUtils;

  const GROUPS = [
    { id: "database", label: "DATABASE", routable: true },
    { id: "websocket", label: "WEBSOCKET", routable: true },
    { id: "spatial", label: "SPATIAL", routable: true },
    { id: "demo", label: "DEMO", routable: false },
  ];

  const GROUP_BY_ID = Object.fromEntries(GROUPS.map((group) => [group.id, group]));

  function normalizeGroup(config) {
    const group = config.group || (config.example ? "demo" : "database");
    return GROUP_BY_ID[group] ? group : "database";
  }

  function groupLabel(group) {
    return GROUP_BY_ID[group]?.label || GROUP_BY_ID.database.label;
  }

  function isRoutableGroup(group) {
    return GROUP_BY_ID[group]?.routable !== false;
  }

  function summaryText(config) {
    const parts = [];
    if (config.connections?.length) {
      parts.push(`${config.connections.length} 個連線`);
    }
    if (config.datasets?.length) {
      parts.push(`${config.datasets.length} 個資料集`);
    }
    parts.push(formatBytes(config.size_bytes));
    return parts.join(" / ");
  }

  function configRoleLabel(config, group, isDemo) {
    if (isDemo) {
      return "DEMO";
    }
    if (group === "websocket") {
      return "WebSocket";
    }
    if (group === "spatial") {
      return "Spatial";
    }
    return config.managed ? "匯入" : "本機";
  }

  function renderItem(config, options) {
    const group = normalizeGroup(config);
    const isDemo = group === "demo" || Boolean(config.example);
    const isRoutable = isRoutableGroup(group) && !isDemo;
    const item = document.createElement("div");
    item.className = `developer-config-item${isDemo ? " is-demo" : ""}${!isRoutable ? " is-non-routable" : ""}`;
    item.dataset.configPath = config.path;
    item.setAttribute("role", "option");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-selected", config.path === options.selectedPath ? "true" : "false");

    const noteText = config.note ? escapeHtml(config.note) : "尚未註記";
    const roleLabel = configRoleLabel(config, group, isDemo);
    const activeControl = !isRoutable
      ? '<span class="developer-config-active is-disabled" aria-hidden="true"></span>'
      : `<label class="developer-config-active" title="啟用這份 config">
          <input type="checkbox" ${config.active ? "checked" : ""}>
        </label>`;
    const viewLabel = config.edit_allowed && !isDemo ? "編輯" : "檢視";
    const lockTitle = config.locked ? "解除鎖定" : "鎖定";
    const lockLabel = config.locked ? "解鎖" : "鎖定";
    const parseLabel = config.parse_ok ? "JSON" : "錯誤";
    const summary = config.parse_ok ? summaryText(config) : config.error;

    item.innerHTML = `
      ${activeControl}
      <span class="developer-config-main">
        <strong>${escapeHtml(config.name)}</strong>
        <small>${escapeHtml(config.path)}</small>
        <em><span class="developer-config-role">${roleLabel}</span> ${escapeHtml(summary)}</em>
        <em class="developer-config-note-preview">${noteText}</em>
      </span>
      <span class="developer-config-actions">
        <span class="developer-status-badge ${config.parse_ok ? "is-ok" : "is-error"}">${parseLabel}</span>
        <button class="developer-config-action" type="button" data-action="view" title="檢視 / 編輯">${viewLabel}</button>
        <button class="developer-config-action" type="button" data-action="lock" title="${lockTitle}" ${isDemo ? "disabled" : ""}>${lockLabel}</button>
        <button class="developer-config-action" type="button" data-action="note" title="編輯註記" ${isDemo ? "disabled" : ""}>註記</button>
        <button class="developer-config-action is-danger" type="button" data-action="delete" title="刪除匯入 config" ${config.delete_allowed ? "" : "disabled"}>刪除</button>
      </span>
    `;

    item.addEventListener("click", () => options.onSelect(config));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        options.onSelect(config);
      }
    });

    const activeInput = item.querySelector("input");
    if (activeInput) {
      activeInput.addEventListener("click", (event) => event.stopPropagation());
      activeInput.addEventListener("change", (event) => {
        options.onActive(config, event.currentTarget.checked, event.currentTarget);
      });
    }

    for (const button of item.querySelectorAll("[data-action]")) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        options.onAction(config, event.currentTarget.dataset.action, isDemo);
      });
    }

    return item;
  }

  function renderGroup(list, groupDefinition, configs, options) {
    const group = document.createElement("details");
    group.className = `developer-config-group developer-config-group-${groupDefinition.id}`;
    group.open = Boolean(options.groupOpen[groupDefinition.id]);
    group.innerHTML = `
      <summary>
        <span>${groupDefinition.label}</span>
        <small>${configs.length} 個 config</small>
      </summary>
      <div class="developer-config-group-list"></div>
    `;
    group.addEventListener("toggle", () => {
      options.groupOpen[groupDefinition.id] = group.open;
    });
    const groupList = group.querySelector(".developer-config-group-list");
    for (const config of configs) {
      groupList.appendChild(renderItem(config, options));
    }
    list.appendChild(group);
  }

  function render(list, configs, options) {
    if (!list) {
      return;
    }
    if (!configs.length) {
      list.innerHTML = '<div class="developer-empty-state">尚未找到 config。</div>';
      return;
    }

    const groupedConfigs = Object.fromEntries(GROUPS.map((group) => [group.id, []]));
    for (const config of configs) {
      groupedConfigs[normalizeGroup(config)].push(config);
    }

    list.innerHTML = "";
    for (const group of GROUPS) {
      renderGroup(list, group, groupedConfigs[group.id], options);
    }
  }

  window.DeveloperConfigList = {
    GROUPS,
    groupLabel,
    render,
  };
})();
