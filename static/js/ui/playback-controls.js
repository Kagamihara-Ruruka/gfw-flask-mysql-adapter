const TIME_CONTROL_LAYER_IDS = new Set(["gfw"]);
const PLAYBACK_CACHE_LAYER_IDS = new Set(["gfw"]);
const PLAYBACK_CONTROL_IDS = ["latest-date", "replay", "prev-day", "play-toggle", "playback-settings-toggle", "next-day"];
const BYTES_PER_GB = 1024 * 1024 * 1024;

function syncPlayToggleIcon() {
  if (state.isPlaying) {
    ControlButtons.setIcon("play-toggle", "pause", "II", "暫停");
    return;
  }
  ControlButtons.setIcon("play-toggle", "play", ">", "播放");
}

function bindPlaybackControlFeedback() {
  ControlButtons.bindFeedback(PLAYBACK_CONTROL_IDS);
}

function setPlaybackSettingsModal(open) {
  const modal = $("playback-settings-modal");
  if (!modal) return;
  modal.hidden = !open;
  $("playback-settings-toggle")?.setAttribute("aria-expanded", String(open));
}

function playbackCacheOptions() {
  return {
    mode: state.playbackCache?.mode || "before_play",
    concurrency: Math.max(1, Number(state.playbackCache?.concurrency || 1)),
    maxDates: Math.max(0, Number(state.playbackCache?.maxDates || 0)),
    maxGb: Math.max(0.25, Number(state.gfwRecordCache?.maxBytes || 2 * BYTES_PER_GB) / BYTES_PER_GB),
  };
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= BYTES_PER_GB) return `${(value / BYTES_PER_GB).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value.toFixed(0)} B`;
}

function updatePlaybackCacheStatus(text) {
  const status = $("playback-cache-status");
  if (status) {
    status.textContent = text;
  }
  const progress = $("playback-cache-progress");
  const stats = state.playbackCache?.stats || {};
  const total = Math.max(0, Number(stats.queued || 0));
  const completed = Math.min(total, Number(stats.completed || 0));
  if (progress) {
    progress.max = total || 1;
    progress.value = completed;
  }
}

function syncPlaybackSettingsInputs() {
  const options = playbackCacheOptions();
  if ($("playback-cache-mode")) $("playback-cache-mode").value = options.mode;
  if ($("playback-cache-concurrency")) $("playback-cache-concurrency").value = String(options.concurrency);
  if ($("playback-cache-max-dates")) $("playback-cache-max-dates").value = String(options.maxDates);
  if ($("playback-cache-max-gb")) $("playback-cache-max-gb").value = String(Math.round(options.maxGb * 100) / 100);
  if ($("gfw-transition-ms")) $("gfw-transition-ms").value = String(Math.max(0, Number(state.gfwTransitionMs || 0)));
  if ($("gfw-zoom-blur-px")) $("gfw-zoom-blur-px").value = String(Math.max(0, Number(state.gfwZoomBlurPx || 0)));
  const stats = state.playbackCache?.stats || {};
  const cacheStats = state.gfwRecordCache?.stats || {};
  const cacheText = `記憶體 ${formatBytes(cacheStats.cacheBytes)} / ${formatBytes(cacheStats.cacheLimitBytes || state.gfwRecordCache?.maxBytes)}`;
  const total = Number(stats.queued || 0);
  if (state.playbackCache?.isPreheating) {
    updatePlaybackCacheStatus(`預熱中 ${Number(stats.completed || 0)} / ${total}，${cacheText}`);
  } else if (total > 0) {
    updatePlaybackCacheStatus(`就緒：${Number(stats.completed || 0)} / ${total}，快取命中 ${Number(stats.cacheHits || 0)}，已抓取 ${Number(stats.fetched || 0)}，${cacheText}`);
  } else {
    updatePlaybackCacheStatus(`閒置，${cacheText}`);
  }
}

