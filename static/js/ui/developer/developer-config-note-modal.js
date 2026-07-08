(function () {
  class DeveloperConfigNoteModal {
    constructor({ Utils, Api, onSaved }) {
      this.Utils = Utils;
      this.Api = Api;
      this.onSaved = onSaved;
      this.target = null;
      this.bound = false;
    }

    open(config) {
      if (!config || config.example) {
        return;
      }
      this.target = { type: "config", path: config.path };
      const modal = this.Utils.element("developer-config-note-modal");
      const textarea = this.Utils.element("developer-config-note-modal-text");
      const meta = this.Utils.element("developer-config-note-modal-meta");
      const title = this.Utils.element("developer-config-note-modal-title");
      if (title) {
        title.textContent = "Config 註記";
      }
      if (meta) {
        meta.textContent = `${config.name} / ${config.path}`;
      }
      if (textarea) {
        textarea.value = config.note || "";
      }
      this.Utils.setHidden(modal, false);
      textarea?.focus();
    }

    close() {
      this.Utils.setHidden(this.Utils.element("developer-config-note-modal"), true);
      this.target = null;
    }

    async save() {
      const textarea = this.Utils.element("developer-config-note-modal-text");
      if (!this.target || !textarea) {
        return;
      }
      const targetPath = this.target.path;
      const packet = await this.Api.saveNote(targetPath, textarea.value);
      this.Utils.setMessage("註記已更新");
      this.close();
      await this.onSaved?.(packet, targetPath);
    }

    bind() {
      if (this.bound) {
        return;
      }
      this.bound = true;
      this.Utils.element("developer-config-note-close")?.addEventListener("click", () => this.close());
      this.Utils.element("developer-config-note-cancel")?.addEventListener("click", () => this.close());
      this.Utils.element("developer-config-note-save")?.addEventListener("click", () => {
        this.save().catch((err) => this.Utils.setMessage(err.message, true));
      });
      this.Utils.element("developer-config-note-modal")?.addEventListener("click", (event) => {
        if (event.target === event.currentTarget) {
          this.close();
        }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !this.Utils.isHidden(this.Utils.element("developer-config-note-modal"))) {
          this.close();
        }
      });
    }
  }

  window.DeveloperConfigNoteModal = DeveloperConfigNoteModal;
})();
