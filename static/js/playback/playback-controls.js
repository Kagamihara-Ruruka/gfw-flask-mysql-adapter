const TIME_CONTROL_LAYER_IDS = new Set(["gfw"]);
const PLAYBACK_CONTROL_IDS = ["latest-date", "replay", "prev-day", "play-toggle", "next-day"];
const DEFAULT_PLAYBACK_INTERVAL_MS = 1400;
const PLAYBACK_BUFFER_RETRY_MS = 180;

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
  const stats = state.gfwRecordCache?.stats || {};
  const usedBytes = Math.max(0, Number(stats.cacheBytes || 0));
  const limitBytes = Math.max(0, Number(stats.cacheLimitBytes || state.gfwRecordCache?.maxBytes || 0));
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

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function playbackRequestContext() {
  const intent = RenderIntentService.snapshot({
    date: $("date")?.value,
    layerId: state.dataLayer,
    renderProfile: "dashboard.playback",
  });
  return RenderIntentService.toGfwPacketRequest(intent);
}

function playbackBufferText() {
  const cache = state.playbackCache || {};
  if (!cache.buffering && cache.bufferStatus !== "prebuffering") return "";
  const ready = Number(cache.bufferReady || 0);
  const required = Number(cache.bufferRequired || 0);
  const date = cache.bufferCurrentDate ? ` ${cache.bufferCurrentDate}` : "";
  return `緩衝中${date}：${ready} / ${required}`;
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
  return state.playbackCache?.stepMode === "fluid" ? "fluid" : "sequential";
}

function normalizedPlaybackInterval(stepMode = playbackStepMode(), rate = normalizedPlaybackRate()) {
  const baseInterval = basePlaybackInterval();
  if (stepMode === "fluid") return baseInterval;
  return Math.max(1, Math.round(baseInterval / Math.max(0.25, Number(rate || 1))));
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
    nowMs: nowMs(),
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
    nowMs: nowMs(),
    fallbackIntervalMs: normalizedPlaybackInterval(),
  });
}

