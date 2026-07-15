class DashboardLayerActivationController {
  constructor({ targetState, viewportController, virtualGridController, effects }) {
    this.state = targetState;
    this.viewportController = viewportController;
    this.virtualGridController = virtualGridController;
    this.effects = effects;
    this.transitionQueue = Promise.resolve();
    this.disposed = false;
  }

  normalizeLayerId(layerId) {
    return String(layerId || "").trim().toLowerCase();
  }

  datasetIdForLayer(layerId) {
    const id = this.normalizeLayerId(layerId);
    const current = this.state.datasets?.[this.state.datasetId];
    if (this.normalizeLayerId(current?.layer_id || this.state.datasetId) === id) {
      return this.state.datasetId;
    }
    const match = Object.entries(this.state.datasets || {}).find(([datasetId, dataset]) => (
      this.normalizeLayerId(dataset?.layer_id || datasetId) === id
    ));
    return match?.[0] || null;
  }

  enqueue(operation) {
    if (this.disposed) return Promise.reject(new Error("LayerActivationController is disposed"));
    const transition = this.transitionQueue.then(operation, operation);
    this.transitionQueue = transition.catch(() => undefined);
    return transition;
  }

  toggle(layerId) {
    return this.enqueue(() => (
      this.normalizeLayerId(this.state.dataLayer) === this.normalizeLayerId(layerId)
        ? this.deactivateNow({ closeMenu: true, reason: "drawer_toggle" })
        : this.activateNow(layerId, { closeMenu: true, focus: true, reason: "drawer_toggle" })
    ));
  }

  activate(layerId, options = {}) {
    return this.enqueue(() => this.activateNow(layerId, options));
  }

  deactivate(options = {}) {
    return this.enqueue(() => this.deactivateNow(options));
  }

  reconcile({ reload = false, reason = "registry_reconcile" } = {}) {
    return this.enqueue(async () => {
      const activeLayerId = this.normalizeLayerId(this.state.dataLayer);
      if (!activeLayerId) {
        return this.deactivateNow({ stopPlayback: false, reason });
      }
      if (!this.effects.isImported(activeLayerId) || !this.effects.isPrimary(activeLayerId)) {
        return this.deactivateNow({ reason: "active_contract_removed" });
      }

      const datasetId = this.datasetIdForLayer(activeLayerId);
      if (this.effects.isSampledGrid(activeLayerId) && !datasetId) {
        return this.deactivateNow({ reason: "active_dataset_removed" });
      }

      const datasetChanged = this.state.datasetId !== datasetId;
      if (datasetChanged || (datasetId && !this.state.schema)) {
        return this.activateNow(activeLayerId, { focus: false, reason });
      }
      this.state.enabledLayerIds = [activeLayerId];
      this.viewportController?.syncForDataset(datasetId, { focus: false });
      this.syncUi(reason);

      if (reload) {
        await this.effects.reloadActiveLayer();
      }
      this.dispatch(reason);
      return activeLayerId;
    });
  }

  async activateNow(layerId, { closeMenu = false, focus = false, reason = "activate" } = {}) {
    const id = this.normalizeLayerId(layerId);
    if (!this.effects.isImported(id) || !this.effects.isPrimary(id)) {
      this.syncUi("activation_rejected");
      return null;
    }

    const datasetId = this.datasetIdForLayer(id);
    if (this.effects.isSampledGrid(id) && !datasetId) {
      throw new Error(`Layer ${id} has no registered dataset contract.`);
    }

    this.effects.stopPlayback();
    this.state.dataLayer = null;
    this.state.enabledLayerIds = [];
    this.effects.clearPrimaryRecords();
    this.state.datasetId = datasetId;
    this.state.schema = null;
    this.effects.setAvailableDates([]);

    // Keep the target dormant until its schema has populated the date controls.
    this.viewportController?.syncForDataset(datasetId, { focus });
    try {
      if (datasetId) {
        await this.effects.loadSchema();
      }
      this.state.dataLayer = id;
      this.state.enabledLayerIds = [id];
      this.syncUi(reason, { closeMenu });
      await this.effects.reloadActiveLayer();
      this.dispatch(reason);
      return id;
    } catch (error) {
      this.state.dataLayer = null;
      this.state.enabledLayerIds = [];
      this.state.datasetId = null;
      this.state.schema = null;
      this.effects.setAvailableDates([]);
      this.viewportController?.syncForDataset(null, { focus: false });
      this.effects.clearPrimaryRecords();
      this.syncUi("activation_failed", { closeMenu });
      this.dispatch("activation_failed");
      throw error;
    }
  }

  async deactivateNow({ closeMenu = false, stopPlayback = true, reason = "deactivate" } = {}) {
    if (stopPlayback) {
      this.effects.stopPlayback();
    }
    this.state.dataLayer = null;
    this.state.enabledLayerIds = [];
    this.state.datasetId = null;
    this.state.schema = null;
    this.effects.setAvailableDates([]);
    this.viewportController?.syncForDataset(null, { focus: false });
    this.effects.clearPrimaryRecords();
    this.syncUi(reason, { closeMenu });
    this.dispatch(reason);
    return null;
  }

  syncUi(reason, { closeMenu = false } = {}) {
    this.effects.renderDatasetSelect();
    this.effects.updateLayerMenu();
    this.virtualGridController?.refresh(reason);
    if (closeMenu) {
      this.effects.closeLayerMenu();
    }
  }

  dispatch(reason) {
    this.effects.dispatch(new CustomEvent("rrkal:layer-activation-changed", {
      detail: {
        reason,
        layerId: this.state.dataLayer,
        datasetId: this.state.datasetId,
        enabledLayerIds: [...this.state.enabledLayerIds],
      },
    }));
  }

  dispose() {
    this.disposed = true;
    this.transitionQueue = Promise.resolve();
  }
}

function createLayerActivationController({ targetState, viewportController, virtualGridController } = {}) {
  return new DashboardLayerActivationController({
    targetState,
    viewportController,
    virtualGridController,
    effects: {
    isImported: (layerId) => isImportedLayer(layerId),
    isPrimary: (layerId) => isPrimaryDataLayer(layerId),
    isSampledGrid: (layerId) => isSampledGridLayer(layerId),
    stopPlayback: () => stopPlayback(),
    clearPrimaryRecords: () => clearPrimaryLayerRecords(),
    loadSchema: () => loadSchema(),
    reloadActiveLayer: () => reloadActiveLayer(),
    setAvailableDates: (dates) => setAvailableDates(dates),
    renderDatasetSelect: () => renderDatasetSelect(),
    updateLayerMenu: () => updateDataLayerMenu(),
    closeLayerMenu: () => {
      const menu = $("data-layer-menu");
      if (menu) menu.open = false;
    },
    dispatch: (event) => window.dispatchEvent(event),
    },
  });
}

window.DashboardLayerActivationController = DashboardLayerActivationController;
window.createLayerActivationController = createLayerActivationController;
window.AppRuntime.install("LayerActivationController", () => createLayerActivationController({
  targetState: state,
  viewportController: window.LayerViewportController,
  virtualGridController: window.VirtualGridController,
}));
