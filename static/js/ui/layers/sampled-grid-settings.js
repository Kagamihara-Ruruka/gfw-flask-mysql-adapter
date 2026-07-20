function repaintSampledGridLayer() {
  if (typeof isSampledGridLayer !== "function" || !isSampledGridLayer(state.dataLayer)) return;
  repaintActiveSampledGridLayer({ layerId: state.dataLayer, datasetId: state.datasetId });
}

class SampledGridResolutionController {
  constructor() {
    this.bound = false;
    this.layerId = null;
    this.datasetId = null;
  }

  layer(layerId = this.layerId) {
    const id = String(layerId || "").trim().toLowerCase();
    return (window.LayerRuntimeContractRegistry?.sampledGridLayers?.() || [])
      .find((item) => item.layerId === id) || null;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    const select = $("sampled-grid-resolution");
    if (select) stopStyleControlPropagation(select);
    select?.addEventListener("change", () => {
      this.apply(Number(select.value)).catch((error) => {
        setStatus(error?.message || "網格解析度切換失敗", true);
        this.sync(this.layerId);
      });
    });
    window.addEventListener("rrkal:sampled-grid-resolution-changed", (event) => {
      if (event.detail?.datasetId === this.datasetId) this.renderStatus();
    });
  }

  async apply(resolutionKm) {
    if (!this.datasetId) return;
    const isActive = this.layerId === state.dataLayer && this.datasetId === state.datasetId;
    if (isActive) {
      stopPlayback({ clearPreheater: true, reason: "resolution_changed" });
      removeSampledGridLayer();
      RenderState.loading(this.layerId, "切換解析度");
    }
    const selected = SampledGridContract.setRequestedResolution(this.datasetId, resolutionKm);
    if (!Number.isFinite(selected)) throw new Error("所選解析度不在 Mapping 合約中");
    this.sync(this.layerId);
    if (isActive) await reloadActiveLayer();
  }

  sync(layerId = state.dataLayer) {
    this.layerId = String(layerId || "").trim().toLowerCase();
    const layer = this.layer(this.layerId);
    this.datasetId = layer?.datasetId || null;
    const select = $("sampled-grid-resolution");
    if (!select) return;
    const available = this.datasetId
      ? SampledGridContract.model(this.datasetId).availableResolutionsKm
      : [];
    select.replaceChildren(...available.map((resolutionKm, index) => {
      const option = document.createElement("option");
      option.value = String(resolutionKm);
      option.textContent = `${formatResolutionKm(resolutionKm)}${index === 0 ? "（最細）" : ""}`;
      return option;
    }));
    const requested = this.datasetId
      ? SampledGridContract.requestResolution({ datasetId: this.datasetId })
      : null;
    if (Number.isFinite(requested)) select.value = String(requested);
    select.disabled = available.length <= 1;
    this.renderStatus();
  }

  renderStatus() {
    const status = $("sampled-grid-resolution-status");
    if (!status) return;
    if (!this.datasetId) {
      status.textContent = "此圖層沒有可用的 sampled-grid 解析度合約。";
      return;
    }
    const resolution = SampledGridContract.resolutionState(this.datasetId);
    const selectionLabel = formatResolutionKm(resolution.selectionResolutionKm);
    const queryLabel = formatResolutionKm(resolution.queryResolutionKm);
    if (!resolution.resolved) {
      status.textContent = `選格 ${selectionLabel}；查詢粒度等待資料回應。`;
      return;
    }
    status.textContent = resolution.degraded
      ? `選格 ${selectionLabel}；來源查詢使用 ${queryLabel}。`
      : `目前選格與查詢均為 ${selectionLabel}。`;
  }
}

class SampledGridPaintController {
  constructor() {
    this.bound = false;
    this.layerId = null;
  }

  profile() {
    return SampledGridColorScale.profile(this.layerId || state.dataLayer);
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    const mode = $("sampled-grid-scale-mode");
    const interpolation = $("sampled-grid-spatial-interpolation");
    const maximum = $("sampled-grid-max-value");
    const stops = $("sampled-grid-color-stops");
    for (const input of [mode, interpolation, maximum, stops]) {
      if (input) stopStyleControlPropagation(input);
    }
    mode?.addEventListener("change", () => {
      this.profile().mode = mode.value === "nonzero_extent" ? "nonzero_extent" : "contract";
      this.repaintAndSync();
    });
    interpolation?.addEventListener("change", () => {
      this.profile().spatialInterpolation = interpolation.value === "nearest" ? "nearest" : "linear";
      this.repaintAndSync();
    });
    maximum?.addEventListener("input", () => {
      const profile = this.profile();
      const value = sampledGridNumberOrNull(maximum.value);
      const minimum = SampledGridContract.model(profile.datasetId).valueDomain.min;
      profile.maxValue = value != null && (!Number.isFinite(minimum) || value > minimum)
        ? value
        : null;
      this.repaintAndSync({ preserveInput: true });
    });
    stops?.addEventListener("input", (event) => {
      const input = event.target.closest("[data-sampled-grid-color-stop]");
      if (!input) return;
      const index = Number(input.dataset.sampledGridColorStop);
      const profile = this.profile();
      if (!Number.isInteger(index) || !profile.colorStops[index]) return;
      profile.colorStops[index].color = input.value;
      this.repaintAndSync();
    });
  }

