const PLAYBACK_CONTROL_IDS = ["latest-date", "replay", "prev-day", "play-toggle", "next-day"];
const DEFAULT_PLAYBACK_INTERVAL_MS = 1400;
const PLAYBACK_BUFFER_POLL_MS = 180;
const PLAYBACK_BUFFER_TIMEOUT_MS = PlaybackTimePolicy.BUFFER_TIMEOUT_MS;

function syncPlayToggleIcon() {
  if (state.isPlaying) {
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
  const ratio = limitBytes > 0 ? Math.min(1, usedBytes / limitBytes) : 0;
  const percent = Math.round(ratio * 100);
  const capacityText = $("playback-cache-capacity-text");
  const capacityPercent = $("playback-cache-capacity-percent");
  const capacityFill = $("playback-cache-capacity-fill");

  if (capacityText) {
    capacityText.textContent = `快取容量：${PlaybackCacheService.formatBytes(usedBytes)} / ${PlaybackCacheService.formatBytes(limitBytes)}`;
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
  updatePlaybackBufferStatus();
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
  const waitMs = Number(RuntimePerformanceMetrics?.snapshot?.().buffer_wait_ms || 0);
  const waitText = waitMs >= 1000 ? ` · 等待 ${(waitMs / 1000).toFixed(1)}s` : "";
  if (cache.bufferStatus === "failed") {
    return `播放失敗${date}${stateName}：${ready} / ${required}${waitText}${error}`;
  }
  return `緩衝中${date}${stateName}：${ready} / ${required}${waitText}`;
}

function updatePlaybackBufferStatus() {
  const panel = $("playback-buffer-status");
  const text = $("playback-buffer-status-text");
  if (!panel || !text) return;
  const message = playbackBufferText();
  panel.hidden = !message;
  text.textContent = message;
}

function nextPlaybackGeneration() {
  state.playbackCache.generation = Number(state.playbackCache.generation || 0) + 1;
  return state.playbackCache.generation;
}

function isPlaybackGenerationActive(generation) {
  return state.playbackCache.generation === generation;
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

function timelineStepMode(timeline) {
  return timeline?.stepMode === "fluid" ? "fluid" : "sequential";
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

function clearPlaybackTimeline() {
  state.playbackCache.timeline = null;
}

function startPlaybackTimeline(generation, { firstDelayMs = 0 } = {}) {
  const stepMode = playbackStepMode();
  const rate = normalizedPlaybackRate();
  const intervalMs = normalizedPlaybackInterval(stepMode, rate);
  const dates = datesInSelectedRange();
  const currentIndex = currentPlaybackDateIndex(dates);
  state.playbackCache.timeline = PlaybackScheduler.start({
    generation,
    intervalMs,
    rate,
    stepMode,
    baseDateIndex: currentIndex,
    nowMs: ClockDomain.playback.now(),
    firstDelayMs,
  });
  return state.playbackCache.timeline;
}

function playbackTimeline(generation) {
  const timeline = state.playbackCache?.timeline;
  if (timeline && timeline.generation === generation) return timeline;
  return startPlaybackTimeline(generation);
}

function delayUntilNextPlaybackFrame(generation) {
  const timeline = playbackTimeline(generation);
  return PlaybackScheduler.delayUntilNextFrame(timeline, {
    nowMs: ClockDomain.playback.now(),
    fallbackIntervalMs: normalizedPlaybackInterval(),
  });
}

function duePlaybackFrameNumber(generation) {
  const timeline = playbackTimeline(generation);
  return PlaybackScheduler.dueFrameNumber(timeline, {
    nowMs: ClockDomain.playback.now(),
    fallbackIntervalMs: normalizedPlaybackInterval(),
  });
}

function markPlaybackFrameShown(generation, frameNumber = null) {
  const timeline = playbackTimeline(generation);
  PlaybackScheduler.markFrameShown(timeline, {
    frameNumber: frameNumber || duePlaybackFrameNumber(generation),
  });
}

function shiftPlaybackTimeline(generation, deltaMs) {
  const amount = Math.max(0, Number(deltaMs || 0));
  if (amount <= 0) return;
  const timeline = playbackTimeline(generation);
  PlaybackScheduler.shift(timeline, amount);
}

function reschedulePlaybackTimelineAfterSpeedChange(generation) {
  const intervalMs = normalizedPlaybackInterval();
  startPlaybackTimeline(generation, { firstDelayMs: intervalMs });
}

function playbackTargetDateIndex(generation, frameNumber) {
  const dates = datesInSelectedRange();
  if (!dates.length) return -1;
  const timeline = playbackTimeline(generation);
  return PlaybackScheduler.targetDateIndex(timeline, {
    datesLength: dates.length,
    currentIndex: currentPlaybackDateIndex(dates),
    frameNumber,
  });
}

function syncPlaybackSettingsInputs() {
  const options = PlaybackCacheService.options();
  PlaybackDeliveryPolicy.apply(state);
  const interpolation = PlaybackInterpolationController.options(state);
  if ($("play-speed")) $("play-speed").value = String(normalizedPlaybackRate());
  if ($("playback-rate")) $("playback-rate").value = String(normalizedPlaybackRate());
  if ($("playback-interpolation-mode")) $("playback-interpolation-mode").value = interpolation.mode;
  if ($("query-network-concurrency")) $("query-network-concurrency").value = String(state.queryPolicy?.network_concurrency || 6);
  if ($("playback-cache-low-watermark")) $("playback-cache-low-watermark").value = String(options.lowWatermark);
  if ($("playback-cache-high-watermark")) $("playback-cache-high-watermark").value = String(options.highWatermark);
  if ($("playback-cache-window-behind")) $("playback-cache-window-behind").value = String(options.windowBehind);
  if ($("playback-cache-max-gb")) $("playback-cache-max-gb").value = String(Math.round(options.maxGb * 100) / 100);
  if ($("gfw-transition-ms")) $("gfw-transition-ms").value = String(Math.max(0, Number(state.gfwTransitionMs || 0)));
  const blurPx = Math.max(0, Number(state.gfwZoomBlurPx || 0));
  if ($("gfw-zoom-blur-px")) $("gfw-zoom-blur-px").value = String(blurPx);
  if ($("gfw-zoom-blur-value")) $("gfw-zoom-blur-value").textContent = `${blurPx}px`;
  updatePlaybackCacheStatus(PlaybackCacheService.statusText());
}

function releasePlaybackRenderArtifacts(reason) {
  if (!GfwRenderArtifactCache?.webglAvailable?.()) return;
  GfwRenderArtifactCache.clear?.({ reason, requireGpu: true });
}

function bindPlaybackSettingsControls() {
  $("playback-rate")?.addEventListener("change", () => updatePlaybackSpeed("playback-rate"));
  $("playback-interpolation-mode")?.addEventListener("change", (event) => {
    PlaybackInterpolationController.setMode(state, event.target.value);
    syncGfwTransitionStyle();
    syncPlaybackSettingsInputs();
  });
  $("query-network-concurrency")?.addEventListener("change", (event) => {
    state.queryPolicy.network_concurrency = Math.max(1, Math.min(16, Number(event.target.value || 6)));
    LayerQueryCoordinator.drain?.();
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-low-watermark")?.addEventListener("change", (event) => {
    const high = PlaybackCacheService.options().highWatermark;
    state.playbackCache.lowWatermark = Math.max(1, Math.min(high - 1, Number(event.target.value || 1)));
    PlaybackCacheService.reconcilePolicy();
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-high-watermark")?.addEventListener("change", (event) => {
    const high = Math.max(2, Number(event.target.value || 10));
    state.playbackCache.highWatermark = high;
    state.playbackCache.lowWatermark = Math.min(high - 1, Number(state.playbackCache.lowWatermark || 5));
    PlaybackCacheService.reconcilePolicy();
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-max-gb")?.addEventListener("change", (event) => {
    const maxGb = Math.max(0.25, Number(event.target.value || 2));
    state.dataFrameStore.maxBytes = Math.round(maxGb * PlaybackCacheService.BYTES_PER_GB);
    DataFrameStore.enforceBudget?.();
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-clear")?.addEventListener("click", () => {
    PlaybackCacheService.clear();
    DataFrameStore.evictAll?.();
    GfwRenderArtifactCache.clear?.({ reason: "manual_cache_clear" });
    setStatus("播放快取已釋放");
    syncPlaybackSettingsInputs();
  });
  $("gfw-transition-ms")?.addEventListener("change", (event) => {
    state.gfwTransitionMs = Math.max(0, Number(event.target.value || 0));
    syncGfwTransitionStyle();
    syncPlaybackSettingsInputs();
  });
  $("gfw-zoom-blur-px")?.addEventListener("input", (event) => {
    state.gfwZoomBlurPx = Math.max(0, Number(event.target.value || 0));
    syncPlaybackSettingsInputs();
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

function stopPlayback({ cancelPending = true, clearBuffer = true, reason = "stopped" } = {}) {
  const wasActive = Boolean(state.isPlaying || state.playTimer || state.playbackCache?.timeline);
  if (cancelPending) {
    nextPlaybackGeneration();
  }
  state.isPlaying = false;
  if (clearBuffer) {
    PlaybackCacheService.clearBufferState();
  }
  clearPlaybackTimeline();
  ClockDomain.playback.cancel(state.playTimer);
  state.playTimer = null;
  if (wasActive) {
    PlaybackEngine.stop(reason);
  }
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
  return PlaybackFrameBuffer.inspectTarget({
    dates,
    currentIndex,
    targetIndex,
    hasCacheLayer: hasPlaybackCacheLayer(),
    requestContext: playbackRequestContext(),
    cacheService: PlaybackCacheService,
    intervalMs: normalizedPlaybackInterval(),
    rate: normalizedPlaybackRate(),
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

function playbackBufferTimedOut() {
  return PlaybackTimePolicy.bufferTimedOut(
    PlaybackEngine.bufferWaitMs(),
    PLAYBACK_BUFFER_TIMEOUT_MS,
  );
}

function markPlaybackTargetFailed(dates, targetIndex, decision, { attempts = 0, reason = "" } = {}) {
  const packet = decision || playbackFrameDecision(dates, currentPlaybackDateIndex(dates), targetIndex);
  const errorMessage = reason || packet.errorMessage || "frame request failed";
  PlaybackFrameBuffer.markFailed({
    decision: packet,
    dates,
    targetIndex,
    cacheService: PlaybackCacheService,
    attempts,
    errorMessage,
  });
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  setStatus(playbackBufferText() || `播放失敗 ${packet.targetDate || dates[targetIndex] || ""}`, true);
  return { advanced: false, buffering: false, failed: true, done: false };
}

function markPlaybackTargetWaiting(dates, targetIndex, decision, waitState = null) {
  const packet = decision || playbackFrameDecision(dates, currentPlaybackDateIndex(dates), targetIndex);
  const { attempts } = waitState || playbackBufferAttempt(packet);
  PlaybackEngine.requireTarget(targetIndex).catch((error) => {
    if (error?.name !== "AbortError") setStatus(error?.message || "目標影格查詢失敗", true);
  });
  PlaybackFrameBuffer.markWaiting({
    decision: packet,
    dates,
    targetIndex,
    cacheService: PlaybackCacheService,
    attempts,
  });
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  setStatus(playbackBufferText() || "緩衝中");
  return { packet, attempts };
}

async function renderPlaybackDateIndex(dates, targetIndex) {
  const startedAt = ClockDomain.render.now();
  PlaybackEngine.markRenderStarted(targetIndex);
  await PlaybackRenderer.showDateIndex({
    dates,
    targetIndex,
    dateInput: $("date"),
    updateControls: updatePlaybackControls,
    reloadActiveLayer,
  });
  PlaybackEngine.markFrameVisible(targetIndex, { renderMs: ClockDomain.render.now() - startedAt });
}

async function advancePlaybackToTimelineTarget(generation, frameNumber) {
  const timeline = playbackTimeline(generation);
  const dates = datesInSelectedRange();
  const currentIndex = currentPlaybackDateIndex(dates);
  if (currentIndex < 0) {
    return { advanced: false, done: false };
  }
  if (currentIndex >= dates.length - 1) {
    return { advanced: false, done: true };
  }

  const targetIndex = playbackTargetDateIndex(generation, frameNumber);
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
    if (timelineStepMode(timeline) === "fluid") {
      markPlaybackTargetWaiting(dates, targetIndex, decision, waitState);
      return { advanced: true, held: true, done: false };
    }
    if (playbackBufferTimedOut()) {
      return markPlaybackTargetFailed(dates, targetIndex, decision, {
        attempts: waitState.attempts,
        reason: `buffer wait timeout ${Math.round(PLAYBACK_BUFFER_TIMEOUT_MS / 1000)}s`,
      });
    }
    markPlaybackTargetWaiting(dates, targetIndex, decision, waitState);
    return { advanced: false, buffering: true, done: false };
  }

  PlaybackCacheService.clearBufferState();
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  await renderPlaybackDateIndex(dates, renderIndex);
  return { advanced: true, rendered: true, done: renderIndex >= dates.length - 1 };
}

function schedulePlaybackTick(generation = state.playbackCache.generation) {
  ClockDomain.playback.cancel(state.playTimer);
  const delayMs = delayUntilNextPlaybackFrame(generation);
  state.playTimer = ClockDomain.playback.schedule(async () => {
    if (!state.isPlaying || !isPlaybackGenerationActive(generation)) return;
    try {
      const frameNumber = duePlaybackFrameNumber(generation);
      const result = await advancePlaybackToTimelineTarget(generation, frameNumber);
      if (result.buffering) {
        shiftPlaybackTimeline(generation, PLAYBACK_BUFFER_POLL_MS);
        if (state.isPlaying && isPlaybackGenerationActive(generation)) {
          schedulePlaybackTick(generation);
        }
        return;
      }
      if (result.failed) {
        stopPlayback({ clearBuffer: false, reason: "failed" });
        return;
      }
      if (!result.advanced && result.done) {
        stopPlayback({ reason: "ended" });
        return;
      }
      if (!result.advanced) {
        stopPlayback();
        return;
      }
      markPlaybackFrameShown(generation, frameNumber);
      if (state.isPlaying && isPlaybackGenerationActive(generation)) {
        schedulePlaybackTick(generation);
      }
    } catch (err) {
      stopPlayback();
      setStatus(err.message, true);
    }
  }, Math.max(0, Number(delayMs || 0)));
}

async function setPlayback(active) {
  if (!active) {
    stopPlayback();
    return;
  }
  TimingMetrics.markInteraction?.("播放");
  const generation = nextPlaybackGeneration();
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
  PlaybackEngine.configure({
    dates: playbackDates,
    requestContext: playbackRequestContext(),
    currentDate: $("date").value,
  });
  PlaybackEngine.start({
    rate: state.playbackRate,
    interval_ms: normalizedPlaybackInterval(),
    consumption_rate: ClockDomain.playback.consumptionRate({
      baseIntervalMs: basePlaybackInterval(),
      speed: state.playbackRate,
    }),
    step_mode: playbackStepMode(),
    cache_mode: "watermark",
    delivery_policy: PlaybackDeliveryPolicy.telemetryLabel(delivery),
    interpolation_mode: PlaybackInterpolationController.modeLabel(interpolation.mode),
  });
  state.isPlaying = true;
  startPlaybackTimeline(generation);
  if (typeof syncFullscreenPlaybackControls === "function") {
    syncFullscreenPlaybackControls();
  }
  updatePlaybackControls();
  schedulePlaybackTick(generation);
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
  const source = sourceId?.target || $(sourceId) || $("play-speed") || $("playback-rate");
  state.playbackRate = normalizedPlaybackRateValue(source?.value || state.playbackRate);
  if ($("play-speed")) $("play-speed").value = String(state.playbackRate);
  if ($("playback-rate")) $("playback-rate").value = String(state.playbackRate);
  if (typeof syncFullscreenPlaybackControls === "function") {
    syncFullscreenPlaybackControls();
  }
  if (state.isPlaying) {
    reschedulePlaybackTimelineAfterSpeedChange(state.playbackCache.generation);
    schedulePlaybackTick(state.playbackCache.generation);
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
