function repaintSampledGridLayer() {
  if ((typeof isSampledGridLayer !== "function" || !isSampledGridLayer(state.dataLayer)) || !state.gridLayer?.setRows) return;
  state.gridLayer.setRows(state.gridLayer._rows || state.rows || []);
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
    const maximum = $("sampled-grid-max-value");
    const stops = $("sampled-grid-color-stops");
    for (const input of [mode, maximum, stops]) {
      if (input) stopStyleControlPropagation(input);
    }
    mode?.addEventListener("change", () => {
      this.profile().mode = mode.value === "nonzero_extent" ? "nonzero_extent" : "contract";
      this.repaintAndSync();
    });
    maximum?.addEventListener("input", () => {
      const value = Number(maximum.value);
      this.profile().maxValue = Number.isFinite(value) ? value : null;
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
  }

  sync(layerId = state.dataLayer, { preserveInput = false } = {}) {
    this.layerId = String(layerId || state.dataLayer || "").trim().toLowerCase();
    const profile = this.profile();
    const mode = $("sampled-grid-scale-mode");
    const maximum = $("sampled-grid-max-value");
    const maximumField = $("sampled-grid-max-value-field");
    if (mode) mode.value = profile.mode;
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

function bindSampledGridPaintControls() {
  sampledGridPaintController.bind();
}

function syncSampledGridPaintControls(layerId) {
  sampledGridPaintController.sync(layerId);
}

function repaintGfwLayer() {
  repaintSampledGridLayer();
}

function bindGfwPaintControls() {
  bindSampledGridPaintControls();
}
