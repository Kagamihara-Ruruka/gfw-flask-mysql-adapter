const TIME_CONTROL_LAYER_IDS = new Set(["gfw"]);
const PLAYBACK_CONTROL_IDS = ["latest-date", "replay", "prev-day", "play-toggle", "next-day"];

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizedPlaybackInterval() {
  return Math.max(1, Number(state.playIntervalMs || $("play-speed")?.value || 1400));
}

function clearPlaybackTimeline() {
  state.playbackCache.timeline = null;
}

function startPlaybackTimeline(generation, { firstDelayMs = 0 } = {}) {
  const intervalMs = normalizedPlaybackInterval();
  state.playbackCache.timeline = {
    generation,
    intervalMs,
    startedAt: nowMs() + Math.max(0, Number(firstDelayMs || 0)),
    nextFrameNumber: 0,
  };
  return state.playbackCache.timeline;
}

function playbackTimeline(generation) {
  const timeline = state.playbackCache?.timeline;
  if (timeline && timeline.generation === generation) return timeline;
  return startPlaybackTimeline(generation);
}

function delayUntilNextPlaybackFrame(generation) {
  const timeline = playbackTimeline(generation);
  const targetMs = Number(timeline.startedAt || 0)
    + Number(timeline.nextFrameNumber || 0) * Number(timeline.intervalMs || normalizedPlaybackInterval());
  return Math.max(0, targetMs - nowMs());
}

function markPlaybackFrameShown(generation) {
  const timeline = playbackTimeline(generation);
  timeline.nextFrameNumber = Number(timeline.nextFrameNumber || 0) + 1;
}

function shiftPlaybackTimeline(generation, deltaMs) {
  const amount = Math.max(0, Number(deltaMs || 0));
  if (amount <= 0) return;
  const timeline = playbackTimeline(generation);
  timeline.startedAt = Number(timeline.startedAt || nowMs()) + amount;
}

function reschedulePlaybackTimelineAfterSpeedChange(generation) {
  const timeline = playbackTimeline(generation);
  const intervalMs = normalizedPlaybackInterval();
  const nextFrameNumber = Number(timeline.nextFrameNumber || 0);
  state.playbackCache.timeline = {
    generation,
    intervalMs,
    startedAt: nowMs() + intervalMs - nextFrameNumber * intervalMs,
    nextFrameNumber,
  };
}

function updatePlaybackBufferState({ dates, startIndex, generation, status = "buffering" }) {
  if (!isPlaybackGenerationActive(generation)) return false;
  const context = playbackRequestContext();
  const remainingDates = Math.max(1, dates.length - startIndex);
  const policy = PlaybackCacheService.bufferPolicy({
    intervalMs: state.playIntervalMs,
    remainingDates,
  });
  const ready = PlaybackCacheService.countReadyPrefix(dates, startIndex, context);
  const required = status === "resume" ? policy.resume : policy.required;
  PlaybackCacheService.setBufferState({
    buffering: ready < required,
    status,
    ready,
    required,
    resume: policy.resume,
    currentDate: dates[startIndex] || "",
  });
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  return ready >= required;
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
    remainingDates,
  });
  const ready = PlaybackCacheService.countReadyPrefix(dates, index, context);
  return ready <= policy.resume;
}

function queueProgressivePreheat({ startIndex = null } = {}) {
  if (!shouldQueueProgressivePreheat({ startIndex })) return;
  preheatPlaybackCache({ blocking: false }).catch((err) => setStatus(err.message, true));
}

async function waitForPlaybackBuffer({ generation, status = "prebuffering", startIndex = null } = {}) {
  const dates = datesInSelectedRange();
  const index = startIndex ?? dates.indexOf($("date").value);
  if (index < 0 || index >= dates.length) return false;
  while (isPlaybackGenerationActive(generation)) {
    if (updatePlaybackBufferState({ dates, startIndex: index, generation, status })) {
      PlaybackCacheService.clearBufferState();
      updatePlaybackControls();
      syncPlaybackSettingsInputs();
      return true;
    }
    setStatus(playbackBufferText() || "緩衝中");
    queueProgressivePreheat({ startIndex: index });
    await sleep(180);
  }
  return false;
}

