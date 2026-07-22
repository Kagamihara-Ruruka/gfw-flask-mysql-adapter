const PLAYBACK_CONTROL_IDS = ["latest-date", "replay", "prev-day", "play-toggle", "next-day"];
const DEFAULT_PLAYBACK_INTERVAL_MS = 1400;
const PLAYBACK_BUFFER_POLL_MS = 180;
let playbackCacheUiFrame = null;

function schedulePlaybackCacheUiSync() {
  if (playbackCacheUiFrame !== null) return;
  playbackCacheUiFrame = ClockDomain.render.request(() => {
    playbackCacheUiFrame = null;
    syncPlaybackCacheCapacityMeter();
    syncPlaybackPolicyStatus();
    syncPlaybackRuntimeGateState();
  });
}

function playbackIsActive() {
  return PlaybackRuntime.isActive();
}

function syncPlayToggleIcon() {
  if (playbackIsActive()) {
    ControlButtons.setIcon("play-toggle", "pause", "II", "暫停");
    if (typeof syncFullscreenPlayToggleIcon === "function") {
      syncFullscreenPlayToggleIcon();
    }
    return;
  }
  ControlButtons.setIcon("play-toggle", "play", ">", "播放");
  if (typeof syncFullscreenPlayToggleIcon === "function") {
    syncFullscreenPlayToggleIcon();
  }
}

function bindPlaybackControlFeedback() {
  ControlButtons.bindFeedback(PLAYBACK_CONTROL_IDS);
}

function syncPlaybackCacheCapacityMeter() {
  const snapshot = DataFrameStore.snapshot();
  const usedBytes = Math.max(0, Number(snapshot.bytes || 0));
  const limitBytes = Math.max(0, Number(snapshot.maxBytes || state.dataFrameStore?.maxBytes || 0));
  const configuredLimitBytes = Math.max(0, Number(snapshot.configuredMaxBytes || limitBytes));
  const ratio = limitBytes > 0 ? Math.min(1, usedBytes / limitBytes) : 0;
  const percent = Math.round(ratio * 100);
  const capacityText = $("playback-cache-capacity-text");
  const capacityPercent = $("playback-cache-capacity-percent");
  const capacityFill = $("playback-cache-capacity-fill");

  if (capacityText) {
    const configuredSuffix = snapshot.heapSafetyApplied
      ? `（設定 ${PlaybackCacheService.formatBytes(configuredLimitBytes)}）`
      : "";
    const shortfallSuffix = snapshot.playbackCacheCapacitySufficient
      ? ""
      : ` · 月份水位尚缺 ${PlaybackCacheService.formatBytes(snapshot.playbackCacheShortfallBytes)}`;
    capacityText.textContent = `快取容量：${PlaybackCacheService.formatBytes(usedBytes)} / ${PlaybackCacheService.formatBytes(limitBytes)}${configuredSuffix}${shortfallSuffix}`;
  }
  if (capacityPercent) {
    capacityPercent.textContent = `${percent}%`;
  }
  if (capacityFill) {
    capacityFill.style.width = `${percent}%`;
  }
}

function updatePlaybackCacheStatus(text) {
  syncPlaybackCacheCapacityMeter();
  syncPlaybackPolicyStatus();
  updatePlaybackBufferStatus();
}

function syncPlaybackPolicyStatus() {
  const status = $("playback-cache-policy-status");
  if (status) status.textContent = PlaybackCacheService.policyStatusText();
}

function playbackRequestContext() {
  const intent = RenderIntentService.snapshot({
    date: $("date")?.value,
    layerId: state.dataLayer,
    renderProfile: "dashboard.playback",
  });
  return RenderIntentService.toSampledGridPacketRequest(intent);
}

