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
    return {
      mode: state.playbackCache?.mode || "before_play",
      concurrency: Math.max(1, Number(state.playbackCache?.concurrency || 1)),
      maxDates: Math.max(0, Number(state.playbackCache?.maxDates || 0)),
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

  function selectDates(dates) {
    const allDates = Array.isArray(dates) ? dates : [];
    const { maxDates } = options();
    if (maxDates > 0 && allDates.length > maxDates) {
      return allDates.slice(0, maxDates);
    }
    return allDates;
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

  function updateStats(event) {
    const stats = state.playbackCache.stats;
    stats.completed = Math.min(stats.queued, Number(stats.completed || 0) + 1);
    if (event.ok && event.cacheHit) stats.cacheHits = Number(stats.cacheHits || 0) + 1;
    if (event.ok && !event.cacheHit) stats.fetched = Number(stats.fetched || 0) + 1;
    if (!event.ok) stats.failed = Number(stats.failed || 0) + 1;
  }

  async function preheat({ dates, bbox, datasetId, limit, blocking = true, onStateChange } = {}) {
    const cacheOptions = options();
    if (cacheOptions.mode === "off" || !isEnabledForCurrentLayer()) {
      return true;
    }

    const preheatDates = selectDates(dates);
    if (preheatDates.length <= 1) {
      return true;
    }

    const requests = preheatDates.map((date) => ({
      datasetId,
      date,
      bbox,
      limit,
    }));
    const label = layerLabel();

    state.playbackCache.isPreheating = true;
    resetStats(requests.length);
    onStateChange?.();
    setStatus(`正在預熱 ${label} 播放快取 0 / ${requests.length}`);

    const run = GfwRecordCache.prefetchRequests(requests, {
      concurrency: cacheOptions.concurrency,
      onProgress: (event) => {
        updateStats(event);
        onStateChange?.();
        const stats = state.playbackCache.stats;
        setStatus(`正在預熱 ${label} 播放快取 ${stats.completed} / ${stats.queued}`);
      },
    }).finally(() => {
      state.playbackCache.isPreheating = false;
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
    formatBytes,
    isEnabledForCurrentLayer,
    layerLabel,
    options,
    preheat,
    selectDates,
    statusText,
  };
})();