function syncPlaybackSettingsInputs() {
  const options = PlaybackCacheService.options();
  if ($("playback-cache-mode")) $("playback-cache-mode").value = options.mode;
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
  $("playback-cache-mode")?.addEventListener("change", (event) => {
    state.playbackCache.mode = event.target.value;
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
  if (cancelPending) {
    nextPlaybackGeneration();
  }
  state.isPlaying = false;
  PlaybackCacheService.clearBufferState();
  clearPlaybackTimeline();
  clearTimeout(state.playTimer);
  state.playTimer = null;
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
    $("date").value = next;
    updatePlaybackControls();
    await reloadActiveLayer();
    return true;
  }
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= dates.length) {
    return false;
  }
  $("date").value = dates[nextIndex];
  updatePlaybackControls();
  await reloadActiveLayer();
  return true;
}

async function preparePlaybackStart() {
  const dates = datesInSelectedRange();
  if (dates.length <= 1) return false;
  const current = $("date").value;
  const index = dates.indexOf(current);
  if (index < 0 || index >= dates.length - 1) {
    $("date").value = dates[0];
    updatePlaybackControls();
    await reloadActiveLayer();
  }
  return true;
}

async function preheatPlaybackCache({ blocking = true } = {}) {
  const dates = datesInSelectedRange();
  const intent = RenderIntentService.range({
    dates,
    start: dates[0],
    end: dates[dates.length - 1],
    anchorDate: $("date").value,
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

async function advancePlaybackDay() {
  const dates = datesInSelectedRange();
  const index = dates.indexOf($("date").value);
  if (index < 0 || index >= dates.length - 1) {
    return false;
  }
  $("date").value = dates[index + 1];
  updatePlaybackControls();
  await reloadActiveLayer();
  queueProgressivePreheat();
  return true;
}

async function ensurePlaybackCanAdvance(generation) {
  const options = PlaybackCacheService.options();
  if (options.mode !== "progressive") return true;
  const dates = datesInSelectedRange();
  const index = dates.indexOf($("date").value);
  if (index < 0 || index >= dates.length - 1) return false;
  return waitForPlaybackBuffer({
    generation,
    status: "resume",
    startIndex: index + 1,
  });
}

function schedulePlaybackTick(generation = state.playbackCache.generation) {
  clearTimeout(state.playTimer);
  const delayMs = delayUntilNextPlaybackFrame(generation);
  state.playTimer = setTimeout(async () => {
    if (!state.isPlaying || !isPlaybackGenerationActive(generation)) return;
    try {
      const bufferStartMs = nowMs();
      if (!(await ensurePlaybackCanAdvance(generation))) {
        if (isPlaybackGenerationActive(generation)) stopPlayback();
        return;
      }
      const bufferElapsedMs = nowMs() - bufferStartMs;
      if (bufferElapsedMs > 50) {
        shiftPlaybackTimeline(generation, bufferElapsedMs);
      }
      const advanced = await advancePlaybackDay();
      if (!advanced) {
        stopPlayback();
        return;
      }
      markPlaybackFrameShown(generation);
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
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
  const options = PlaybackCacheService.options();
  if (options.mode === "before_play") {
    await preheatPlaybackCache({ blocking: true });
    if (!isPlaybackGenerationActive(generation)) return;
  } else if (options.mode === "progressive") {
    state.isPlaying = true;
    updatePlaybackControls();
    preheatPlaybackCache({ blocking: false }).catch((err) => setStatus(err.message, true));
    if (!(await waitForPlaybackBuffer({ generation, status: "prebuffering" }))) {
      if (isPlaybackGenerationActive(generation)) stopPlayback();
      return;
    }
  }
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
    await reloadActiveLayer();
  }
}

function updatePlaybackSpeed(sourceId = "play-speed") {
  const source = $(sourceId) || $("play-speed");
  state.playIntervalMs = Number(source.value || state.playIntervalMs);
  $("play-speed").value = String(state.playIntervalMs);
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
  $("date").value = dates[0];
  updatePlaybackControls();
  await reloadActiveLayer();
}

async function jumpToLatestDate() {
  if (!hasSelectedTimeControlLayer() || !state.availableDates.length) return;
  stopPlayback();
  TimingMetrics.markInteraction?.("最後一日");
  $("date").value = state.availableDates[state.availableDates.length - 1];
  updatePlaybackControls();
  await reloadActiveLayer();
}