function playbackBufferText() {
  const cache = state.playbackCache || {};
  if (!cache.buffering && cache.bufferStatus !== "prebuffering" && cache.bufferStatus !== "failed") return "";
  const ready = Number(cache.bufferReady || 0);
  const required = Number(cache.bufferRequired || 0);
  const stateName = cache.bufferStateName ? ` · ${cache.bufferStateName}` : "";
  const date = cache.bufferCurrentDate ? ` ${cache.bufferCurrentDate}` : "";
  const error = cache.bufferErrorMessage ? ` · ${cache.bufferErrorMessage}` : "";
  const runtime = RuntimePerformanceMetrics?.snapshot?.() || {};
  const waitMs = Number(cache.bufferStatus === "prebuffering"
    ? runtime.preparation_wait_ms
    : runtime.buffer_wait_ms) || 0;
  const waitText = waitMs >= 1000
    ? ` · 等待 ${formatDisplayNumber(waitMs / 1000, { maximumFractionDigits: 1 })} s`
    : "";
  if (cache.bufferStatus === "prebuffering") {
    return `播放準備中${date}${stateName}：${ready} / ${required}${waitText}${error}`;
  }
  if (cache.bufferStatus === "failed") {
    return `播放失敗${date}${stateName}：${ready} / ${required}${waitText}${error}`;
  }
  return `緩衝中${date}${stateName}：${ready} / ${required}${waitText}${error}`;
}

function playbackDegradationText(reason) {
  return {
    startup_capacity_capped: "供給低於消耗，啟動水位已達容量上限",
    supply_below_consumption: "供給低於目前播放消耗",
    insufficient_metrics: "正在建立吞吐基準",
  }[String(reason || "")] || "";
}

function syncPlaybackRuntimeGateState() {
  const engine = PlaybackRuntime.lifecycleSnapshot();
  if (engine.status === "PREPARING") {
    PlaybackCacheService.setBufferState({
      buffering: false,
      status: "prebuffering",
      ready: engine.preparationReady,
      required: engine.preparationRequired,
      currentDate: datesInSelectedRange()[engine.currentIndex + 1] || engine.currentDate,
      targetIndex: engine.currentIndex + 1,
      stateName: "PREPARING",
      errorMessage: playbackDegradationText(engine.preparationDegradationReason),
    });
  } else if (engine.status === "BUFFERING") {
    const gate = engine.bufferGate || {};
    PlaybackCacheService.setBufferState({
      buffering: true,
      status: "waiting",
      ready: gate.readyCount,
      required: gate.required,
      currentDate: state.playbackCache?.bufferCurrentDate || "",
      targetIndex: gate.targetIndex ?? state.playbackCache?.bufferTargetIndex ?? -1,
      attempts: state.playbackCache?.bufferAttempts || 0,
      stateName: "BUFFERING",
      errorMessage: playbackDegradationText(gate.degradationReason),
    });
  } else if (["prebuffering", "waiting"].includes(state.playbackCache?.bufferStatus)) {
    PlaybackCacheService.clearBufferState();
  }
  updatePlaybackBufferStatus();
}

function updatePlaybackBufferStatus() {
  const panel = $("playback-buffer-status");
  const text = $("playback-buffer-status-text");
  if (!panel || !text) return;
  const message = playbackBufferText();
  panel.hidden = !message;
  text.textContent = message;
}

function playbackStepMode() {
  if (typeof PlaybackDeliveryPolicy !== "undefined") {
    return PlaybackDeliveryPolicy.stepMode(state);
  }
  return state.playbackCache?.stepMode === "fluid" ? "fluid" : "sequential";
}

function normalizedPlaybackInterval(stepMode = playbackStepMode(), rate = normalizedPlaybackRate()) {
  return ClockDomain.playback.cadenceMs({
    baseIntervalMs: basePlaybackInterval(),
    speed: rate,
    stepMode,
  });
}

function basePlaybackInterval() {
  return Math.max(1, Number(state.playIntervalMs || DEFAULT_PLAYBACK_INTERVAL_MS));
}

function normalizedPlaybackRateValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  if (numeric > 16) {
    return Math.max(0.25, DEFAULT_PLAYBACK_INTERVAL_MS / numeric);
  }
  return Math.max(0.25, numeric);
}