function duePlaybackFrameNumber(generation) {
  const timeline = playbackTimeline(generation);
  return PlaybackScheduler.dueFrameNumber(timeline, {
    nowMs: nowMs(),
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

function shouldQueueProgressivePreheat({ startIndex = null } = {}) {
  const options = PlaybackCacheService.options();
  if (options.mode !== "progressive" || state.playbackCache?.isBackgroundPreloading) {
    return false;
  }
  const dates = datesInSelectedRange();
  const index = startIndex ?? dates.indexOf($("date").value);
  if (index < 0 || index >= dates.length) return false;
  const context = playbackRequestContext();
  const remainingDates = Math.max(1, dates.length - index);
  const policy = PlaybackCacheService.bufferPolicy({
    intervalMs: state.playIntervalMs,
    rate: normalizedPlaybackRate(),
    remainingDates,
  });
  const ready = PlaybackCacheService.countReadyPrefix(dates, index, context);
  return ready <= policy.resume;
}

function queueProgressivePreheat({ startIndex = null } = {}) {
  if (!shouldQueueProgressivePreheat({ startIndex })) return;
  const dates = datesInSelectedRange();
  const anchorDate = startIndex == null ? $("date").value : dates[startIndex];
  preheatPlaybackCache({ blocking: false, anchorDate }).catch((err) => setStatus(err.message, true));
}

function syncPlaybackSettingsInputs() {
  const options = PlaybackCacheService.options();
  if ($("play-speed")) $("play-speed").value = String(normalizedPlaybackRate());
  if ($("playback-rate")) $("playback-rate").value = String(normalizedPlaybackRate());
  if ($("playback-cache-mode")) $("playback-cache-mode").value = options.mode;
  if ($("playback-step-mode")) $("playback-step-mode").value = playbackStepMode();
  if ($("playback-cache-concurrency")) $("playback-cache-concurrency").value = String(options.concurrency);
  if ($("playback-cache-max-dates")) $("playback-cache-max-dates").value = String(options.maxDates);
  if ($("playback-cache-window-behind")) $("playback-cache-window-behind").value = String(options.windowBehind);
  if ($("playback-cache-window-ahead")) $("playback-cache-window-ahead").value = String(options.windowAhead);
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
  $("playback-cache-mode")?.addEventListener("change", (event) => {
    state.playbackCache.mode = event.target.value;
    syncPlaybackSettingsInputs();
  });
  $("playback-step-mode")?.addEventListener("change", (event) => {
    state.playbackCache.stepMode = event.target.value === "fluid" ? "fluid" : "sequential";
    if (state.isPlaying) {
      reschedulePlaybackTimelineAfterSpeedChange(state.playbackCache.generation);
      schedulePlaybackTick(state.playbackCache.generation);
    }
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-concurrency")?.addEventListener("change", (event) => {
    state.playbackCache.concurrency = event.target.value === "auto"
      ? "auto"
      : Math.max(1, Number(event.target.value || 1));
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-max-dates")?.addEventListener("change", (event) => {
    state.playbackCache.maxDates = Math.max(0, Number(event.target.value || 0));
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-window-behind")?.addEventListener("change", (event) => {
    state.playbackCache.windowBehind = Math.max(0, Number(event.target.value || 0));
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-window-ahead")?.addEventListener("change", (event) => {
    state.playbackCache.windowAhead = Math.max(1, Number(event.target.value || 1));
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-max-gb")?.addEventListener("change", (event) => {
    const maxGb = Math.max(0.25, Number(event.target.value || 2));
    state.gfwRecordCache.maxBytes = Math.round(maxGb * PlaybackCacheService.BYTES_PER_GB);
    GfwRecordCache.enforceBudget?.();
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-clear")?.addEventListener("click", () => {
    GfwRecordCache.clear?.();
    GfwRenderArtifactCache.clear?.({ reason: "manual_cache_clear" });
    state.playbackCache.isPreheating = false;
    state.playbackCache.isBackgroundPreloading = false;
    PlaybackCacheService.clearBufferState();
    state.playbackCache.stats = {
      queued: 0,
      completed: 0,
      cacheHits: 0,
      fetched: 0,
      failed: 0,
    };
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
  return selectedLayerIds().some((layerId) => TIME_CONTROL_LAYER_IDS.has(layerId));
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
  const isPreheating = Boolean(state.playbackCache?.isPreheating);
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
  $("prev-day").disabled = isPreheating || !timeSequenceEnabled || index <= 0;
  $("next-day").disabled = isPreheating || !timeSequenceEnabled || index < 0 || index >= dates.length - 1;
  $("replay").disabled = isPreheating || !timeSequenceEnabled;
  $("play-toggle").disabled = isPreheating || (!isBuffering && (!timeSequenceEnabled || dates.length <= 1));
  $("play-speed").disabled = isPreheating || !timeSequenceEnabled || dates.length <= 1;
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

function stopPlayback({ cancelPending = true } = {}) {
  const wasActive = Boolean(state.isPlaying || state.playTimer || state.playbackCache?.timeline);
  if (cancelPending) {
    nextPlaybackGeneration();
  }
  state.isPlaying = false;
  PlaybackCacheService.clearBufferState();
  clearPlaybackTimeline();
  clearTimeout(state.playTimer);
  state.playTimer = null;
  if (wasActive) {
    PlaybackTelemetry.recordStop?.({ date: $("date")?.value });
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

async function preheatPlaybackCache({ blocking = true, anchorDate = $("date").value } = {}) {
  const dates = datesInSelectedRange();
  const intent = RenderIntentService.range({
    dates,
    start: dates[0],
    end: dates[dates.length - 1],
    anchorDate,
    layerId: state.dataLayer,
    renderProfile: "dashboard.playback",
  });
  return PlaybackCacheService.preheat({
    intent,
    blocking,
    onStateChange: () => {
      updatePlaybackControls();
      syncPlaybackSettingsInputs();
    },
  });
}

function readyPlaybackTargetIndex(dates, currentIndex, targetIndex) {
  const options = PlaybackCacheService.options();
  return PlaybackFrameBuffer.readyTargetIndex({
    dates,
    currentIndex,
    targetIndex,
    mode: options.mode,
    hasCacheLayer: hasPlaybackCacheLayer(),
    requestContext: playbackRequestContext(),
    cacheService: PlaybackCacheService,
  });
}

function markPlaybackTargetWaiting(dates, targetIndex) {
  PlaybackTelemetry.recordBuffering?.({ date: dates[targetIndex] });
  PlaybackFrameBuffer.markWaiting({
    dates,
    targetIndex,
    cacheService: PlaybackCacheService,
  });
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  setStatus(playbackBufferText() || "緩衝中");
  queueProgressivePreheat({ startIndex: targetIndex });
}

async function renderPlaybackDateIndex(dates, targetIndex) {
  await PlaybackRenderer.showDateIndex({
    dates,
    targetIndex,
    dateInput: $("date"),
    updateControls: updatePlaybackControls,
    reloadActiveLayer,
    afterRender: () => queueProgressivePreheat({ startIndex: targetIndex }),
  });
  PlaybackTelemetry.recordFrameShown?.({ date: dates[targetIndex] });
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

  const renderIndex = readyPlaybackTargetIndex(dates, currentIndex, targetIndex);
  if (renderIndex < 0) {
    markPlaybackTargetWaiting(dates, targetIndex);
    if (timelineStepMode(timeline) === "fluid") {
      return { advanced: true, held: true, done: false };
    }
    return { advanced: false, buffering: true, done: false };
  }

  if (renderIndex < targetIndex) {
    PlaybackTelemetry.recordFrameFallback?.({
      targetDate: dates[targetIndex],
      renderDate: dates[renderIndex],
    });
    queueProgressivePreheat({ startIndex: targetIndex });
  }
  PlaybackCacheService.clearBufferState();
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  await renderPlaybackDateIndex(dates, renderIndex);
  return { advanced: true, rendered: true, done: renderIndex >= dates.length - 1 };
}

function schedulePlaybackTick(generation = state.playbackCache.generation) {
  clearTimeout(state.playTimer);
  const delayMs = delayUntilNextPlaybackFrame(generation);
  state.playTimer = setTimeout(async () => {
    if (!state.isPlaying || !isPlaybackGenerationActive(generation)) return;
    try {
      const frameNumber = duePlaybackFrameNumber(generation);
      const result = await advancePlaybackToTimelineTarget(generation, frameNumber);
      if (result.buffering) {
        shiftPlaybackTimeline(generation, PLAYBACK_BUFFER_RETRY_MS);
        if (state.isPlaying && isPlaybackGenerationActive(generation)) {
          schedulePlaybackTick(generation);
        }
        return;
      }
      if (!result.advanced && result.done) {
        stopPlayback();
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
  const options = PlaybackCacheService.options();
  if (options.mode === "before_play") {
    await preheatPlaybackCache({ blocking: true });
    if (!isPlaybackGenerationActive(generation)) return;
  } else if (options.mode === "progressive") {
    state.isPlaying = true;
    updatePlaybackControls();
    preheatPlaybackCache({ blocking: false }).catch((err) => setStatus(err.message, true));
  }
  state.isPlaying = true;
  const timeline = startPlaybackTimeline(generation);
  PlaybackTelemetry.recordTimelineStart?.({
    rate: timeline.rate,
    stepMode: timeline.stepMode,
    intervalMs: timeline.intervalMs,
  });
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
