(function () {
  const {
    element: developerElement,
    setHidden: setElementHidden,
    isHidden: isElementHidden,
    setMessage: setDeveloperMessage,
    sanitizeIdentifier,
    sanitizeFilename,
    commaList,
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
      spark: { driver: "pyhive", port: 10001, connectionRef: "spark_sql", file: "adapter.generated.spark.json" },
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

  function wizardMaxLimitValue() {
    const value = String(wizardValue("wizard-max-limit") || "").trim().toLowerCase();
    if (!value || value === "max" || value === "all" || value === "unbounded" || value === "null") {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function buildWizardConfig() {
    const kind = wizardBackendKind();
    const driver = sanitizeIdentifier(wizardValue("wizard-driver"), wizardDefaultForKind(kind).driver);
    const connectionRef = sanitizeIdentifier(wizardValue("wizard-connection-ref"), wizardDefaultForKind(kind).connectionRef);
    const database = sanitizeIdentifier(wizardValue("wizard-database"), "ocean_fishery");
    const table = sanitizeIdentifier(wizardValue("wizard-table"), "dataset_table");
    const datasetId = sanitizeIdentifier(wizardValue("wizard-dataset-id"), "dataset_main");
    const connection = {
      kind,
      driver,
      host: wizardValue("wizard-host") || "127.0.0.1",
      port: wizardPortValue(),
      user: wizardValue("wizard-user") || "root",
      password: wizardValue("wizard-password"),
      database,
    };
    const displayColumns = commaList(wizardValue("wizard-display-columns"));
    const dataset = {
      label: wizardValue("wizard-dataset-label") || datasetId,
      backend: kind,
      connection_ref: connectionRef,
      duckdb_source_table: table,
      mysql_table: table,
      table,
      time_column: sanitizeIdentifier(wizardValue("wizard-time-column"), "obs_date"),
      lat_column: sanitizeIdentifier(wizardValue("wizard-lat-column"), "lat"),
      lon_column: sanitizeIdentifier(wizardValue("wizard-lon-column"), "lon"),
      id_column: sanitizeIdentifier(wizardValue("wizard-id-column"), "grid_id"),
      display_columns: displayColumns.length ? displayColumns : ["obs_date", "grid_id", "lat", "lon"],
      metric_columns: commaList(wizardValue("wizard-metric-columns")),
      category_columns: commaList(wizardValue("wizard-category-columns")),
    };
    const config = {
      sql_backend: { kind, driver },
      default_connection_ref: connectionRef,
      connections: {
        [connectionRef]: connection,
      },
      query_policy: {
        default_limit: null,
        max_limit: wizardMaxLimitValue(),
        table_preview_limit: 300,
        require_time_or_bbox_filter: true,
      },
      server: {
        default_command: "serve",
        host: "127.0.0.1",
        port: 5057,
        debug: false,
        kill_port_if_busy: true,
      },
      rendering: {
        hardware_acceleration: "auto",
        allow_webgl: true,
        allow_webgpu: false,
        min_webgl_rows: 1,
      },
      default_dataset: datasetId,
      datasets: {
        [datasetId]: dataset,
      },
    };
    if (kind === "mysql") {
      config.mysql = {
        host: connection.host,
        port: connection.port,
        user: connection.user,
        password: connection.password,
        database: connection.database,
      };
    }
    return config;
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
      setElementHidden(next, wizardStep === 4);
    }
    if (importButton) {
      setElementHidden(importButton, wizardStep !== 4);
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
      wizardStep = Math.min(4, wizardStep + 1);
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