function normalizedPlaybackRate() {
  const selected = $("play-speed")?.value;
  return normalizedPlaybackRateValue(state.playbackRate ?? selected ?? 1);
}

function currentPlaybackDateIndex(dates = datesInSelectedRange()) {
  return dates.indexOf($("date")?.value);
}

function syncPlaybackSettingsInputs() {
  const options = PlaybackCacheService.options();
  const queryPolicy = QueryPolicyController.snapshot();
  const requestedQueryPolicy = queryPolicy.requested;
  const effectiveQueryPolicy = queryPolicy.effective;
  PlaybackDeliveryPolicy.apply(state);
  const interpolation = PlaybackInterpolationController.options(state);
  if ($("play-speed")) $("play-speed").value = String(normalizedPlaybackRate());
  if ($("playback-interpolation-mode")) $("playback-interpolation-mode").value = interpolation.mode;
  if ($("playback-cache-strategy")) $("playback-cache-strategy").value = options.strategy;
  if ($("query-network-concurrency")) {
    $("query-network-concurrency").value = String(requestedQueryPolicy.networkConcurrency);
  }
  if ($("query-background-concurrency")) {
    $("query-background-concurrency").value = String(requestedQueryPolicy.backgroundConcurrency);
  }
  if ($("query-batch-max-operations")) {
    $("query-batch-max-operations").value = String(requestedQueryPolicy.batchMaxOperations);
  }
  if ($("query-policy-effective-status")) {
    const transportPolicies = Object.values(queryPolicy.transports);
    const effectiveBatchSizes = [...new Set(
      transportPolicies.map((policy) => policy.effectiveBatchSize),
    )].sort((left, right) => left - right);
    const batchLabel = effectiveBatchSizes.length === 0
      ? "等待來源容量"
      : effectiveBatchSizes.length === 1
        ? `${effectiveBatchSizes[0]} 張`
        : `${effectiveBatchSizes[0]}–${effectiveBatchSizes.at(-1)} 張`;
    $("query-policy-effective-status").textContent = [
      `實際前端並行 ${effectiveQueryPolicy.networkConcurrency}`,
      `背景 ${effectiveQueryPolicy.backgroundConcurrency}`,
      `保留前景 ${effectiveQueryPolicy.foregroundReservedSlots}`,
      `來源批次 ${batchLabel}`,
      `Server 上限 ${queryPolicy.serverLimits.networkConcurrency}`,
    ].join(" · ");
  }
  const configuredHigh = Math.max(4, Number(state.playbackCache.highWatermark || 15));
  const configuredLow = Math.max(1, Math.min(
    configuredHigh - 1,
    Number(state.playbackCache.lowWatermark || 10),
  ));
  if ($("playback-cache-low-watermark")) {
    $("playback-cache-low-watermark").disabled = ["adaptive", "calendar_month"].includes(options.strategy);
    $("playback-cache-low-watermark").min = "1";
    $("playback-cache-low-watermark").max = String(configuredHigh - 1);
    $("playback-cache-low-watermark").value = String(configuredLow);
  }
  if ($("playback-cache-high-watermark")) {
    $("playback-cache-high-watermark").disabled = ["adaptive", "calendar_month"].includes(options.strategy);
    $("playback-cache-high-watermark").min = String(configuredLow + 1);
    $("playback-cache-high-watermark").value = String(configuredHigh);
  }
  if ($("playback-cache-window-behind")) $("playback-cache-window-behind").value = String(options.windowBehind);
  if ($("playback-cache-max-gb")) {
    const requiredGb = Number(options.requiredCacheBytes || 0) / PlaybackCacheService.BYTES_PER_GB;
    $("playback-cache-max-gb").min = String(Math.max(0.25, Math.ceil(requiredGb * 100) / 100));
    $("playback-cache-max-gb").value = String(Math.round(options.maxGb * 100) / 100);
  }
  if ($("sampled-grid-transition-ms")) {
    $("sampled-grid-transition-ms").value = String(Math.max(0, Number(state.sampledGridTransitionMs || 0)));
  }
  const blurPx = Math.max(0, Number(state.sampledGridZoomBlurPx || 0));
  if ($("sampled-grid-zoom-blur-px")) $("sampled-grid-zoom-blur-px").value = String(blurPx);
  if ($("sampled-grid-zoom-blur-value")) $("sampled-grid-zoom-blur-value").textContent = `${formatDisplayNumber(blurPx, { maximumFractionDigits: 1 })} px`;
  updatePlaybackCacheStatus(PlaybackCacheService.statusText());
}

