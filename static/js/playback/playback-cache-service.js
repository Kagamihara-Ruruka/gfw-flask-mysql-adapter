function createPlaybackCacheService({
  targetState,
  dataFrameStore,
  preheater,
  watermarkController,
  fixedPolicyNormalizer,
  frameIdentity,
  sampledGridLayerPredicate,
} = {}) {
  if (!targetState || !dataFrameStore || !preheater || !watermarkController || !frameIdentity) {
    throw new TypeError("PlaybackCacheService requires state, store, preheater, watermark controller and frame identity");
  }
  if (typeof sampledGridLayerPredicate !== "function") {
    throw new TypeError("PlaybackCacheService requires a sampled-grid predicate");
  }
  if (typeof fixedPolicyNormalizer !== "function") {
    throw new TypeError("PlaybackCacheService requires a fixed watermark policy normalizer");
  }
  const state = targetState;
  const DataFrameStore = dataFrameStore;
  const PlaybackPreheater = preheater;
  const WatermarkController = watermarkController;
  const FrameIdentity = frameIdentity;
  const BYTES_PER_GB = 1024 * 1024 * 1024;
  function isEnabledForCurrentLayer() {
    return sampledGridLayerPredicate(state.dataLayer);
  }

  function layerLabel() {
    return String(state.dataLayer || "layer").toUpperCase();
  }

  function options() {
    const fixedPolicy = fixedPolicyNormalizer(state.playbackCache || {});
    const policy = WatermarkController.preview({ fixedPolicy });
    return {
      ...fixedPolicy,
      windowAhead: fixedPolicy.highWatermark,
      maxGb: Math.max(0.25, Number(state.dataFrameStore?.maxBytes || 0.5 * BYTES_PER_GB) / BYTES_PER_GB),
      strategy: policy.strategy,
      policyStatus: policy.status,
      effectiveLowWatermark: policy.lowWatermark,
      effectiveHighWatermark: policy.highWatermark,
      effectiveTargetWatermark: policy.targetWatermark ?? policy.highWatermark,
      immediateReplenishment: Boolean(policy.immediateReplenishment),
      tailMode: Boolean(policy.tailMode),
      supplyRatio: Number.isFinite(Number(policy.supplyRatio)) ? Number(policy.supplyRatio) : null,
      ramBudgetFrames: policy.ramBudgetFrames,
      playbackRamBudgetBytes: Number(policy.playbackRamBudgetBytes || 0),
      hasObservedFrameSize: Boolean(policy.hasObservedFrameSize),
      estimatedFrameBytes: policy.estimatedFrameBytes,
      policyReason: policy.reason,
      degradationReason: policy.degradationReason || "",
    };
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes || 0));
    if (value >= BYTES_PER_GB) {
      return `${formatDisplayNumber(value / BYTES_PER_GB, { maximumFractionDigits: 2 })} GB`;
    }
    if (value >= 1024 * 1024) {
      return `${formatDisplayNumber(value / (1024 * 1024), { maximumFractionDigits: 0 })} MB`;
    }
    if (value >= 1024) {
      return `${formatDisplayNumber(value / 1024, { maximumFractionDigits: 0 })} KB`;
    }
    return `${formatDisplayNumber(value, { maximumFractionDigits: 0 })} B`;
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

  function policyStatusText() {
    const policy = options();
    const target = ` · 目標 ${policy.effectiveTargetWatermark}`;
    if (policy.strategy === "fixed") {
      return `固定水位：低 ${policy.effectiveLowWatermark} 觸發 / 高 ${policy.effectiveHighWatermark}${target}`;
    }
    if (policy.policyStatus === "WARMING") {
      return `自適應補水：樣本累積中 · 低 ${policy.effectiveLowWatermark} 觸發 / 高 ${policy.effectiveHighWatermark}${target}`;
    }
    const budget = policy.ramBudgetFrames != null
      && Number.isFinite(Number(policy.ramBudgetFrames))
      ? ` · RAM 50% 可容納 ${Number(policy.ramBudgetFrames)} 張`
      : "";
    const degradation = policy.degradationReason ? ` · ${policy.degradationReason}` : "";
    const mode = policy.tailMode
      ? " · 尾端模式"
      : policy.immediateReplenishment
        ? " · 供給不足，提前補貨"
        : "";
    return `自適應補水：低 ${policy.effectiveLowWatermark} 觸發 / 高 ${policy.effectiveHighWatermark}${target}${mode}${budget}${degradation}`;
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

  function reconcilePolicy() {
    return PlaybackPreheater.reconcile({ force: true });
  }

  function resetPolicy(reason = "configuration_changed") {
    WatermarkController.reset(reason);
    return reconcilePolicy();
  }

  return Object.freeze({
    BYTES_PER_GB,
    clearBufferState,
    countReadyPrefix,
    failureForDate,
    formatBytes,
    hasDate,
    isEnabledForCurrentLayer,
    layerLabel,
    options,
    policyStatusText,
    reconcilePolicy,
    resetPolicy,
    requestForDate,
    requestsForDates,
    setBufferState,
    statusText,
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.createPlaybackCacheService = createPlaybackCacheService;
}