  repaintAndSync({ preserveInput = false } = {}) {
    repaintSampledGridLayer();
    this.sync(this.layerId, { preserveInput });
    notifyBrowserProfileChanged("sampled_grid_style_changed");
  }

  sync(layerId = state.dataLayer, { preserveInput = false } = {}) {
    this.layerId = String(layerId || state.dataLayer || "").trim().toLowerCase();
    const profile = this.profile();
    const mode = $("sampled-grid-scale-mode");
    const interpolation = $("sampled-grid-spatial-interpolation");
    const interpolationField = $("sampled-grid-spatial-interpolation-field");
    const interpolationStatus = $("sampled-grid-spatial-interpolation-status");
    const maximum = $("sampled-grid-max-value");
    const maximumField = $("sampled-grid-max-value-field");
    if (mode) mode.value = profile.mode;
    const capability = window.LayerRuntimeContractRegistry?.spatialInterpolation?.(this.layerId) || {};
    const interpolationSupported = capability.status === "supported"
      && Array.isArray(capability.methods)
      && capability.methods.includes("linear");
    const rendererSupported = typeof RendererRegistry !== "undefined"
      && Boolean(RendererRegistry.gpuAvailable?.());
    if (interpolationField) interpolationField.hidden = !interpolationSupported;
    if (interpolation) {
      interpolation.value = profile.spatialInterpolation === "nearest" ? "nearest" : "linear";
      interpolation.disabled = interpolationSupported && !rendererSupported;
    }
    if (interpolationStatus) {
      interpolationStatus.textContent = rendererSupported
        ? "只影響地圖著色；選格、圖表與快取仍使用原始 cell。"
        : "目前渲染後端不支援平滑，將保留原始色塊。";
    }
    if (maximum && !preserveInput) {
      const modelDomain = SampledGridContract.model(profile.datasetId).valueDomain;
      maximum.value = profile.maxValue ?? modelDomain.max ?? profile.observedMax ?? "";
    }
    if (maximum) maximum.disabled = profile.mode === "nonzero_extent";
    if (maximumField) maximumField.classList.toggle("is-disabled", profile.mode === "nonzero_extent");
    this.renderStops(profile);
    this.renderDomain(profile);
  }

  renderStops(profile) {
    const root = $("sampled-grid-color-stops");
    const preview = $("sampled-grid-scale-preview");
    if (root) {
      root.replaceChildren(...profile.colorStops.map((stop, index) => {
        const label = document.createElement("label");
        const title = document.createElement("span");
        title.textContent = `${Math.round(stop.position * 100)}%`;
        const input = document.createElement("input");
        input.type = "color";
        input.className = "color-input";
        input.value = stop.color;
        input.dataset.sampledGridColorStop = String(index);
        label.append(title, input);
        return label;
      }));
    }
    if (preview) {
      preview.style.background = `linear-gradient(90deg, ${profile.colorStops
        .map((stop) => `${stop.color} ${Math.round(stop.position * 100)}%`)
        .join(", ")})`;
    }
  }

  renderDomain(profile) {
    const status = $("sampled-grid-domain-status");
    if (!status) return;
    const domain = SampledGridColorScale.domain(profile);
    const label = profile.mode === "nonzero_extent" ? "非零資料" : "合約資料";
    status.textContent = `${label} ${this.format(domain.min)} – ${this.format(domain.max)}`;
  }

  format(value) {
    if (!Number.isFinite(Number(value))) return "-";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
}

const sampledGridPaintController = new SampledGridPaintController();
const sampledGridResolutionController = new SampledGridResolutionController();

function bindSampledGridPaintControls() {
  sampledGridPaintController.bind();
  sampledGridResolutionController.bind();
}

function syncSampledGridPaintControls(layerId) {
  sampledGridPaintController.sync(layerId);
  sampledGridResolutionController.sync(layerId);
}