function releasePlaybackRenderArtifacts(reason) {
  if (!SampledGridRenderArtifactCache?.webglAvailable?.()) return;
  SampledGridRenderArtifactCache.clear?.({ reason, requireGpu: true });
}

function bindPlaybackSettingsControls() {
  $("playback-cache-strategy")?.addEventListener("change", (event) => {
    state.playbackCache.watermarkStrategy = event.target.value === "fixed" ? "fixed" : "adaptive";
    PlaybackCacheService.resetPolicy("strategy_changed");
    syncPlaybackSettingsInputs();
  });
  $("playback-interpolation-mode")?.addEventListener("change", (event) => {
    PlaybackInterpolationController.setMode(state, event.target.value);
    syncSampledGridTransitionStyle();
    syncPlaybackSettingsInputs();
  });
  $("query-network-concurrency")?.addEventListener("change", (event) => {
    QueryPolicyController.setNetworkConcurrency(event.target.value);
    syncPlaybackSettingsInputs();
  });
  $("query-background-concurrency")?.addEventListener("change", (event) => {
    QueryPolicyController.setBackgroundConcurrency(event.target.value);
    syncPlaybackSettingsInputs();
  });
  $("query-batch-max-operations")?.addEventListener("change", (event) => {
    QueryPolicyController.setBatchMaxOperations(event.target.value);
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-low-watermark")?.addEventListener("change", (event) => {
    const high = Math.max(4, Number(state.playbackCache.highWatermark || 15));
    state.playbackCache.lowWatermark = Math.max(
      1,
      Math.min(high - 1, Number(event.target.value || 10)),
    );
    PlaybackCacheService.resetPolicy("low_watermark_changed");
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-high-watermark")?.addEventListener("change", (event) => {
    const high = Math.max(4, Number(event.target.value || 15));
    state.playbackCache.highWatermark = high;
    state.playbackCache.lowWatermark = Math.max(
      1,
      Math.min(high - 1, Number(state.playbackCache.lowWatermark || 10)),
    );
    PlaybackCacheService.resetPolicy("high_watermark_changed");
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-max-gb")?.addEventListener("change", (event) => {
    const requiredGb = Number(PlaybackCacheService.options().requiredCacheBytes || 0)
      / PlaybackCacheService.BYTES_PER_GB;
    const maxGb = Math.max(0.25, requiredGb, Number(event.target.value || 2));
    state.dataFrameStore.maxBytes = Math.round(maxGb * PlaybackCacheService.BYTES_PER_GB);
    DataFrameStore.enforceBudget?.();
    PlaybackCacheService.resetPolicy("ram_budget_changed");
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-clear")?.addEventListener("click", () => {
    stopPlayback({ clearPreheater: true, reason: "manual_cache_clear" });
    DataFrameStore.evictAll?.();
    SampledGridRenderArtifactCache.clear?.({ reason: "manual_cache_clear" });
    PlaybackCacheService.resetPolicy("cache_cleared");
    setStatus("播放快取已釋放");
    syncPlaybackSettingsInputs();
  });
  $("sampled-grid-transition-ms")?.addEventListener("change", (event) => {
    state.sampledGridTransitionMs = Math.max(0, Number(event.target.value || 0));
    syncSampledGridTransitionStyle();
    syncPlaybackSettingsInputs();
  });
  $("sampled-grid-zoom-blur-px")?.addEventListener("input", (event) => {
    state.sampledGridZoomBlurPx = Math.max(0, Number(event.target.value || 0));
    syncPlaybackSettingsInputs();
  });
  window.addEventListener("rrkal:data-frame-store-changed", () => {
    schedulePlaybackCacheUiSync();
  });
  window.addEventListener("rrkal:lifecycle-event", (event) => {
    if (["WATERMARK_POLICY_CHANGED", "WATERMARK_POLICY_RESET"].includes(event.detail?.type)) {
      syncPlaybackPolicyStatus();
    }
    if ([
      "PREPARE_STARTED",
      "PREPARE_PROGRESS",
      "PREPARE_READY",
      "PREPARE_FAILED",
      "BUFFER_ENTERED",
      "BUFFER_RESUMED",
    ].includes(event.detail?.type)) {
      syncPlaybackRuntimeGateState();
    }
  });
  syncPlaybackSettingsInputs();
}

