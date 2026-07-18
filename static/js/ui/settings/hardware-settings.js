const HARDWARE_MODE_IDS = {
  auto: "hardware-mode-auto",
  webgl: "hardware-mode-webgl",
  off: "hardware-mode-cpu",
};

const HARDWARE_MODE_BASE_LABELS = {
  auto: "自動",
  webgl: "WebGL",
  off: "CPU / Canvas",
};

function webglIsUsable() {
  return Boolean(
    state.renderCapability?.browser?.webgl?.available &&
    window.SampledGridWebglLayer?.isSupported?.()
  );
}

function recommendedHardwareMode() {
  return webglIsUsable() ? "auto" : "off";
}

function currentHardwareMode() {
  const policy = state.renderCapability?.policy || {};
  if (policy.force_cpu || policy.hardware_acceleration === "off") return "off";
  if (policy.hardware_acceleration === "webgl") return "webgl";
  return "auto";
}

function setHardwareChip(kind, ready, detail) {
  const chip = $(`hardware-chip-${kind}`);
  const light = $(`hardware-light-${kind}`);
  const bit = $(`hardware-bit-${kind}`);
  const detailNode = $(`hardware-detail-${kind}`);
  if (!chip || !light || !bit || !detailNode) return;
  chip.classList.toggle("is-ready", ready);
  chip.classList.toggle("is-off", !ready);
  light.className = `render-light ${ready ? "is-ready" : "is-off"}`;
  bit.textContent = ready ? "1" : "0";
  detailNode.textContent = detail;
}

function setHardwarePolicy(mode, { persistPreference = true } = {}) {
  const capability = state.renderCapability || {};
  const policy = capability.policy || {};
  if (mode === "off") {
    policy.hardware_acceleration = "off";
    policy.force_cpu = true;
    policy.allow_webgl = false;
  } else if (mode === "webgl") {
    policy.hardware_acceleration = "webgl";
    policy.force_cpu = false;
    policy.allow_webgl = true;
  } else {
    policy.hardware_acceleration = "auto";
    policy.force_cpu = false;
    policy.allow_webgl = true;
  }
  capability.policy = policy;
  state.renderCapability = capability;
  if (persistPreference) {
    state.browserProfile.hardwareMode = mode;
    notifyBrowserProfileChanged("hardware_mode_changed");
  }
}

function applyBrowserHardwarePreference() {
  const preferred = state.browserProfile?.hardwareMode || "auto";
  const serverPolicy = state.renderCapability?.server?.policy || {};
  const effective = serverPolicy.force_cpu ? "off" : preferred;
  setHardwarePolicy(effective, { persistPreference: false });
}

function syncHardwareModeLabels(recommended) {
  for (const [mode, id] of Object.entries(HARDWARE_MODE_IDS)) {
    const label = $(`${id}-label`);
    if (!label) continue;
    const suffix = mode === recommended ? "（建議選項）" : "";
    label.textContent = `${HARDWARE_MODE_BASE_LABELS[mode]}${suffix}`;
  }
}

function syncHardwareSettingsControls() {
  const capability = state.renderCapability;
  const webgl = capability?.browser?.webgl || {};
  const webgpu = capability?.browser?.webgpu || {};
  const hasWebgl = webglIsUsable();
  const hasWebgl2 = hasWebgl && webgl.context === "webgl2";
  const hasWebgpu = Boolean(webgpu.available);
  const recommended = recommendedHardwareMode();

  setHardwareChip("webgl2", hasWebgl2, hasWebgl2 ? "可用" : "不可用");
  setHardwareChip("webgl", hasWebgl, hasWebgl ? `${webgl.context || "webgl"} 可用` : "不可用");
  setHardwareChip("webgpu", hasWebgpu, hasWebgpu ? "瀏覽器支援" : "未啟用");
  syncHardwareModeLabels(recommended);

  const autoInput = $(HARDWARE_MODE_IDS.auto);
  const webglInput = $(HARDWARE_MODE_IDS.webgl);
  const cpuInput = $(HARDWARE_MODE_IDS.off);
  if (!autoInput || !webglInput || !cpuInput) return;

  autoInput.disabled = !hasWebgl && !hasWebgpu;
  webglInput.disabled = !hasWebgl;
  cpuInput.disabled = false;

  let selected = currentHardwareMode();
  if ((selected === "auto" && autoInput.disabled) || (selected === "webgl" && webglInput.disabled)) {
    selected = "off";
    setHardwarePolicy("off", { persistPreference: false });
  }
  $(HARDWARE_MODE_IDS[selected]).checked = true;

  const detail = $("hardware-acceleration-detail");
  if (detail) {
    if (!capability) {
      detail.textContent = "正在偵測瀏覽器圖形能力。";
    } else if (hasWebgl) {
      const renderer = webgl.renderer || webgl.vendor || "瀏覽器 WebGL";
      detail.textContent = `可使用 ${webgl.context || "WebGL"}；目前建議使用 ${HARDWARE_MODE_BASE_LABELS[recommended]}。偵測到：${renderer}`;
    } else if (hasWebgpu) {
      detail.textContent = "瀏覽器回報 WebGPU 可用，但目前取樣網格渲染器尚未接 WebGPU；建議維持 CPU / Canvas。";
    } else {
      detail.textContent = "未偵測到可用的 WebGL/GPU 渲染能力；硬體加速選項已停用。";
    }
  }
}

function bindHardwareSettingsControls() {
  for (const [mode, id] of Object.entries(HARDWARE_MODE_IDS)) {
    const input = $(id);
    input?.addEventListener("change", () => {
      if (!input.checked || input.disabled) return;
      setHardwarePolicy(mode);
      syncHardwareSettingsControls();
      if (typeof isSampledGridLayer === "function" && isSampledGridLayer(state.dataLayer)) {
        reloadActiveLayer().catch((err) => setStatus(err.message, true));
      }
    });
  }
  syncHardwareSettingsControls();
}
