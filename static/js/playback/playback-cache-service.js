const PlaybackCacheService = (() => {
  const BYTES_PER_GB = 1024 * 1024 * 1024;
  const STARTUP_RENDERABLE_FRAME_COUNT = 1;
  let backgroundPreloadRun = null;
  let backgroundPreloadSignature = "";
  let backgroundPreloadScopeSignature = "";
  let pendingBackgroundPreload = null;
  let backgroundPreloadVersion = 0;
  let activeBackgroundPreloadVersion = 0;
  const failedRequests = new Map();

  function recordCache() {
    if (typeof SampledGridRecordCache !== "undefined") return SampledGridRecordCache;
    if (typeof GfwRecordCache !== "undefined") return GfwRecordCache;
    return null;
  }

  function isEnabledForCurrentLayer() {
    return typeof isSampledGridLayer === "function" && isSampledGridLayer(state.dataLayer);
  }

  function layerLabel() {
    return String(state.dataLayer || "layer").toUpperCase();
  }

  function options() {
    const rawConcurrency = state.playbackCache?.concurrency ?? "auto";
    const mode = state.playbackCache?.mode === "before_play" ? "before_play" : "progressive";
    if (state.playbackCache && state.playbackCache.mode !== mode) {
      state.playbackCache.mode = mode;
    }
    return {
      mode,
      concurrency: rawConcurrency,
      resolvedConcurrency: PlaybackWorkerPolicy.resolve(rawConcurrency, { task: "prefetch" }),
      concurrencyLabel: PlaybackWorkerPolicy.label(rawConcurrency, { task: "prefetch" }),
      maxDates: Math.max(0, Number(state.playbackCache?.maxDates || 0)),
      windowBehind: Math.max(0, Number(state.playbackCache?.windowBehind ?? 1)),
      windowAhead: Math.max(1, Number(state.playbackCache?.windowAhead ?? 8)),
      maxGb: Math.max(
        0.25,
        Number(state.sampledGridRecordCache?.maxBytes || 2 * BYTES_PER_GB) / BYTES_PER_GB,
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
    const cacheStats = state.sampledGridRecordCache?.stats || {};
    const cacheLimit = cacheStats.cacheLimitBytes || state.sampledGridRecordCache?.maxBytes;
    const cacheText = `快取容量：${formatBytes(cacheStats.cacheBytes)} / ${formatBytes(cacheLimit)}`;
    const total = Number(stats.queued || 0);
    if (state.playbackCache?.isPreheating) {
      return `預熱中：${Number(stats.completed || 0)} / ${total}，${cacheText}`;
    }
    if (state.playbackCache?.isBackgroundPreloading) {
      return `背景預載中：${Number(stats.completed || 0)} / ${total}，快取命中 ${Number(stats.cacheHits || 0)}，重新查詢 ${Number(stats.fetched || 0)}，${cacheText}`;
    }
    if (total > 0) {
      return `已完成：${Number(stats.completed || 0)} / ${total}，快取命中 ${Number(stats.cacheHits || 0)}，重新查詢 ${Number(stats.fetched || 0)}，${cacheText}`;
    }
    return `待命：${cacheText}`;
  }

  function requestForDate(date, {
    bbox,
    datasetId,
    limit,
    columns = "render",
    resolution,
    zoom,
    latitude,
  } = {}) {
    return {
      datasetId,
      date,
      bbox,
      limit,
      columns,
      resolution,
      zoom,
      latitude,
    };
  }

  function requestsForDates(dates, context) {
    return (Array.isArray(dates) ? dates : []).map((date) => requestForDate(date, context));
  }

  function requestFailureKey({ datasetId, date, bbox, limit, columns, resolution } = {}) {
    return [
      datasetId || "",
      date || "",
      bbox || "",
      limit == null ? "" : String(limit),
      columns || "render",
      resolution == null ? "auto" : String(resolution),
    ].join("|");
  }

  function failureMessage(error) {
    if (!error) return "request failed";
    if (typeof error === "string") return error;
    return error.message || "request failed";
  }

  function rememberFailure(request, error) {
    if (!request?.date) return;
    failedRequests.set(requestFailureKey(request), {
      ...request,
      message: failureMessage(error),
      at: Date.now(),
    });
  }

  function clearFailure(request) {
    if (!request?.date) return;
    failedRequests.delete(requestFailureKey(request));
  }

  function failureForDate(date, context) {
    if (!date || !context) return null;
    return failedRequests.get(requestFailureKey(requestForDate(date, context))) || null;
  }

  function hasDate(date, context) {
    if (!date || !context) return false;
    const request = requestForDate(date, context);
    const hasPacket = Boolean(recordCache()?.hasPacket?.(request));
    if (hasPacket) {
      clearFailure(request);
    }
    return hasPacket;
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

  function bufferPolicy({ intervalMs, remainingDates, rate } = {}) {
    const interval = Math.max(1, Number(intervalMs || 1400));
    const timelineRate = Math.max(0.25, Number(rate || state.playbackRate || 1));
    const speed = Math.max(0.25, (1400 / interval) * timelineRate);
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
    targetIndex = -1,
    waitStartedAt = 0,
    attempts = 0,
    stateName = "",
    errorMessage = "",
  } = {}) {
    state.playbackCache.buffering = buffering;
    state.playbackCache.bufferStatus = status;
    state.playbackCache.bufferReady = ready;
    state.playbackCache.bufferRequired = required;
    state.playbackCache.bufferResume = resume;
    state.playbackCache.bufferCurrentDate = currentDate;
    state.playbackCache.bufferTargetIndex = targetIndex;
    state.playbackCache.bufferWaitStartedAt = waitStartedAt;
    state.playbackCache.bufferAttempts = attempts;
    state.playbackCache.bufferStateName = stateName;
    state.playbackCache.bufferErrorMessage = errorMessage;
  }

  function clearBufferState() {
    setBufferState();
  }

  function selectPlaybackWindowDates(dates, { anchorDate = null } = {}) {
    const allDates = Array.isArray(dates) ? dates : [];
    const { maxDates, windowAhead, windowBehind } = options();
    if (!allDates.length) return [];
    let selected = allDates;
    if (anchorDate && allDates.includes(anchorDate)) {
      const anchorIndex = allDates.indexOf(anchorDate);
      const remainingDates = Math.max(1, allDates.length - anchorIndex);
      const policy = bufferPolicy({
        intervalMs: state.playIntervalMs,
        rate: state.playbackRate,
        remainingDates,
      });
      const dynamicWindowAhead = Math.max(windowAhead, policy.resume);
      const start = Math.max(0, anchorIndex - windowBehind);
      const end = Math.min(allDates.length, anchorIndex + dynamicWindowAhead + 1);
      const behind = allDates.slice(start, anchorIndex);
      const forward = allDates.slice(anchorIndex, end);
      selected = [...behind, ...forward];
      if (maxDates > 0 && selected.length > maxDates) {
        const forwardLimit = Math.min(forward.length, maxDates);
        const forwardSelected = forward.slice(0, forwardLimit);
        const behindLimit = Math.max(0, maxDates - forwardSelected.length);
        const behindSelected = behindLimit > 0 ? behind.slice(-behindLimit) : [];
        return [...behindSelected, ...forwardSelected];
      }
    }
    if (maxDates > 0 && selected.length > maxDates) {
      return selected.slice(0, maxDates);
    }
    return selected;
  }

  function selectFullPlaybackDates(dates, { anchorDate = null } = {}) {
    const allDates = Array.isArray(dates) ? dates : [];
    if (!allDates.length) return [];
    const { maxDates } = options();
    const anchorIndex = anchorDate && allDates.includes(anchorDate)
      ? allDates.indexOf(anchorDate)
      : 0;
    const selected = allDates.slice(Math.max(0, anchorIndex));
    if (maxDates > 0 && selected.length > maxDates) {
      return selected.slice(0, maxDates);
    }
    return selected;
  }

  function startupBufferPlan(dates, { anchorDate = null } = {}) {
    const allDates = Array.isArray(dates) ? dates : [];
    if (allDates.length <= 1) {
      return {
        anchorIndex: allDates.length ? 0 : -1,
        nextIndex: -1,
        required: 0,
        resume: 0,
        startupRequired: 0,
        dates: [...allDates],
      };
    }
    const requestedAnchorIndex = anchorDate ? allDates.indexOf(anchorDate) : 0;
    const anchorIndex = requestedAnchorIndex >= 0 ? requestedAnchorIndex : 0;
    const nextIndex = anchorIndex + 1;
    const remainingDates = Math.max(0, allDates.length - nextIndex);
    if (remainingDates <= 0) {
      return {
        anchorIndex,
        nextIndex: -1,
        required: 0,
        resume: 0,
        startupRequired: 0,
        dates: [allDates[anchorIndex]],
      };
    }
    const policy = bufferPolicy({
      intervalMs: state.playIntervalMs,
      rate: state.playbackRate,
      remainingDates,
    });
    const startupRequired = Math.min(remainingDates, STARTUP_RENDERABLE_FRAME_COUNT);
    return {
      ...policy,
      anchorIndex,
      nextIndex,
      startupRequired,
      dates: allDates.slice(anchorIndex, anchorIndex + startupRequired + 1),
    };
  }

  function startupReadiness(dates, { anchorDate = null, requestContext = null } = {}) {
    const plan = startupBufferPlan(dates, { anchorDate });
    const ready = plan.nextIndex >= 0 && requestContext
      ? countReadyPrefix(dates, plan.nextIndex, requestContext)
      : 0;
    return {
      ...plan,
      ready,
      isReady: plan.startupRequired <= 0 || ready >= plan.startupRequired,
    };
  }

  function selectedPreheatDates(dates, { anchorDate = null, mode = "progressive", blocking = false } = {}) {
    if (mode === "before_play" && blocking) {
      return selectFullPlaybackDates(dates, { anchorDate });
    }
    if (mode === "progressive" && blocking) {
      return startupBufferPlan(dates, { anchorDate }).dates;
    }
    return selectPlaybackWindowDates(dates, { anchorDate });
  }

  function preloadScopeSignature({ datasetId, bbox, limit, columns, resolution, zoom, latitude }) {
    return [
      datasetId,
      bbox,
      limit,
      columns || "render",
      resolution == null ? "auto" : resolution,
      zoom == null ? "auto" : zoom,
      latitude == null ? "auto" : latitude,
    ].join("|");
  }

  function preloadSignature({ mode, background, dates, bbox, datasetId, limit, columns, resolution, zoom, latitude }) {
    return [
      mode,
      background ? "background" : "blocking",
      preloadScopeSignature({ datasetId, bbox, limit, columns, resolution, zoom, latitude }),
      dates.join(","),
    ].join("|");
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

  function cancelBackground() {
    backgroundPreloadRun = null;
    backgroundPreloadSignature = "";
    backgroundPreloadScopeSignature = "";
    pendingBackgroundPreload = null;
    backgroundPreloadVersion += 1;
    activeBackgroundPreloadVersion = 0;
    state.playbackCache.isBackgroundPreloading = false;
    recordCache()?.cancelPrefetch?.();
    failedRequests.clear();
  }

  function clear() {
    state.playbackCache.isPreheating = false;
    cancelBackground();
    clearBufferState();
    resetStats(0);
  }

  function updateStats(event) {
    if (event?.request) {
      if (event.ok) {
        clearFailure(event.request);
      } else {
        rememberFailure(event.request, event.error);
      }
    }
    const stats = state.playbackCache.stats;
    stats.completed = Math.min(stats.queued, Number(stats.completed || 0) + 1);
    if (event.ok && event.cacheHit) stats.cacheHits = Number(stats.cacheHits || 0) + 1;
    if (event.ok && !event.cacheHit) stats.fetched = Number(stats.fetched || 0) + 1;
    if (!event.ok) stats.failed = Number(stats.failed || 0) + 1;
  }

  function resolveRangeRequest({ intent, dates, bbox, datasetId, limit, anchorDate } = {}) {
    if (intent && typeof RenderIntentService !== "undefined") {
      return RenderIntentService.toSampledGridRangeRequest(intent);
    }
    return {
      dates: Array.isArray(dates) ? dates : [],
      bbox,
      datasetId,
      limit,
      columns: "render",
      anchorDate,
    };
  }

  async function preheat({ intent, dates, bbox, datasetId, limit, anchorDate, blocking = true, onStateChange } = {}) {
    const cacheOptions = options();
    if (!isEnabledForCurrentLayer()) {
      return true;
    }

    const resolved = resolveRangeRequest({ intent, dates, bbox, datasetId, limit, anchorDate });
    const background = !blocking;
    const preheatDates = selectedPreheatDates(resolved.dates, {
      anchorDate: resolved.anchorDate,
      mode: cacheOptions.mode,
      blocking,
    });
    if (preheatDates.length <= 1) {
      return true;
    }

    const requestContext = {
      bbox: resolved.bbox,
      datasetId: resolved.datasetId,
      limit: resolved.limit,
      anchorDate: resolved.anchorDate,
      columns: resolved.columns || "render",
      resolution: resolved.resolution,
      zoom: resolved.zoom,
      latitude: resolved.latitude,
    };
    const requests = requestsForDates(preheatDates, requestContext);
    const label = layerLabel();

    const signature = preloadSignature({
      mode: cacheOptions.mode,
      background,
      dates: preheatDates,
      bbox: resolved.bbox,
      datasetId: resolved.datasetId,
      limit: resolved.limit,
      columns: requestContext.columns,
      resolution: requestContext.resolution,
      zoom: requestContext.zoom,
      latitude: requestContext.latitude,
    });
    const scopeSignature = preloadScopeSignature({
      datasetId: resolved.datasetId,
      bbox: resolved.bbox,
      limit: resolved.limit,
      columns: requestContext.columns,
      resolution: requestContext.resolution,
      zoom: requestContext.zoom,
      latitude: requestContext.latitude,
    });
    if (background && backgroundPreloadRun) {
      if (backgroundPreloadSignature === signature) return true;
      pendingBackgroundPreload = {
        intent,
        dates,
        bbox,
        datasetId,
        limit,
        anchorDate,
        blocking: false,
        onStateChange,
      };
      if (backgroundPreloadScopeSignature !== scopeSignature) {
        recordCache()?.cancelPrefetch?.();
      }
      return true;
    }
    if (!background && backgroundPreloadRun) {
      cancelBackground();
    }
    for (const request of requests) {
      clearFailure(request);
    }

    const runVersion = background ? backgroundPreloadVersion + 1 : 0;
    if (background) {
      backgroundPreloadVersion = runVersion;
      activeBackgroundPreloadVersion = runVersion;
      backgroundPreloadScopeSignature = scopeSignature;
      state.playbackCache.isBackgroundPreloading = true;
    } else {
      state.playbackCache.isPreheating = true;
    }
    resetStats(requests.length);
    onStateChange?.();
    setStatus(`正在預熱 ${label} 播放快取 0 / ${requests.length}`);

    const cache = recordCache();
    if (!cache) {
      throw new Error("取樣網格快取尚未載入");
    }
    const useRangePrefetch = cacheOptions.mode === "before_play"
      && blocking
      && typeof cache.prefetchRange === "function";
    const prefetch = useRangePrefetch
      ? cache.prefetchRange.bind(cache, {
        dates: preheatDates,
        bbox: resolved.bbox,
        datasetId: resolved.datasetId,
        limit: resolved.limit,
        columns: requestContext.columns,
        resolution: requestContext.resolution,
        zoom: requestContext.zoom,
        latitude: requestContext.latitude,
      })
      : cache.prefetchRequests.bind(cache, requests);
    const run = prefetch({
      concurrency: cacheOptions.resolvedConcurrency,
      onProgress: (event) => {
        if (background && activeBackgroundPreloadVersion !== runVersion) return;
        updateStats(event);
        onStateChange?.();
        const stats = state.playbackCache.stats;
        setStatus(`正在預熱 ${label} 播放快取 ${stats.completed} / ${stats.queued}`);
      },
    }).finally(() => {
      if (background && activeBackgroundPreloadVersion !== runVersion) return;
      if (!background) {
        state.playbackCache.isPreheating = false;
      }
      if (backgroundPreloadRun === run) {
        backgroundPreloadRun = null;
        backgroundPreloadSignature = "";
        backgroundPreloadScopeSignature = "";
        activeBackgroundPreloadVersion = 0;
      }
      if (background) {
        const pending = pendingBackgroundPreload;
        pendingBackgroundPreload = null;
        if (pending) {
          Promise.resolve().then(() => preheat(pending)).catch((err) => setStatus(err.message, true));
        } else {
          state.playbackCache.isBackgroundPreloading = false;
        }
      }
      onStateChange?.();
      const stats = state.playbackCache.stats;
      setStatus(`${label} 播放快取預熱完成 ${stats.completed} / ${stats.queued}`);
    });

    if (background) {
      backgroundPreloadRun = run;
      backgroundPreloadSignature = signature;
      run.catch((err) => {
        if (background && activeBackgroundPreloadVersion !== runVersion) return;
        setStatus(err.message, true);
      });
      return true;
    }
    await run;
    return true;
  }

  return {
    BYTES_PER_GB,
    bufferPolicy,
    cancelBackground,
    clear,
    clearBufferState,
    countReadyPrefix,
    failureForDate,
    formatBytes,
    hasDate,
    isEnabledForCurrentLayer,
    layerLabel,
    options,
    preheat,
    requestForDate,
    requestsForDates,
    selectDates: selectPlaybackWindowDates,
    selectFullPlaybackDates,
    selectPlaybackWindowDates,
    setBufferState,
    startupBufferPlan,
    startupReadiness,
    statusText,
  };
})();