function selectedLayerIds() {
  const ids = [];
  if (state.dataLayer) {
    ids.push(state.dataLayer);
  }
  if ($("eez-toggle")?.checked) {
    ids.push("eez");
  }
  return ids;
}

function hasSelectedTimeControlLayer() {
  return selectedLayerIds().some((layerId) => (
    typeof isSampledGridLayer === "function" && isSampledGridLayer(layerId)
  ));
}

function hasPlaybackCacheLayer() {
  return PlaybackCacheService.isEnabledForCurrentLayer();
}

function setAvailableDates(dates) {
  state.availableDates = [...dates].sort();
  const first = state.availableDates[0] || "";
  const last = state.availableDates[state.availableDates.length - 1] || "";
  for (const id of ["start-date", "end-date", "date"]) {
    $(id).min = first;
    $(id).max = last;
    $(id).disabled = state.availableDates.length === 0;
  }
  $("start-date").value = first;
  $("end-date").value = last;
  $("date").value = first;
  updatePlaybackControls();
}

function datesInSelectedRange() {
  if (!state.availableDates.length) return [];
  let start = $("start-date").value || state.availableDates[0];
  let end = $("end-date").value || state.availableDates[state.availableDates.length - 1];
  if (start > end) {
    [start, end] = [end, start];
  }
  return state.availableDates.filter((date) => date >= start && date <= end);
}

function clampDateToSelectedRange(value) {
  const dates = datesInSelectedRange();
  if (!dates.length) return "";
  if (!value || value <= dates[0]) return dates[0];
  if (value >= dates[dates.length - 1]) return dates[dates.length - 1];
  if (dates.includes(value)) return value;
  return dates.find((date) => date >= value) || dates[dates.length - 1];
}

function updatePlaybackControls() {
  const dates = datesInSelectedRange();
  const hasTimeControlLayer = hasSelectedTimeControlLayer();
  const singleDateEnabled = hasTimeControlLayer && state.availableDates.length > 0;
  const timeSequenceEnabled = hasTimeControlLayer && dates.length > 0;
  const playbackCacheEnabled = timeSequenceEnabled && hasPlaybackCacheLayer();
  const isBuffering = Boolean(state.playbackCache?.buffering);
  const current = $("date").value;
  const index = dates.indexOf(current);
  const singleDateControl = $("single-date-control");
  const timeSequence = document.querySelector(".time-sequence");
  $("single-date-label").textContent = hasTimeControlLayer
    ? "資料日期"
    : state.dataLayer === "ais"
      ? "AIS 即時"
      : "未選擇時間資料";
  $("date").disabled = !singleDateEnabled;
  $("latest-date").disabled = !singleDateEnabled;
  if (singleDateControl) {
    singleDateControl.classList.toggle("is-disabled", !singleDateEnabled);
    singleDateControl.setAttribute("aria-disabled", String(!singleDateEnabled));
  }
  $("start-date").disabled = !timeSequenceEnabled;
  $("end-date").disabled = !timeSequenceEnabled;
  $("prev-day").disabled = !timeSequenceEnabled || index <= 0;
  $("next-day").disabled = !timeSequenceEnabled || index < 0 || index >= dates.length - 1;
  $("replay").disabled = !timeSequenceEnabled;
  $("play-toggle").disabled = !isBuffering && (!timeSequenceEnabled || dates.length <= 1);
  $("play-speed").disabled = !timeSequenceEnabled || dates.length <= 1;
  if (timeSequence) {
    timeSequence.classList.toggle("is-disabled", !timeSequenceEnabled);
    timeSequence.setAttribute("aria-disabled", String(!timeSequenceEnabled));
  }
  syncPlayToggleIcon();
  if (typeof syncFullscreenPlaybackControls === "function") {
    syncFullscreenPlaybackControls();
  }
  if (typeof syncFullscreenPlaybackHud === "function") {
    syncFullscreenPlaybackHud();
  }
}