function bindPlaybackSettingsControls() {
  const toggle = $("playback-settings-toggle");
  const close = $("playback-settings-close");
  const modal = $("playback-settings-modal");
  toggle?.addEventListener("click", () => {
    syncPlaybackSettingsInputs();
    setPlaybackSettingsModal(modal?.hidden ?? true);
  });
  close?.addEventListener("click", () => setPlaybackSettingsModal(false));
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) {
      setPlaybackSettingsModal(false);
    }
  });
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
    state.gfwRecordCache.maxBytes = Math.round(maxGb * BYTES_PER_GB);
    GfwRecordCache.enforceBudget?.();
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
  return PLAYBACK_CACHE_LAYER_IDS.has(state.dataLayer);
}

function playbackCacheLayerLabel() {
  return String(state.dataLayer || "layer").toUpperCase();
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

function datesForPlaybackPreheat() {
  const dates = datesInSelectedRange();
  const { maxDates } = playbackCacheOptions();
  if (maxDates > 0 && dates.length > maxDates) {
    return dates.slice(0, maxDates);
  }
  return dates;
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
  if ($("playback-settings-toggle")) {
    $("playback-settings-toggle").disabled = !playbackCacheEnabled || dates.length <= 1;
  }
  if (timeSequence) {
    timeSequence.classList.toggle("is-disabled", !timeSequenceEnabled);
    timeSequence.setAttribute("aria-disabled", String(!timeSequenceEnabled));
  }
  syncPlayToggleIcon();
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
  const options = playbackCacheOptions();
  if (options.mode === "off" || !hasPlaybackCacheLayer()) {
    return true;
  }
  const dates = datesForPlaybackPreheat();
  if (dates.length <= 1) {
    return true;
  }
  const limit = Number(state.queryPolicy?.max_limit || state.queryPolicy?.default_limit || 100000);
  const bbox = currentBbox();
  const requests = dates.map((date) => ({
    datasetId: state.datasetId,
    date,
    bbox,
    limit,
  }));
  state.playbackCache.isPreheating = true;
  state.playbackCache.stats = {
    queued: requests.length,
    completed: 0,
    cacheHits: 0,
    fetched: 0,
    failed: 0,
  };
  updatePlaybackControls();
  syncPlaybackSettingsInputs();
  const layerLabel = playbackCacheLayerLabel();
  setStatus(`正在預熱 ${layerLabel} 播放快取 0 / ${requests.length}`);
  const run = GfwRecordCache.prefetchRequests(requests, {
    concurrency: options.concurrency,
    onProgress: (event) => {
      const stats = state.playbackCache.stats;
      stats.completed = Math.min(stats.queued, Number(stats.completed || 0) + 1);
      if (event.ok && event.cacheHit) stats.cacheHits = Number(stats.cacheHits || 0) + 1;
      if (event.ok && !event.cacheHit) stats.fetched = Number(stats.fetched || 0) + 1;
      if (!event.ok) stats.failed = Number(stats.failed || 0) + 1;
      syncPlaybackSettingsInputs();
      setStatus(`正在預熱 ${layerLabel} 播放快取 ${stats.completed} / ${stats.queued}`);
    },
  }).finally(() => {
    state.playbackCache.isPreheating = false;
    updatePlaybackControls();
    syncPlaybackSettingsInputs();
    const stats = state.playbackCache.stats;
    setStatus(`${layerLabel} 播放快取就緒 ${stats.completed} / ${stats.queued}`);
  });
  if (options.mode === "progressive" || !blocking) {
    run.catch((err) => setStatus(err.message, true));
    return true;
  }
  await run;
  return true;
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
  const options = playbackCacheOptions();
  if (options.mode === "before_play") {
    await preheatPlaybackCache({ blocking: true });
  } else if (options.mode === "progressive") {
    preheatPlaybackCache({ blocking: false }).catch((err) => setStatus(err.message, true));
  }
  state.isPlaying = true;
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
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

function updatePlaybackSpeed() {
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
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
