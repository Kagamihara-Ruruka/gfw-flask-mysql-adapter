const PlaybackCacheService = (() => {
  const CACHE_LAYER_IDS = new Set(["gfw"]);
  const BYTES_PER_GB = 1024 * 1024 * 1024;

  function isEnabledForCurrentLayer() {
    return CACHE_LAYER_IDS.has(state.dataLayer);
  }

  function layerLabel() {
    return String(state.dataLayer || "layer").toUpperCase();
  }

  function options() {
    const rawConcurrency = state.playbackCache?.concurrency ?? "auto";
    return {
      mode: state.playbackCache?.mode || "before_play",
      concurrency: rawConcurrency,
      resolvedConcurrency: PlaybackWorkerPolicy.resolve(rawConcurrency, { task: "prefetch" }),
      concurrencyLabel: PlaybackWorkerPolicy.label(rawConcurrency, { task: "prefetch" }),
      maxDates: Math.max(0, Number(state.playbackCache?.maxDates || 0)),
      windowBehind: Math.max(0, Number(state.playbackCache?.windowBehind ?? 1)),
      windowAhead: Math.max(1, Number(state.playbackCache?.windowAhead ?? 8)),
      maxGb: Math.max(
        0.25,
        Number(state.gfwRecordCache?.maxBytes || 2 * BYTES_PER_GB) / BYTES_PER_GB,
      ),
    };
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes || 0));
    if (value >= BYTES_PER_GB) return `${(value / BYTES_PER_GB).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${value.toFixed(0)} B`;
  }

  function statusText() {
    const stats = state.playbackCache?.stats || {};
    const cacheStats = state.gfwRecordCache?.stats || {};
    const cacheLimit = cacheStats.cacheLimitBytes || state.gfwRecordCache?.maxBytes;
    const cacheText = `快取容量：${formatBytes(cacheStats.cacheBytes)} / ${formatBytes(cacheLimit)}`;
    const total = Number(stats.queued || 0);
    if (state.playbackCache?.isPreheating) {
      return `預熱中：${Number(stats.completed || 0)} / ${total}，${cacheText}`;
    }
    if (total > 0) {
      return `已完成：${Number(stats.completed || 0)} / ${total}，快取命中 ${Number(stats.cacheHits || 0)}，重新查詢 ${Number(stats.fetched || 0)}，${cacheText}`;
    }
    return `待命：${cacheText}`;
  }

  function requestForDate(date, { bbox, datasetId, limit } = {}) {
    return {
      datasetId,
      date,
      bbox,
      limit,
    };
  }

  function requestsForDates(dates, context) {
    return selectDates(dates, { anchorDate: context?.anchorDate }).map((date) => requestForDate(date, context));
  }

  function hasDate(date, context) {
    if (!date || !context) return false;
    return Boolean(GfwRecordCache.hasPacket?.(requestForDate(date, context)));
  }

  function countReadyPrefix(dates, startIndex, context) {
    if (!Array.isArray(dates) || startIndex < 0 || startIndex >= dates.length) return 0;
    let ready = 0;
    for (let index = startIndex; index < dates.length; index += 1) {
      if (!hasDate(dates[index], context)) break;
      ready += 1;
    }
    return ready;
  }

  function bufferPolicy({ intervalMs, remainingDates } = {}) {
    const interval = Math.max(1, Number(intervalMs || 1400));
    const speed = Math.max(0.25, 1400 / interval);
    const required = Math.max(2, Math.ceil(speed * 3));
    const resume = Math.max(required, Math.ceil(speed * 4));
    const remaining = Math.max(1, Number(remainingDates || required));
    const cappedRequired = Math.min(remaining, required);
    const cappedResume = Math.min(remaining, resume);
    return {
      speed,
      required: cappedRequired,
      resume: Math.max(cappedRequired, cappedResume),
      lowWatermark: Math.max(1, Math.floor(cappedRequired / 2)),
    };
  }

  function setBufferState({
    buffering = false,
    status = "idle",
    ready = 0,
    required = 0,
    resume = 0,
    currentDate = "",
  } = {}) {
    state.playbackCache.buffering = buffering;
    state.playbackCache.bufferStatus = status;
    state.playbackCache.bufferReady = ready;
    state.playbackCache.bufferRequired = required;
    state.playbackCache.bufferResume = resume;
    state.playbackCache.bufferCurrentDate = currentDate;
  }

  function clearBufferState() {
    setBufferState();
  }

  function selectDates(dates, { anchorDate = null } = {}) {
    const allDates = Array.isArray(dates) ? dates : [];
    const { maxDates, windowAhead, windowBehind } = options();
    if (!allDates.length) return [];
    let selected = allDates;
    if (anchorDate && allDates.includes(anchorDate)) {
      const anchorIndex = allDates.indexOf(anchorDate);
      const start = Math.max(0, anchorIndex - windowBehind);
      const end = Math.min(allDates.length, anchorIndex + windowAhead + 1);
      selected = allDates.slice(start, end);
    }
    if (maxDates > 0 && selected.length > maxDates) {
      return selected.slice(0, maxDates);
    }
    return selected;
  }

  function resetStats(queued) {
    state.playbackCache.stats = {
      queued,
      completed: 0,
      cacheHits: 0,
      fetched: 0,
      failed: 0,
    };
  }

  function clear() {
    state.playbackCache.isPreheating = false;
    state.playbackCache.isBackgroundPreloading = false;
    clearBufferState();
    resetStats(0);
  }

  function updateStats(event) {
    const stats = state.playbackCache.stats;
    stats.completed = Math.min(stats.queued, Number(stats.completed || 0) + 1);
    if (event.ok && event.cacheHit) stats.cacheHits = Number(stats.cacheHits || 0) + 1;
    if (event.ok && !event.cacheHit) stats.fetched = Number(stats.fetched || 0) + 1;
    if (!event.ok) stats.failed = Number(stats.failed || 0) + 1;
  }

  async function preheat({ dates, bbox, datasetId, limit, anchorDate, blocking = true, onStateChange } = {}) {
    const cacheOptions = options();
    if (cacheOptions.mode === "off" || !isEnabledForCurrentLayer()) {
      return true;
    }

    const preheatDates = selectDates(dates, { anchorDate });
    if (preheatDates.length <= 1) {
      return true;
    }

    const requests = requestsForDates(preheatDates, { bbox, datasetId, limit, anchorDate });
    const label = layerLabel();

    const background = cacheOptions.mode === "progressive" || !blocking;
    state.playbackCache.isPreheating = !background;
    state.playbackCache.isBackgroundPreloading = background;
    resetStats(requests.length);
    onStateChange?.();
    setStatus(`正在預熱 ${label} 播放快取 0 / ${requests.length}`);

    const run = GfwRecordCache.prefetchRequests(requests, {
      concurrency: cacheOptions.resolvedConcurrency,
      onProgress: (event) => {
        updateStats(event);
        onStateChange?.();
        const stats = state.playbackCache.stats;
        setStatus(`正在預熱 ${label} 播放快取 ${stats.completed} / ${stats.queued}`);
      },
    }).finally(() => {
      state.playbackCache.isPreheating = false;
      state.playbackCache.isBackgroundPreloading = false;
      onStateChange?.();
      const stats = state.playbackCache.stats;
      setStatus(`${label} 播放快取預熱完成 ${stats.completed} / ${stats.queued}`);
    });

    if (cacheOptions.mode === "progressive" || !blocking) {
      run.catch((err) => setStatus(err.message, true));
      return true;
    }
    await run;
    return true;
  }

  return {
    BYTES_PER_GB,
    bufferPolicy,
    clear,
    clearBufferState,
    countReadyPrefix,
    formatBytes,
    hasDate,
    isEnabledForCurrentLayer,
    layerLabel,
    options,
    preheat,
    requestForDate,
    requestsForDates,
    selectDates,
    setBufferState,
    statusText,
  };
})();