function stopPlayback({ clearBuffer = true, clearPreheater = true, reason = "stopped" } = {}) {
  if (clearBuffer) {
    PlaybackCacheService.clearBufferState();
  }
  PlaybackRuntime.stop({ clearPreheater, reason });
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
}

async function stepDay(delta, interactionLabel = "") {
  if (interactionLabel) {
    TimingMetrics.markInteraction?.(interactionLabel);
  }
  const dates = datesInSelectedRange();
  const index = dates.indexOf($("date").value);
  if (index < 0) {
    const next = clampDateToSelectedRange($("date").value);
    if (!next) return false;
    return PlaybackRenderer.showDate({
      date: next,
      dateInput: $("date"),
      updateControls: updatePlaybackControls,
      reloadActiveLayer,
    });
  }
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= dates.length) {
    return false;
  }
  return PlaybackRenderer.showDateIndex({
    dates,
    targetIndex: nextIndex,
    dateInput: $("date"),
    updateControls: updatePlaybackControls,
    reloadActiveLayer,
  });
}

async function preparePlaybackStart() {
  const dates = datesInSelectedRange();
  if (dates.length <= 1) return false;
  const current = $("date").value;
  const index = dates.indexOf(current);
  if (index < 0 || index >= dates.length - 1) {
    await PlaybackRenderer.showDateIndex({
      dates,
      targetIndex: 0,
      dateInput: $("date"),
      updateControls: updatePlaybackControls,
      reloadActiveLayer,
    });
  }
  return true;
}

function playbackFrameDecision(dates, currentIndex, targetIndex) {
  return PlaybackRuntime.frameDecision({
    targetIndex,
    hasCacheLayer: hasPlaybackCacheLayer(),
  });
}

function playbackBufferAttempt(packet) {
  const sameTarget = state.playbackCache?.buffering
    && state.playbackCache?.bufferCurrentDate === packet.targetDate;
  return {
    sameTarget,
    attempts: sameTarget ? Number(state.playbackCache.bufferAttempts || 0) + 1 : 1,
  };
}

function markPlaybackTargetFailed(dates, targetIndex, decision, { attempts = 0, reason = "" } = {}) {
  const packet = decision || playbackFrameDecision(dates, currentPlaybackDateIndex(dates), targetIndex);
  const errorMessage = reason || packet.errorMessage || "frame request failed";
  PlaybackCacheService.setBufferState(PlaybackFrameBuffer.failedState({
    decision: packet,
    dates,
    targetIndex,
    attempts,
    errorMessage,
  }));
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  setStatus(playbackBufferText() || `播放失敗 ${packet.targetDate || dates[targetIndex] || ""}`, true);
  return { advanced: false, buffering: false, failed: true, done: false };
}

