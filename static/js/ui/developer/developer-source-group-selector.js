(function () {
  class DeveloperSourceGroupSelector {
    constructor({ Utils, Api, onCreated }) {
      this.Utils = Utils;
      this.Api = Api;
      this.onCreated = onCreated;
      this.drawers = [];
      this.pendingValue = "";
      this.modalMode = "create";
      this.bound = false;
    }

    value() {
      return this.pendingValue;
    }

    setValue(value) {
      this.pendingValue = String(value || "");
      this.sync();
    }

    setDrawers(drawers) {
      this.drawers = Array.isArray(drawers) ? drawers : [];
      this.sync();
    }

    sync() {
      const select = this.Utils.element("developer-config-group-select");
      if (!select) {
        return;
      }
      const current = this.pendingValue;
      const selectableGroups = this.drawers
        .filter((drawer) => Boolean(drawer.routable))
        .map((drawer) => drawer.source_group || drawer.name || drawer.group)
        .filter(Boolean);
      const uniqueGroups = Array.from(new Set(selectableGroups));
      if (current && !uniqueGroups.includes(current)) {
        uniqueGroups.push(current);
      }
      select.innerHTML = [
        ...uniqueGroups.map((group) => `<option value="${this.Utils.escapeHtml(group)}">${this.Utils.escapeHtml(group.toUpperCase())}</option>`),
        '<option value="__create_source_group__">新增新群組...</option>',
      ].join("");
      select.value = current || uniqueGroups[0] || "";
    }

    openCreateModal(mode = "create") {
      this.modalMode = mode;
      const modal = this.Utils.element("developer-source-group-modal");
      const input = this.Utils.element("developer-source-group-input");
      if (input) {
        input.value = "";
      }
      this.Utils.setHidden(modal, false);
      input?.focus();
    }

    closeCreateModal() {
      this.Utils.setHidden(this.Utils.element("developer-source-group-modal"), true);
      const select = this.Utils.element("developer-config-group-select");
      if (select) {
        select.value = this.pendingValue;
      }
    }

    handleSelectChange(event) {
      const value = event.currentTarget.value;
      if (value === "__create_source_group__") {
        this.openCreateModal("select");
        return;
      }
      this.pendingValue = value;
    }

    async createFromModal() {
      const input = this.Utils.element("developer-source-group-input");
      const group = String(input?.value || "").trim();
      if (!group) {
        throw new Error("請輸入資料源 group 名稱。");
      }
      const packet = await this.Api.createSourceGroup(group);
      if (input) {
        input.value = "";
      }
      this.Utils.setMessage(`資料源抽屜 ${packet.group || group} 已建立`);
      await this.onCreated?.(packet, group);
      this.pendingValue = packet.group || group;
      this.sync();
      if (this.modalMode === "select") {
        this.closeCreateModal();
      }
    }

    bind() {
      if (this.bound) {
        return;
      }
      this.bound = true;
      this.Utils.element("developer-config-group-select")?.addEventListener("change", (event) => this.handleSelectChange(event));
      this.Utils.element("developer-source-group-close")?.addEventListener("click", () => this.closeCreateModal());
      this.Utils.element("developer-source-group-cancel")?.addEventListener("click", () => this.closeCreateModal());
      this.Utils.element("developer-source-group-confirm")?.addEventListener("click", () => {
        this.createFromModal().catch((err) => this.Utils.setMessage(err.message, true));
      });
      this.Utils.element("developer-source-group-input")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.createFromModal().catch((err) => this.Utils.setMessage(err.message, true));
        }
      });
      this.Utils.element("developer-source-group-modal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) {
          this.closeCreateModal();
        }
      });
    }
  }

  window.DeveloperSourceGroupSelector = DeveloperSourceGroupSelector;
})();
