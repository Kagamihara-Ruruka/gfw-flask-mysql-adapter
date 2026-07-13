(function () {
  const {
    element: developerElement,
    setHidden: setElementHidden,
    isHidden: isElementHidden,
    setMessage: setDeveloperMessage,
    sanitizeIdentifier,
    sanitizeFilename,
  } = window.DeveloperUtils;

  let wizardStep = 1;

  function wizardValue(id) {
    return developerElement(id)?.value ?? "";
  }

  function wizardBackendKind() {
    const selected = wizardValue("wizard-backend-kind");
    if (selected === "custom") {
      return sanitizeIdentifier(wizardValue("wizard-custom-kind"), "custom_backend");
    }
    return selected || "mysql";
  }

  function wizardDefaultForKind(kind) {
    const defaults = {
      mysql: { driver: "pymysql", port: 3306, connectionRef: "local_mysql", file: "adapter.generated.mysql.json" },
      hive: { driver: "pyhive", port: 10000, connectionRef: "class_hive", file: "adapter.generated.hive.json" },
      spark: { driver: "pyhive", port: 10001, connectionRef: "spark_iceberg", file: "adapter.generated.spark-iceberg.json" },
      postgresql: { driver: "psycopg", port: 5432, connectionRef: "postgis_main", file: "adapter.generated.postgresql.json" },
      mongodb: { driver: "pymongo", port: 27017, connectionRef: "mongo_main", file: "adapter.generated.mongodb.json" },
      duckdb: { driver: "duckdb", port: 0, connectionRef: "duckdb_local", file: "adapter.generated.duckdb.json" },
    };
    return defaults[kind] || { driver: "custom", port: 0, connectionRef: `${kind}_main`, file: `adapter.generated.${kind}.json` };
  }

  function wizardSetValue(id, value) {
    const element = developerElement(id);
    if (element) {
      element.value = value;
    }
  }

  function syncWizardDefaults() {
    const defaults = wizardDefaultForKind(wizardBackendKind());
    wizardSetValue("wizard-driver", defaults.driver);
    wizardSetValue("wizard-port", defaults.port);
    wizardSetValue("wizard-connection-ref", defaults.connectionRef);
    wizardSetValue("wizard-config-name", defaults.file);
    updateWizardPreview();
  }

  function wizardPortValue() {
    const port = Number.parseInt(wizardValue("wizard-port"), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return 1;
    }
    return port;
  }

  function buildWizardConfig() {
    const kind = wizardBackendKind();
    const driver = sanitizeIdentifier(wizardValue("wizard-driver"), wizardDefaultForKind(kind).driver);
    const connectionRef = sanitizeIdentifier(wizardValue("wizard-connection-ref"), wizardDefaultForKind(kind).connectionRef);
    const database = sanitizeIdentifier(wizardValue("wizard-database"), "common_adapter");
    const connection = {
      kind,
      driver,
      host: wizardValue("wizard-host") || "127.0.0.1",
      port: wizardPortValue(),
      user: wizardValue("wizard-user") || "root",
      password: wizardValue("wizard-password"),
      database,
    };
    return {
      schema: "rrkal.adapter.database.v1",
      role: "database",
      sql_backend: { kind, driver },
      default_connection_ref: connectionRef,
      connections: {
        [connectionRef]: connection,
      },
    };
  }

  function updateWizardPreview() {
    const preview = developerElement("wizard-preview");
    if (preview) {
      preview.value = `${JSON.stringify(buildWizardConfig(), null, 2)}\n`;
    }
  }

  function renderWizardStep() {
    for (const stage of document.querySelectorAll("[data-wizard-step]")) {
      setElementHidden(stage, Number(stage.dataset.wizardStep) !== wizardStep);
    }
    for (const indicator of document.querySelectorAll("[data-wizard-indicator]")) {
      indicator.classList.toggle("is-active", Number(indicator.dataset.wizardIndicator) === wizardStep);
    }
    const prev = developerElement("wizard-prev");
    const next = developerElement("wizard-next");
    const importButton = developerElement("wizard-import");
    if (prev) {
      prev.disabled = wizardStep === 1;
    }
    if (next) {
      setElementHidden(next, wizardStep === 3);
    }
    if (importButton) {
      setElementHidden(importButton, wizardStep !== 3);
    }
    updateWizardPreview();
  }

  function openConfigWizard() {
    const modal = developerElement("developer-config-wizard");
    if (!modal) {
      return;
    }
    wizardStep = 1;
    setElementHidden(modal, false);
    renderWizardStep();
    developerElement("wizard-backend-kind")?.focus();
  }

  function closeConfigWizard() {
    const modal = developerElement("developer-config-wizard");
    setElementHidden(modal, true);
  }

  async function importWizardConfig() {
    const content = `${JSON.stringify(buildWizardConfig(), null, 2)}\n`;
    const filename = sanitizeFilename(wizardValue("wizard-config-name"), "adapter.generated.json");
    const file = new File([new Blob([content], { type: "application/json" })], filename, { type: "application/json" });
    const packet = await importDeveloperConfig(file);
    const note = wizardValue("wizard-note").trim();
    if (note && packet?.config?.path) {
      const response = await fetch("/api/developer/configs/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: packet.config.path, note }),
      });
      const notePacket = await response.json();
      if (!response.ok) {
        throw new Error(notePacket.error || "註記寫入失敗");
      }
    }
    if (packet?.config?.path) {
      await loadDeveloperConfig(packet.config.path);
    }
    closeConfigWizard();
    setDeveloperMessage(`精靈已生成並匯入 ${packet?.config?.name || filename}`);
  }

  function bindConfigWizardControls() {
    developerElement("developer-config-wizard-toggle")?.addEventListener("click", openConfigWizard);
    developerElement("developer-config-wizard-close")?.addEventListener("click", closeConfigWizard);
    developerElement("wizard-prev")?.addEventListener("click", () => {
      wizardStep = Math.max(1, wizardStep - 1);
      renderWizardStep();
    });
    developerElement("wizard-next")?.addEventListener("click", () => {
      wizardStep = Math.min(3, wizardStep + 1);
      renderWizardStep();
    });
    developerElement("wizard-import")?.addEventListener("click", () => {
      importWizardConfig().catch((err) => setDeveloperMessage(err.message, true));
    });
    developerElement("wizard-backend-kind")?.addEventListener("change", syncWizardDefaults);
    developerElement("developer-config-wizard")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closeConfigWizard();
      }
    });
    for (const input of document.querySelectorAll("#developer-config-wizard input, #developer-config-wizard select, #developer-config-wizard textarea")) {
      input.addEventListener("input", updateWizardPreview);
      input.addEventListener("change", updateWizardPreview);
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !isElementHidden(developerElement("developer-config-wizard"))) {
        closeConfigWizard();
      }
    });
    updateWizardPreview();
  }


  window.bindConfigWizardControls = bindConfigWizardControls;
})();