function markPlaybackTargetWaiting(dates, targetIndex, decision, waitState = null) {
  let packet = decision || playbackFrameDecision(dates, currentPlaybackDateIndex(dates), targetIndex);
  const { attempts } = waitState || playbackBufferAttempt(packet);
  PlaybackRuntime.requireTarget(targetIndex).catch((error) => {
    if (error?.name !== "AbortError") setStatus(error?.message || "目標影格查詢失敗", true);
  });
  const gate = PlaybackRuntime.bufferGate();
  if (gate.active) {
    packet = {
      ...packet,
      readyCount: gate.readyCount,
      requiredCount: gate.required,
    };
  }
  PlaybackCacheService.setBufferState(PlaybackFrameBuffer.waitingState({
    decision: packet,
    dates,
    targetIndex,
    attempts,
  }));
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  setStatus(playbackBufferText() || "緩衝中");
  return { packet, attempts };
}

async function renderPlaybackDateIndex(dates, targetIndex) {
  const startedAt = ClockDomain.render.now();
  PlaybackRuntime.markRenderStarted(targetIndex);
  const renderResult = await PlaybackRenderer.showDateIndex({
    dates,
    targetIndex,
    dateInput: $("date"),
    updateControls: updatePlaybackControls,
    reloadActiveLayer,
  });
  if (renderResult?.visible === false) return false;
  PlaybackRuntime.markFrameVisible(targetIndex, { renderMs: ClockDomain.render.now() - startedAt });
  return true;
}

async function advancePlaybackToTimelineTarget(targetIndex, { stepMode = "sequential" } = {}) {
  const dates = datesInSelectedRange();
  const currentIndex = currentPlaybackDateIndex(dates);
  if (currentIndex < 0) {
    return { advanced: false, done: false };
  }
  if (currentIndex >= dates.length - 1) {
    return { advanced: false, done: true };
  }

  if (targetIndex <= currentIndex) {
    return { advanced: true, held: true, done: false };
  }

  const decision = playbackFrameDecision(dates, currentIndex, targetIndex);
  const waitState = playbackBufferAttempt(decision);
  if (decision.state === PlaybackFrameBuffer.FRAME_STATES.failed) {
    return markPlaybackTargetFailed(dates, targetIndex, decision, {
      attempts: waitState.attempts,
      reason: decision.errorMessage,
    });
  }
  const renderIndex = decision.renderIndex;
  if (renderIndex < 0) {
    if (stepMode === "fluid") {
      markPlaybackTargetWaiting(dates, targetIndex, decision, waitState);
      return { advanced: true, held: true, done: false };
    }
    markPlaybackTargetWaiting(dates, targetIndex, decision, waitState);
    return { advanced: false, buffering: true, done: false };
  }

  PlaybackCacheService.clearBufferState();
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  const rendered = await renderPlaybackDateIndex(dates, renderIndex);
  if (!rendered) return { advanced: false, buffering: true, done: false };
  return { advanced: true, rendered: true, done: renderIndex >= dates.length - 1 };
}

