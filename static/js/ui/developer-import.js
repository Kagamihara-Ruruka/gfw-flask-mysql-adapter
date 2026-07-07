(function () {
  const {
    element: developerElement,
    setHidden: setElementHidden,
    formatBytes,
  } = window.DeveloperUtils;

  let pendingImportFile = null;

  function setDeveloperMessage(message, isError = false) {
    window.DeveloperUtils.setMessage(message, isError);
  }

  function updateImportModalFileName() {
    const target = developerElement("developer-config-import-file-name");
    if (!target) {
      return;
    }
    target.textContent = pendingImportFile ? `${pendingImportFile.name} / ${formatBytes(pendingImportFile.size)}` : "尚未選擇檔案。";
  }

  function openConfigImportModal(file = null) {
    pendingImportFile = file;
    const modal = developerElement("developer-config-import-modal");
    const fileInput = developerElement("developer-config-import-modal-file");
    const fileField = developerElement("developer-config-import-file-field");
    if (fileInput) {
      fileInput.value = "";
      fileInput.disabled = Boolean(file);
    }
    if (fileField) {
      setElementHidden(fileField, Boolean(file));
    }
    updateImportModalFileName();
    setElementHidden(modal, false);
  }

  function closeConfigImportModal() {
    const modal = developerElement("developer-config-import-modal");
    const fileInput = developerElement("developer-config-import-modal-file");
    const fileField = developerElement("developer-config-import-file-field");
    setElementHidden(modal, true);
    if (fileInput) {
      fileInput.value = "";
      fileInput.disabled = false;
    }
    if (fileField) {
      setElementHidden(fileField, false);
    }
    pendingImportFile = null;
    updateImportModalFileName();
  }

  async function confirmConfigImportModal() {
    const group = developerElement("developer-config-import-modal-group")?.value || "database";
    if (!pendingImportFile) {
      throw new Error("請先選擇要匯入的 JSON 檔案。");
    }
    await importDeveloperConfig(pendingImportFile, group);
    closeConfigImportModal();
  }

  function bindDropzone() {
    const dropzone = developerElement("developer-config-dropzone");
    if (!dropzone) {
      return;
    }
    for (const eventName of ["dragenter", "dragover"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-dragging");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("is-dragging");
      });
    }
    dropzone.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) {
        openConfigImportModal(file);
      }
    });
  }

  function bindConfigImportModalControls() {
    developerElement("developer-config-import-open")?.addEventListener("click", () => openConfigImportModal());
    developerElement("developer-config-import-close")?.addEventListener("click", closeConfigImportModal);
    developerElement("developer-config-import-cancel")?.addEventListener("click", closeConfigImportModal);
    developerElement("developer-config-import-modal-file")?.addEventListener("change", (event) => {
      pendingImportFile = event.currentTarget.files?.[0] || null;
      updateImportModalFileName();
    });
    developerElement("developer-config-import-confirm")?.addEventListener("click", () => {
      confirmConfigImportModal().catch((err) => setDeveloperMessage(err.message, true));
    });
    developerElement("developer-config-import-modal")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closeConfigImportModal();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !isElementHidden(developerElement("developer-config-import-modal"))) {
        closeConfigImportModal();
      }
    });
  }


  window.bindConfigImportModalControls = bindConfigImportModalControls;
  window.bindDropzone = bindDropzone;
})();
