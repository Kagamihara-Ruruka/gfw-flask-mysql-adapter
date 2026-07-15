(function () {
  const { escapeHtml, formatBytes } = window.DeveloperUtils;

  function groupLabel(group) {
    return String(group || "CONFIG").toUpperCase();
  }

  function normalizeGroup(config) {
    if (config.source_group) {
      return config.source_group;
    }
    if (config.routable && config.route_group) {
      return config.route_group;
    }
    return "";
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

  function formatMtime(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "最後編輯: -";
    }
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) {
      return "最後編輯: -";
    }
    const pad = (part) => String(part).padStart(2, "0");
    return [
      "最後編輯: ",
      date.getFullYear(),
      "-",
      pad(date.getMonth() + 1),
      "-",
      pad(date.getDate()),
      " ",
      pad(date.getHours()),
      ":",
      pad(date.getMinutes()),
      ":",
      pad(date.getSeconds()),
    ].join("");
  }

  function configRoleLabel(config) {
    if (config.route_group) {
      const suffix = config.builtin_probe ? " / probe" : " / 待 probe";
      return `${groupLabel(config.route_group)}${suffix}`;
    }
    return "";
  }

  class DeveloperConfigItemCard {
    constructor(config, options) {
      this.config = config;
      this.options = options;
      this.isRoutable = Boolean(config.routable) && Boolean(config.route_group);
    }

    render() {
      const item = document.createElement("div");
      item.className = `developer-config-item${!this.isRoutable ? " is-non-routable" : ""}${this.config.route_blocked ? " is-route-blocked" : ""}`;
      item.dataset.configPath = this.config.path;
      item.setAttribute("role", "option");
      item.setAttribute("tabindex", "0");
      item.setAttribute("aria-selected", this.config.path === this.options.selectedPath ? "true" : "false");
      item.innerHTML = this.markup();
      this.bindEvents(item);
      return item;
    }

    markup() {
      const noteText = this.config.note ? escapeHtml(this.config.note) : "尚未註記";
      const roleLabel = configRoleLabel(this.config);
      const viewLabel = this.config.edit_allowed ? "編輯" : "檢視";
      const lockTitle = this.config.locked ? "解除鎖定" : "鎖定";
      const lockLabel = this.config.locked ? "解鎖" : "鎖定";
      const summary = this.config.route_blocked || !this.config.parse_ok
        ? this.config.error
        : summaryText(this.config);
      const roleBadge = roleLabel ? `<span class="developer-config-role">${escapeHtml(roleLabel)}</span>` : "";

      return `
        ${this.activeControlMarkup()}
        <span class="developer-config-main">
          <strong>${escapeHtml(this.config.name)}</strong>
          <small>${escapeHtml(this.config.path)}</small>
          <em>${roleBadge} ${escapeHtml(summary)}</em>
          <em class="developer-config-mtime">${escapeHtml(formatMtime(this.config.mtime))}</em>
          <em class="developer-config-note-preview">${noteText}</em>
        </span>
        <span class="developer-config-actions">
          <button class="developer-config-action" type="button" data-action="view" title="檢視 / 編輯">${viewLabel}</button>
          <button class="developer-config-action" type="button" data-action="lock" title="${lockTitle}">${lockLabel}</button>
          <button class="developer-config-action" type="button" data-action="note" title="編輯註記">註記</button>
          <button class="developer-config-action is-danger" type="button" data-action="delete" title="刪除匯入 config" ${this.config.delete_allowed ? "" : "disabled"}>刪除</button>
        </span>
      `;
    }

    activeControlMarkup() {
      if (!this.isRoutable) {
        return '<span class="developer-config-active is-disabled" aria-hidden="true"></span>';
      }
      return `<label class="developer-config-active" title="啟用這份 config">
          <input type="checkbox" ${this.config.active ? "checked" : ""}>
        </label>`;
    }

    bindEvents(item) {
      item.addEventListener("click", () => this.options.onSelect(this.config));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.options.onSelect(this.config);
        }
      });

      const activeInput = item.querySelector("input");
      if (activeInput) {
        activeInput.addEventListener("click", (event) => event.stopPropagation());
        activeInput.addEventListener("change", (event) => {
          this.options.onActive(this.config, event.currentTarget.checked, event.currentTarget);
        });
      }

      for (const button of item.querySelectorAll("[data-action]")) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.options.onAction(this.config, event.currentTarget.dataset.action);
        });
      }
    }
  }

  class DeveloperConfigDrawer {
    constructor(drawerConfig, configs, options) {
      this.drawerConfig = drawerConfig || {};
      this.groupKey = this.drawerConfig.source_group || this.drawerConfig.name || this.drawerConfig.group || "source";
      this.configs = configs;
      this.options = options;
    }

    render() {
      const drawer = document.createElement("details");
      drawer.className = `developer-config-group developer-config-group-${this.safeClassSuffix()}`;
      drawer.dataset.groupOrder = String(this.drawerConfig.id ?? "");
      drawer.dataset.groupIgnore = String(this.drawerConfig.ignore ?? 0);
      drawer.dataset.sourceGroup = this.groupKey;
      drawer.open = this.options.drawerOpen?.[this.groupKey] ?? true;
      drawer.innerHTML = `
        <summary>
          <span class="developer-config-group-title">
            <span>${escapeHtml(groupLabel(this.drawerConfig.name || this.groupKey))}</span>
            <small>${this.configs.length} 個 config</small>
          </span>
        </summary>
        <div class="developer-config-group-list"></div>
      `;
      drawer.addEventListener("toggle", () => {
        if (this.options.drawerOpen) {
          this.options.drawerOpen[this.groupKey] = drawer.open;
        }
      });
      const groupList = drawer.querySelector(".developer-config-group-list");
      if (this.configs.length) {
        for (const config of this.configs) {
          groupList.appendChild(new DeveloperConfigItemCard(config, this.options).render());
        }
      } else {
        groupList.innerHTML = '<div class="developer-empty-state">尚未放入 config。</div>';
      }
      return drawer;
    }

    safeClassSuffix() {
      return this.groupKey.replace(/[^a-z0-9_-]/gi, "-");
    }
  }

  class DeveloperStagingConfigCard {
    constructor(item, staging, options) {
      this.item = item;
      this.staging = staging;
      this.options = options;
    }

    render() {
      const item = document.createElement("div");
      item.className = "developer-config-item developer-staging-config-item";
      item.dataset.stagingPath = this.item.path;
      item.setAttribute("role", "option");
      item.setAttribute("tabindex", "0");
      item.innerHTML = this.markup();
      this.bindEvents(item);
      return item;
    }

    markup() {
      const suggested = this.item.suggested_group || "";
      const detail = this.item.parse_ok
        ? `候選 group: ${suggested || "未判定"} / ${formatBytes(this.item.size_bytes)}`
        : this.item.error;
      return `
        <span class="developer-config-active is-disabled" aria-hidden="true"></span>
        <span class="developer-config-main">
          <strong>${escapeHtml(this.item.name)}</strong>
          <small>${escapeHtml(this.item.path)}</small>
          <em><span class="developer-config-role">STAGING</span> ${escapeHtml(detail || "-")}</em>
          <em class="developer-config-note-preview">暫存候選檔，尚未進入正式資料源路由。</em>
        </span>
        <span class="developer-config-actions developer-staging-actions">
          <select class="developer-staging-group-select" data-staging-group aria-label="選擇資料源 group" ${this.item.parse_ok ? "" : "disabled"}>
            ${this.groupOptionsMarkup(suggested)}
          </select>
          <button class="developer-config-action" type="button" data-staging-action="view" title="檢視 / 編輯">編輯</button>
          <button class="developer-config-action developer-primary-action" type="button" data-staging-action="promote" title="導入到選定 group" ${this.item.parse_ok ? "" : "disabled"}>導入</button>
          <button class="developer-config-action is-danger" type="button" data-staging-action="delete" title="刪除暫存 config">刪除</button>
        </span>
      `;
    }

    groupOptionsMarkup(suggested) {
      const groups = new Set(this.staging.group_options || []);
      for (const card of this.options.sourceGroups || []) {
        const name = card.source_group || card.name || card.group;
        if (Number(card.ignore || 0) === 0 && name) {
          groups.add(name);
        }
      }
      if (suggested) {
        groups.add(suggested);
      }
      return Array.from(groups).map((group) => (
        `<option value="${escapeHtml(group)}" ${group === suggested ? "selected" : ""}>${escapeHtml(groupLabel(group))}</option>`
      )).join("");
    }

    bindEvents(item) {
      const selectItem = () => this.options.onStagingSelect?.(this.item);
      item.addEventListener("click", selectItem);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectItem();
        }
      });
      item.querySelector("[data-staging-group]")?.addEventListener("click", (event) => event.stopPropagation());
      item.querySelector("[data-staging-group]")?.addEventListener("change", (event) => event.stopPropagation());
      for (const button of item.querySelectorAll("[data-staging-action]")) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const action = event.currentTarget.dataset.stagingAction;
          if (action === "view") {
            this.options.onStagingSelect?.(this.item);
          } else if (action === "promote") {
            const group = item.querySelector("[data-staging-group]")?.value || "";
            this.options.onStagingPromote?.(this.item, group, event.currentTarget);
          } else if (action === "delete") {
            this.options.onStagingDelete?.(this.item, event.currentTarget);
          }
        });
      }
    }
  }

  class DeveloperStagingDrawer {
    constructor(staging, options) {
      this.staging = staging;
      this.options = options;
    }

    render() {
      const drawer = document.createElement("details");
      drawer.className = "developer-config-group developer-config-group-staging";
      drawer.dataset.groupOrder = "0";
      drawer.dataset.groupIgnore = String(this.staging.ignore ?? 0);
      drawer.open = this.options.drawerOpen?.staging ?? true;
      drawer.innerHTML = `
        <summary>
          <span>STAGING</span>
          <small>${this.staging.count} 個候選 config</small>
        </summary>
        <div class="developer-config-group-list"></div>
      `;
      drawer.addEventListener("toggle", () => {
        if (this.options.drawerOpen) {
          this.options.drawerOpen.staging = drawer.open;
        }
      });
      const groupList = drawer.querySelector(".developer-config-group-list");
      for (const item of this.staging.items || []) {
        groupList.appendChild(new DeveloperStagingConfigCard(item, this.staging, this.options).render());
      }
      return drawer;
    }
  }

  class DeveloperConfigListView {
    constructor(list, configs, staging, sourceDrawers, options) {
      this.list = list;
      this.configs = configs;
      this.staging = staging || { status: "empty", count: 0, items: [] };
      this.sourceDrawers = sourceDrawers || [];
      this.options = options;
    }

    render() {
      if (!this.list) {
        return;
      }
      const grouped = this.groupConfigs();
      const sourceDrawers = this.visibleSourceDrawers(grouped);
      const hasStagingItems = Number(this.staging.count || 0) > 0 && Number(this.staging.ignore || 0) === 0;
      if (!sourceDrawers.length && !hasStagingItems) {
        this.list.innerHTML = '<div class="developer-empty-state">尚未找到 config。</div>';
        return;
      }

      this.list.innerHTML = "";
      const renderOptions = { ...this.options, sourceGroups: sourceDrawers };
      if (hasStagingItems) {
        this.list.appendChild(new DeveloperStagingDrawer(this.staging, renderOptions).render());
      }
      for (const drawerConfig of sourceDrawers) {
        const key = drawerConfig.source_group || drawerConfig.name || drawerConfig.group;
        const drawer = new DeveloperConfigDrawer(drawerConfig, grouped.get(key) || [], renderOptions).render();
        this.list.appendChild(drawer);
      }
    }

    visibleSourceDrawers(grouped) {
      const drawers = [];
      const seen = new Set();
      for (const drawerConfig of this.sourceDrawers) {
        const key = drawerConfig.source_group || drawerConfig.name || drawerConfig.group;
        if (!key || Number(drawerConfig.ignore || 0) !== 0) {
          continue;
        }
        seen.add(key);
        drawers.push(drawerConfig);
      }
      if (!this.sourceDrawers.length) {
        for (const key of grouped.keys()) {
          if (!seen.has(key)) {
            drawers.push({ item_type: "source_drawer", id: drawers.length + 1, name: key, source_group: key, ignore: 0 });
          }
        }
      }
      return drawers.sort((left, right) => {
        const leftId = Number(left.id ?? Number.MAX_SAFE_INTEGER);
        const rightId = Number(right.id ?? Number.MAX_SAFE_INTEGER);
        if (leftId !== rightId) {
          return leftId - rightId;
        }
        return String(left.name || "").localeCompare(String(right.name || ""));
      });
    }

    groupConfigs() {
      const grouped = new Map();
      for (const config of this.configs) {
        const key = normalizeGroup(config);
        if (!key) {
          continue;
        }
        if (!grouped.has(key)) {
          grouped.set(key, []);
        }
        grouped.get(key).push(config);
      }
      return grouped;
    }
  }

  function render(list, configs, staging, sourceGroups, options) {
    new DeveloperConfigListView(list, configs, staging, sourceGroups, options).render();
  }

  window.DeveloperConfigList = {
    DeveloperConfigDrawer,
    DeveloperConfigItemCard,
    DeveloperConfigListView,
    DeveloperStagingConfigCard,
    DeveloperStagingDrawer,
    groupLabel,
    render,
  };
})();