async function setPlayback(active) {
  if (!active) {
    stopPlayback();
    return;
  }
  TimingMetrics.markInteraction?.("播放");
  TimingMetrics.resetSnapshotHistory?.("playback_start");
  releasePlaybackRenderArtifacts("playback_start");
  if (!(await preparePlaybackStart())) {
    stopPlayback();
    return;
  }
  state.playbackRate = normalizedPlaybackRate();
  const playbackDates = datesInSelectedRange();
  const delivery = PlaybackDeliveryPolicy.options(state);
  const interpolation = PlaybackInterpolationController.options(state);
  const stepMode = playbackStepMode();
  const intervalMs = normalizedPlaybackInterval(stepMode, state.playbackRate);
  const startPromise = PlaybackRuntime.start({
    configure: {
      dates: playbackDates,
      requestContext: playbackRequestContext(),
      currentDate: $("date").value,
    },
    engineOptions: {
      rate: state.playbackRate,
      interval_ms: intervalMs,
      consumption_rate: ClockDomain.playback.consumptionRate({
        baseIntervalMs: basePlaybackInterval(),
        speed: state.playbackRate,
      }),
      step_mode: stepMode,
      cache_mode: "watermark",
      delivery_policy: PlaybackDeliveryPolicy.telemetryLabel(delivery),
      interpolation_mode: PlaybackInterpolationController.modeLabel(interpolation.mode),
    },
    rate: state.playbackRate,
    intervalMs,
    stepMode,
    currentIndexProvider: () => currentPlaybackDateIndex(),
    datesLengthProvider: () => datesInSelectedRange().length,
    bufferPollMs: PLAYBACK_BUFFER_POLL_MS,
    onFrameDue: ({ targetIndex, stepMode: activeStepMode }) => (
      advancePlaybackToTimelineTarget(targetIndex, { stepMode: activeStepMode })
    ),
    onTerminal: ({ reason }) => {
      if (reason !== "failed") PlaybackCacheService.clearBufferState();
      updatePlaybackControls();
      syncPlaybackSettingsInputs();
    },
    onError: (error) => {
      updatePlaybackControls();
      syncPlaybackSettingsInputs();
      setStatus(error?.message || "播放失敗", true);
    },
  });
  syncPlaybackRuntimeGateState();
  updatePlaybackControls();
  let started = false;
  try {
    started = await startPromise;
  } catch (error) {
    stopPlayback({ reason: "prepare_failed" });
    throw error;
  }
  if (!started || !playbackIsActive()) {
    return;
  }
  PlaybackCacheService.clearBufferState();
  if (typeof syncFullscreenPlaybackControls === "function") {
    syncFullscreenPlaybackControls();
  }
  updatePlaybackControls();
}

async function normalizeDateInputs({ reload = true } = {}) {
  const dates = datesInSelectedRange();
  if (!dates.length) {
    stopPlayback();
    return;
  }
  const next = clampDateToSelectedRange($("date").value);
  if (next !== $("date").value) {
    $("date").value = next;
  }
  updatePlaybackControls();
  if (reload) {
    await PlaybackRenderer.showDate({
      date: $("date").value,
      dateInput: $("date"),
      updateControls: updatePlaybackControls,
      reloadActiveLayer,
    });
  }
}

function updatePlaybackSpeed(sourceId = "play-speed") {
  const source = sourceId?.target || $(sourceId) || $("play-speed");
  state.playbackRate = normalizedPlaybackRateValue(source?.value || state.playbackRate);
  if ($("play-speed")) $("play-speed").value = String(state.playbackRate);
  if (typeof syncFullscreenPlaybackControls === "function") {
    syncFullscreenPlaybackControls();
  }
  if (playbackIsActive()) {
    PlaybackRuntime.updateRate({
      rate: state.playbackRate,
      intervalMs: normalizedPlaybackInterval(),
      stepMode: playbackStepMode(),
      consumptionRate: ClockDomain.playback.consumptionRate({
        baseIntervalMs: basePlaybackInterval(),
        speed: state.playbackRate,
      }),
    });
    syncPlaybackRuntimeGateState();
  }
  syncPlaybackSettingsInputs();
}

async function replayFromStart() {
  const dates = datesInSelectedRange();
  if (!dates.length) return;
  stopPlayback();
  TimingMetrics.resetSnapshotHistory?.("replay_from_start");
  TimingMetrics.markInteraction?.("回到開始日期");
  releasePlaybackRenderArtifacts("replay_from_start");
  await PlaybackRenderer.showDateIndex({
    dates,
    targetIndex: 0,
    dateInput: $("date"),
    updateControls: updatePlaybackControls,
    reloadActiveLayer,
  });
}

async function jumpToLatestDate() {
  if (!hasSelectedTimeControlLayer() || !state.availableDates.length) return;
  stopPlayback();
  TimingMetrics.markInteraction?.("最後一日");
  await PlaybackRenderer.showDate({
    date: state.availableDates[state.availableDates.length - 1],
    dateInput: $("date"),
    updateControls: updatePlaybackControls,
    reloadActiveLayer,
  });
}
