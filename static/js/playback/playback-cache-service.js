function createPlaybackCacheService({
  targetState,
  dataFrameStore,
  preheater,
  frameIdentity,
  sampledGridLayerPredicate,
} = {}) {
  if (!targetState || !dataFrameStore || !preheater || !frameIdentity) {
    throw new TypeError("PlaybackCacheService requires state, store, preheater and frame identity");
  }
  if (typeof sampledGridLayerPredicate !== "function") {
    throw new TypeError("PlaybackCacheService requires a sampled-grid predicate");
  }
  const state = targetState;
  const DataFrameStore = dataFrameStore;
  const PlaybackPreheater = preheater;
  const FrameIdentity = frameIdentity;
  const BYTES_PER_GB = 1024 * 1024 * 1024;
  function isEnabledForCurrentLayer() {
    return sampledGridLayerPredicate(state.dataLayer);
  }

  function layerLabel() {
    return String(state.dataLayer || "layer").toUpperCase();
  }

  function options() {
    const highWatermark = Math.max(2, Number(state.playbackCache?.highWatermark ?? state.playbackCache?.windowAhead ?? 10));
    return {
      windowBehind: Math.max(0, Number(state.playbackCache?.windowBehind ?? 1)),
      windowAhead: highWatermark,
      highWatermark,
      lowWatermark: Math.max(1, Math.min(highWatermark - 1, Number(state.playbackCache?.lowWatermark ?? 5))),
      maxGb: Math.max(0.25, Number(state.dataFrameStore?.maxBytes || 2 * BYTES_PER_GB) / BYTES_PER_GB),
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
    const cache = DataFrameStore.snapshot();
    const preheater = PlaybackPreheater.snapshot();
    const capacity = `快取容量：${formatBytes(cache.bytes)} / ${formatBytes(cache.maxBytes)}`;
    if (preheater.status === "FETCHING") {
      return `背景補充中：前方已備 ${preheater.readyAhead} 張，傳輸中 ${preheater.inflight} 張，${capacity}`;
    }
    return `待命：前方已備 ${preheater.readyAhead || 0} 張，${capacity}`;
  }

  function requestForDate(date, context = {}) {
    return FrameIdentity.normalizeRequest({ ...context, date });
  }

  function requestsForDates(dates, context) {
    return (Array.isArray(dates) ? dates : []).map((date) => requestForDate(date, context));
  }

  function hasDate(date, context) {
    if (!date || !context) return false;
    return DataFrameStore.inspect(requestForDate(date, context)).status === "ready";
  }

  function failureForDate(date, context) {
    if (!date || !context) return null;
    const inspected = DataFrameStore.inspect(requestForDate(date, context));
    return inspected.status === "failed" ? inspected.failure : null;
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

  function setBufferState({
    buffering = false,
    status = "idle",
    ready = 0,
    required = 0,
    resume = 0,
    currentDate = "",
    targetIndex = -1,
    attempts = 0,
    stateName = "",
    errorMessage = "",
  } = {}) {
    Object.assign(state.playbackCache, {
      buffering,
      bufferStatus: status,
      bufferReady: ready,
      bufferRequired: required,
      bufferResume: resume,
      bufferCurrentDate: currentDate,
      bufferTargetIndex: targetIndex,
      bufferAttempts: attempts,
      bufferStateName: stateName,
      bufferErrorMessage: errorMessage,
    });
  }

  function clearBufferState() {
    setBufferState();
  }

  function clear() {
    PlaybackPreheater.stop("cache_service_clear");
    clearBufferState();
  }

  function reconcilePolicy() {
    return PlaybackPreheater.reconcile({ force: true });
  }

  return Object.freeze({
    BYTES_PER_GB,
    clear,
    clearBufferState,
    countReadyPrefix,
    failureForDate,
    formatBytes,
    hasDate,
    isEnabledForCurrentLayer,
    layerLabel,
    options,
    reconcilePolicy,
    requestForDate,
    requestsForDates,
    setBufferState,
    statusText,
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.createPlaybackCacheService = createPlaybackCacheService;
}
