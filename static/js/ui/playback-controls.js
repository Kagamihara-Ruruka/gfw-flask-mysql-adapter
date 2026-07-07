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
}

function syncPlaybackSettingsInputs() {
  const options = PlaybackCacheService.options();
  if ($("playback-cache-mode")) $("playback-cache-mode").value = options.mode;
  if ($("playback-cache-concurrency")) $("playback-cache-concurrency").value = String(options.concurrency);
  if ($("playback-cache-max-dates")) $("playback-cache-max-dates").value = String(options.maxDates);
  if ($("playback-cache-max-gb")) $("playback-cache-max-gb").value = String(Math.round(options.maxGb * 100) / 100);
  if ($("gfw-transition-ms")) $("gfw-transition-ms").value = String(Math.max(0, Number(state.gfwTransitionMs || 0)));
  const blurPx = Math.max(0, Number(state.gfwZoomBlurPx || 0));
  if ($("gfw-zoom-blur-px")) $("gfw-zoom-blur-px").value = String(blurPx);
  if ($("gfw-zoom-blur-value")) $("gfw-zoom-blur-value").textContent = `${blurPx}px`;
  updatePlaybackCacheStatus(PlaybackCacheService.statusText());
}

function bindPlaybackSettingsControls() {
  $("playback-cache-mode")?.addEventListener("change", (event) => {
    state.playbackCache.mode = event.target.value;
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-concurrency")?.addEventListener("change", (event) => {
    state.playbackCache.concurrency = Math.max(1, Number(event.target.value || 1));
    syncPlaybackSettingsInputs();
  });
  $("playback-cache-max-dates")?.addEventListener("change", (event) => {
    state.playbackCache.maxDates = Math.max(0, Number(event.target.value || 0));
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
    state.playbackCache.isPreheating = false;
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
  $("play-toggle").disabled = isPreheating || !timeSequenceEnabled || dates.length <= 1;
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

function stopPlayback() {
  state.isPlaying = false;
  clearTimeout(state.playTimer);
  state.playTimer = null;
  updatePlaybackControls();
}

async function stepDay(delta) {
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
  const limit = Number(state.queryPolicy?.max_limit || state.queryPolicy?.default_limit || 100000);
  return PlaybackCacheService.preheat({
    dates: datesInSelectedRange(),
    bbox: currentBbox(),
    datasetId: state.datasetId,
    limit,
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
  return true;
}

function schedulePlaybackTick() {
  clearTimeout(state.playTimer);
  state.playTimer = setTimeout(async () => {
    if (!state.isPlaying) return;
    try {
      const advanced = await advancePlaybackDay();
      if (!advanced) {
        stopPlayback();
        return;
      }
      if (state.isPlaying) {
        schedulePlaybackTick();
      }
    } catch (err) {
      stopPlayback();
      setStatus(err.message, true);
    }
  }, state.playIntervalMs);
}

async function setPlayback(active) {
  if (!active) {
    stopPlayback();
    return;
  }
  if (!(await preparePlaybackStart())) {
    stopPlayback();
    return;
  }
  const options = PlaybackCacheService.options();
  if (options.mode === "before_play") {
    await preheatPlaybackCache({ blocking: true });
  } else if (options.mode === "progressive") {
    preheatPlaybackCache({ blocking: false }).catch((err) => setStatus(err.message, true));
  }
  state.isPlaying = true;
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
  if (typeof syncFullscreenPlaybackControls === "function") {
    syncFullscreenPlaybackControls();
  }
  updatePlaybackControls();
  schedulePlaybackTick();
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
    setPlayback(true);
  }
}

async function replayFromStart() {
  const dates = datesInSelectedRange();
  if (!dates.length) return;
  stopPlayback();
  $("date").value = dates[0];
  updatePlaybackControls();
  await reloadActiveLayer();
}

async function jumpToLatestDate() {
  if (!hasSelectedTimeControlLayer() || !state.availableDates.length) return;
  stopPlayback();
  $("date").value = state.availableDates[state.availableDates.length - 1];
  updatePlaybackControls();
  await reloadActiveLayer();
}
