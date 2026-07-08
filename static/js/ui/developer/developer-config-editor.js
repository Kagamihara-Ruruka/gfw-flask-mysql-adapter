(function () {
  class DeveloperConfigEditor {
    constructor({ Utils, sourceGroupSelector }) {
      this.Utils = Utils;
      this.sourceGroupSelector = sourceGroupSelector;
      this.selectedPath = null;
      this.selectedConfig = null;
      this.originalContent = "";
      this.isEditing = false;
    }

    path() {
      return this.selectedPath;
    }

    config() {
      return this.selectedConfig;
    }

    isSelected(configPath) {
      return Boolean(configPath) && this.selectedPath === configPath;
    }

    canEdit() {
      return Boolean(this.selectedConfig?.edit_allowed) && !this.selectedConfig?.example;
    }

    selectPath(configPath) {
      this.selectedPath = configPath || null;
      this.isEditing = false;
      this.syncControls();
    }

    clear() {
      this.selectedPath = null;
      this.selectedConfig = null;
      this.originalContent = "";
      const editor = this.Utils.element("developer-config-editor");
      if (editor) {
        editor.value = "";
      }
      this.sourceGroupSelector.setValue("");
      this.Utils.setParseBadge("待命", "is-idle");
      this.syncControls();
    }

    applyPacket(packet) {
      this.selectedPath = packet.path || null;
      this.selectedConfig = packet.summary || null;
      this.originalContent = packet.content || "";
      this.isEditing = false;

      const editor = this.Utils.element("developer-config-editor");
      const meta = this.Utils.element("developer-config-editor-meta");
      if (editor) {
        editor.value = this.originalContent;
      }
      if (meta) {
        meta.textContent = `${packet.path} / ${this.Utils.formatBytes(packet.summary?.size_bytes || 0)}`;
      }
      this.sourceGroupSelector.setValue(this.selectedConfig?.source_group || "");
      this.Utils.setParseBadge(packet.parse_ok ? "JSON 正常" : "JSON 錯誤", packet.parse_ok ? "is-ok" : "is-error");
      this.syncControls();
      return this.selectedConfig;
    }

    beginEdit() {
      if (!this.canEdit()) {
        return;
      }
      this.isEditing = true;
      this.syncControls();
      this.Utils.element("developer-config-editor")?.focus();
    }

    cancel() {
      const editor = this.Utils.element("developer-config-editor");
      if (editor) {
        editor.value = this.originalContent;
      }
      this.sourceGroupSelector.setValue(this.selectedConfig?.source_group || "");
      this.isEditing = false;
      this.syncControls();
    }

    content() {
      return this.Utils.element("developer-config-editor")?.value || "";
    }

    requestedGroup() {
      return this.sourceGroupSelector.value() || this.selectedConfig?.source_group || "";
    }

    applyMove(packet) {
      const nextPath = packet.config?.path || packet.moved || this.selectedPath;
      this.selectedPath = nextPath;
      this.selectedConfig = packet.config || this.selectedConfig;
      this.sourceGroupSelector.setValue(this.selectedConfig?.source_group || "");
      this.syncControls();
      return nextPath;
    }

    refreshSelectedConfig(config) {
      this.selectedConfig = config || this.selectedConfig;
      this.syncControls();
    }

    syncControls() {
      const editor = this.Utils.element("developer-config-editor");
      const saveButton = this.Utils.element("developer-config-save");
      const cancelButton = this.Utils.element("developer-config-cancel");
      const groupSelect = this.Utils.element("developer-config-group-select");
      const hasConfig = Boolean(this.selectedPath);
      const canEdit = this.canEdit();

      if (editor) {
        editor.readOnly = !this.isEditing || !canEdit;
      }
      if (saveButton) {
        this.Utils.setHidden(saveButton, !this.isEditing);
        saveButton.disabled = !hasConfig || !canEdit;
      }
      if (cancelButton) {
        this.Utils.setHidden(cancelButton, !this.isEditing);
      }
      if (groupSelect) {
        const isSourceConfig = Boolean(this.selectedConfig?.source_group);
        this.Utils.setHidden(groupSelect, !this.isEditing || !hasConfig || !isSourceConfig);
        groupSelect.disabled = !this.isEditing || !hasConfig || !isSourceConfig || !canEdit;
      }
    }
  }

  window.DeveloperConfigEditor = DeveloperConfigEditor;
})();
