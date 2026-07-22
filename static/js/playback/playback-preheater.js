function evaluatePlaybackReplenishment({
  readyAhead = 0,
  lowWatermark = 0,
  targetWatermark = 0,
  force = false,
  tailMode = false,
  immediateReplenishment = false,
  wasReplenishing = false,
  previousTrigger = "",
} = {}) {
  const ready = Math.max(0, Number(readyAhead || 0));
  const low = Math.max(0, Number(lowWatermark || 0));
  const target = Math.max(0, Number(targetWatermark || 0));
  if (target <= 0 || ready >= target) {
    return Object.freeze({ replenishing: false, trigger: "" });
  }
  if (force) return Object.freeze({ replenishing: true, trigger: "forced" });
  if (tailMode) return Object.freeze({ replenishing: true, trigger: "terminal_tail" });
  if (immediateReplenishment) {
    return Object.freeze({ replenishing: true, trigger: "supply_deficit" });
  }
  if (wasReplenishing) {
    return Object.freeze({ replenishing: true, trigger: previousTrigger || "watermark_refill" });
  }
  if (ready <= low) return Object.freeze({ replenishing: true, trigger: "low_watermark" });
  return Object.freeze({ replenishing: false, trigger: "" });
}

function playbackCalendarMonthKey(date) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(date || ""));
  return match ? `${match[1]}-${match[2]}` : "";
}

function playbackCalendarMonthWindow(dates = [], cursorIndex = 0, monthCount = 1) {
  if (!Array.isArray(dates) || !dates.length) {
    return Object.freeze({ startIndex: 0, endIndex: 0, monthKeys: Object.freeze([]) });
  }
  const cursor = Math.max(0, Math.min(dates.length - 1, Number(cursorIndex) || 0));
  const activeMonth = playbackCalendarMonthKey(dates[cursor]);
  if (!activeMonth) {
    return Object.freeze({ startIndex: cursor, endIndex: cursor + 1, monthKeys: Object.freeze([]) });
  }
  let startIndex = cursor;
  while (startIndex > 0 && playbackCalendarMonthKey(dates[startIndex - 1]) === activeMonth) {
    startIndex -= 1;
  }
  const monthKeys = [];
  const limit = Math.max(1, Math.floor(Number(monthCount) || 1));
  let endIndex = startIndex;
  while (endIndex < dates.length) {
    const key = playbackCalendarMonthKey(dates[endIndex]);
    if (!key) break;
    if (monthKeys.at(-1) !== key) {
      if (monthKeys.length >= limit) break;
      monthKeys.push(key);
    }
    endIndex += 1;
  }
  return Object.freeze({
    startIndex,
    endIndex,
    monthKeys: Object.freeze(monthKeys),
  });
}

function normalizedPlaybackCacheCapacityPolicy(policy = {}) {
  const bufferUnit = String(policy.bufferUnit || policy.buffer_unit || "frame") === "calendar_month"
    ? "calendar_month"
    : "frame";
  const lowWatermarkMonths = Math.max(1, Math.floor(Number(
    policy.lowWatermarkMonths ?? policy.low_watermark_months ?? 1,
  )));
  const highWatermarkMonths = Math.max(lowWatermarkMonths, Math.floor(Number(
    policy.highWatermarkMonths ?? policy.high_watermark_months ?? 2,
  )));
  const ratedFrameBytes = Math.max(1024 * 1024, Math.floor(Number(
    policy.ratedFrameBytes ?? policy.rated_frame_bytes ?? 16 * 1024 * 1024,
  )));
  const cacheHeadroomFrames = Math.max(0, Math.min(62, Math.floor(Number(
    policy.cacheHeadroomFrames ?? policy.cache_headroom_frames ?? 8,
  ))));
  const retainedFrameCapacity = bufferUnit === "calendar_month"
    ? highWatermarkMonths * 31
    : 0;
  const requiredFrameCapacity = retainedFrameCapacity > 0
    ? retainedFrameCapacity + cacheHeadroomFrames
    : 0;
  const requiredCacheBytes = requiredFrameCapacity * ratedFrameBytes;
  const requestedCacheMaxBytes = Math.max(0, Math.floor(Number(
    policy.cacheMaxBytes ?? policy.cache_max_bytes ?? 0,
  )));
  const cacheMaxBytes = requestedCacheMaxBytes > 0
    ? Math.max(requestedCacheMaxBytes, requiredCacheBytes)
    : requiredCacheBytes;
  return Object.freeze({
    bufferUnit,
    lowWatermarkMonths,
    highWatermarkMonths,
    ratedFrameBytes,
    cacheHeadroomFrames,
    retainedFrameCapacity,
    requiredFrameCapacity,
    requiredCacheBytes,
    cacheMaxBytes,
  });
}

class PlaybackPreheaterController {
  constructor({
    store,
    demandService,
    eventLog,
    frameIdentity,
    clock,
    optionsProvider = null,
    fixedPolicyNormalizer,
    watermarkPolicyProvider = null,
    sourcePolicyProvider = null,
    stateSink = null,
  } = {}) {
    if (!store || !demandService || !eventLog || !frameIdentity || !clock) {
      throw new TypeError("PlaybackPreheater requires store, demand service, event log, identity and clock");
    }
    if (typeof clock.now !== "function" || typeof clock.schedule !== "function" || typeof clock.cancel !== "function") {
      throw new TypeError("PlaybackPreheater requires a schedulable monotonic clock");
    }
    if (typeof fixedPolicyNormalizer !== "function") {
      throw new TypeError("PlaybackPreheater requires a fixed watermark policy normalizer");
    }
    this.store = store;
    this.demandService = demandService;
    this.eventLog = eventLog;
    this.frameIdentity = frameIdentity;
    this.clock = clock;
    this.optionsProvider = optionsProvider || (() => ({}));
    this.fixedPolicyNormalizer = fixedPolicyNormalizer;
    this.watermarkPolicyProvider = watermarkPolicyProvider;
    this.sourcePolicyProvider = sourcePolicyProvider;
    this.stateSink = stateSink;
    this.scope = null;
    this.scopeSequence = 0;
    this.inflight = new Map();
    this.retryAfter = new Map();
    this.retryTimer = null;
    this.scopeSettleTimer = null;
    this.reconcileTimer = null;
    this.pinOwner = "playback-preheater";
    this.pinnedFrames = new Map();
    this.unsubscribeStore = this.store.subscribe?.((change) => this.handleStoreChange(change)) || null;
  }

  options(policyContext = {}) {
    const cache = this.optionsProvider() || {};
    const capacityPolicy = normalizedPlaybackCacheCapacityPolicy(cache);
    const basePolicy = this.fixedPolicyNormalizer(cache);
    const configuredMaxPendingFrames = Math.max(1, Math.min(
      32,
      Number(cache.maxPendingFrames ?? 12),
    ));
    const requestContext = this.scope?.requestContext || {};
    const sourceKey = this.frameIdentity.transportKey(requestContext);
    const sourcePolicy = this.sourcePolicyProvider?.(sourceKey, requestContext) || null;
    const rawSourceCapacity = Number(sourcePolicy?.sourceCapacity);
    const sourceCapacity = sourcePolicy
      ? Math.max(1, Math.min(
        16,
        Number.isFinite(rawSourceCapacity) ? Math.floor(rawSourceCapacity) : 1,
      ))
      : null;
    const rawBatchSize = Number(sourcePolicy?.effectiveBatchSize);
    const effectiveBatchSize = sourcePolicy
      ? Math.max(1, Math.min(
        sourceCapacity,
        Number.isFinite(rawBatchSize) ? Math.floor(rawBatchSize) : sourceCapacity,
      ))
      : null;
    const transportPendingFrames = sourcePolicy
      ? sourceCapacity + effectiveBatchSize
      : configuredMaxPendingFrames;
    const fixedPolicy = {
      ...basePolicy,
      configuredMaxPendingFrames,
      maxPendingFrames: Math.min(configuredMaxPendingFrames, transportPendingFrames),
      sourceCapacity,
      effectiveBatchSize,
      scopeSettleMs: Math.max(0, Number(cache.scopeSettleMs ?? 0)),
    };
    const { bufferUnit, lowWatermarkMonths, highWatermarkMonths } = capacityPolicy;
    if (bufferUnit === "calendar_month" && this.scope?.dates.length) {
      const highWindow = playbackCalendarMonthWindow(
        this.scope.dates,
        this.scope.cursorIndex,
        highWatermarkMonths,
      );
      const lowWindow = playbackCalendarMonthWindow(
        this.scope.dates,
        this.scope.cursorIndex,
        lowWatermarkMonths,
      );
      const futureStart = Math.min(this.scope.dates.length, this.scope.cursorIndex + 1);
      const remainingSlices = Math.max(0, this.scope.dates.length - futureStart);
      const targetWatermark = Math.max(0, highWindow.endIndex - futureStart);
      const lowWatermark = Math.max(0, lowWindow.endIndex - futureStart);
      const tailMode = highWindow.monthKeys.length < highWatermarkMonths;
      return {
        ...fixedPolicy,
        ...capacityPolicy,
        bufferUnit,
        lowWatermarkMonths,
        highWatermarkMonths,
        retainedMonthKeys: [...highWindow.monthKeys],
        retainedFrameCount: Math.max(0, highWindow.endIndex - highWindow.startIndex),
        calendarWindowStartIndex: highWindow.startIndex,
        calendarWindowEndIndex: highWindow.endIndex,
        highWatermark: targetWatermark,
        lowWatermark,
        windowBehind: Math.max(0, this.scope.cursorIndex - highWindow.startIndex),
        targetWatermark,
        immediateReplenishment: false,
        tailMode,
        supplyRatio: null,
        strategy: "calendar_month",
        policyStatus: "FIXED",
        policyReason: "runtime_calendar_month_policy",
        candidateLowWatermark: lowWatermark,
        candidateHighWatermark: targetWatermark,
        ramBudgetFrames: null,
        playbackRamBudgetBytes: 0,
        hasObservedFrameSize: false,
        estimatedFrameBytes: 0,
        consumptionRate: 0,
        supplyRate: 0,
        supplySamples: 0,
        latencyP95Ms: 0,
        latencySamples: 0,
        minimumSupplySamples: 2,
        remainingSlices,
        sustainable: null,
        degradationReason: "",
      };
    }
    const policy = this.watermarkPolicyProvider?.(fixedPolicy, {
      datasetId: requestContext.datasetId || "",
      cacheNamespace: requestContext.cacheNamespace || "",
      scopeKey: this.scope ? this.frameIdentity.scopeKey(requestContext) : "",
      bbox: requestContext.bbox || "",
      resolution: requestContext.resolution ?? null,
      date: this.scope?.anchorDate || "",
      remainingSlices: this.scope
        ? Math.max(0, this.scope.dates.length - this.scope.cursorIndex - 1)
        : 0,
      ...policyContext,
    }) || fixedPolicy;
    const effectiveHigh = Math.max(2, Number(policy.highWatermark ?? basePolicy.highWatermark));
    const effectiveLow = Math.max(1, Math.min(
      effectiveHigh - 1,
      Number(policy.lowWatermark ?? basePolicy.lowWatermark),
    ));
    const remainingSlices = this.scope
      ? Math.max(0, this.scope.dates.length - this.scope.cursorIndex - 1)
      : Math.max(0, Number(policy.remainingSlices || 0));
    const tailMode = Boolean(this.scope) && remainingSlices < effectiveLow;
    const candidateTarget = tailMode
      ? remainingSlices
      : Math.max(0, Number(policy.targetWatermark ?? effectiveHigh));
    const targetWatermark = this.scope
      ? Math.min(remainingSlices, candidateTarget)
      : candidateTarget;
    return {
      ...fixedPolicy,
      ...capacityPolicy,
      bufferUnit,
      lowWatermarkMonths: 0,
      highWatermarkMonths: 0,
      retainedMonthKeys: [],
      retainedFrameCount: 0,
      highWatermark: effectiveHigh,
      lowWatermark: effectiveLow,
      windowBehind: fixedPolicy.windowBehind,
      targetWatermark,
      immediateReplenishment: Boolean(policy.immediateReplenishment),
      tailMode,
      supplyRatio: Number.isFinite(Number(policy.supplyRatio))
        ? Number(policy.supplyRatio)
        : null,
      strategy: policy.strategy || "fixed",
      policyStatus: policy.status || "FIXED",
      policyReason: policy.reason || "configured",
      candidateLowWatermark: Number(policy.candidateLowWatermark ?? basePolicy.lowWatermark),
      candidateHighWatermark: Number(policy.candidateHighWatermark ?? basePolicy.highWatermark),
      ramBudgetFrames: Number.isFinite(Number(policy.ramBudgetFrames))
        ? Number(policy.ramBudgetFrames)
        : null,
      playbackRamBudgetBytes: Math.max(0, Number(policy.playbackRamBudgetBytes || 0)),
      hasObservedFrameSize: Boolean(policy.hasObservedFrameSize),
      estimatedFrameBytes: Math.max(0, Number(policy.estimatedFrameBytes || 0)),
      consumptionRate: Math.max(0, Number(policy.consumptionRate || 0)),
      supplyRate: Math.max(0, Number(policy.supplyRate || 0)),
      supplySamples: Math.max(0, Number(policy.supplySamples || 0)),
      latencyP95Ms: Math.max(0, Number(policy.latencyP95Ms || 0)),
      latencySamples: Math.max(0, Number(policy.latencySamples || 0)),
      minimumSupplySamples: Math.max(2, Number(policy.minimumSupplySamples || 2)),
      remainingSlices,
      sustainable: policy.sustainable ?? null,
      degradationReason: String(policy.degradationReason || ""),
    };
  }

  scopeSignature({ dates = [], requestContext = {} } = {}) {
    return [
      this.frameIdentity.scopeKey(requestContext),
      dates[0] || "",
      dates[dates.length - 1] || "",
      dates.length,
    ].join("|");
  }

  requestForDate(date) {
    if (!this.scope || !date) return null;
    return this.frameIdentity.normalizeRequest({ ...this.scope.requestContext, date });
  }

  ownsQueryScope(scopeId) {
    if (!this.scope || !scopeId) return false;
    return this.scope.queryScopeIds?.has(scopeId) || this.scope.id === scopeId;
  }

  cancelQueryScopes(scope = this.scope, { includeActive = true } = {}) {
    if (!scope) return 0;
    const scopeIds = scope.queryScopeIds?.size ? scope.queryScopeIds : new Set([scope.id]);
    let cancelled = 0;
    for (const scopeId of scopeIds) {
      if (scopeId) cancelled += Number(this.demandService.cancelScope?.(scopeId, { includeActive }) || 0);
    }
    return cancelled;
  }

  adoptRequestContext(requestContext = {}, { reason = "resolved_request_context" } = {}) {
    if (!this.scope) return this.snapshot();
    const previousScopeId = this.scope.id;
    const previousScopeKey = this.frameIdentity.scopeKey(this.scope.requestContext);
    const normalizedContext = this.frameIdentity.normalizeRequest({
      ...this.scope.requestContext,
      ...requestContext,
      date: this.scope.anchorDate || this.scope.dates[0] || "",
    });
    const signature = this.scopeSignature({
      dates: this.scope.dates,
      requestContext: normalizedContext,
    });
    if (signature === this.scope.signature) {
      const previousQueryResolution = this.frameIdentity.queryResolution(this.scope.requestContext);
      const nextQueryResolution = this.frameIdentity.queryResolution(normalizedContext);
      this.scope.requestContext = normalizedContext;
      if (previousQueryResolution !== nextQueryResolution) {
        this.eventLog?.record?.("PREHEATER_QUERY_ROUTE_UPDATED", {
          scope_id: this.scope.id,
          scope_key: this.frameIdentity.scopeKey(normalizedContext),
          dataset: normalizedContext.datasetId,
          date: this.scope.anchorDate,
          requested_resolution_km: normalizedContext.resolution ?? null,
          previous_effective_query_resolution_km: previousQueryResolution ?? null,
          effective_query_resolution_km: nextQueryResolution ?? null,
          reason,
        });
        this.reconcile({ force: true, bypassSettle: true });
      }
      return this.snapshot();
    }

    const id = `preheater:${++this.scopeSequence}:${signature}`;
    this.releasePinnedFrames();
    this.scope.queryScopeIds = this.scope.queryScopeIds || new Set([previousScopeId]);
    this.scope.queryScopeIds.add(id);
    this.scope.id = id;
    this.scope.signature = signature;
    this.scope.requestContext = normalizedContext;
    this.cancelScheduledReconcile();
    this.clock.cancel(this.retryTimer);
    this.retryTimer = null;
    this.clock.cancel(this.scopeSettleTimer);
    this.scopeSettleTimer = null;
    this.eventLog?.record?.("PREHEATER_SCOPE_MIGRATED", {
      previous_scope_id: previousScopeId,
      previous_scope_key: previousScopeKey,
      scope_id: id,
      scope_key: this.frameIdentity.scopeKey(normalizedContext),
      dataset: normalizedContext.datasetId,
      date: this.scope.anchorDate,
      reason,
    });
    this.reconcile({ force: true, bypassSettle: true });
    return this.snapshot();
  }

  setScope({ dates = [], requestContext = {}, anchorDate = "" } = {}) {
    const normalizedDates = [...new Set(dates.filter(Boolean))].sort();
    const normalizedContext = this.frameIdentity.normalizeRequest({ ...requestContext, date: anchorDate || normalizedDates[0] || "" });
    const signature = this.scopeSignature({ dates: normalizedDates, requestContext: normalizedContext });
    const cursorIndex = Math.max(0, normalizedDates.indexOf(anchorDate));
    if (this.scope?.signature === signature) {
      this.scope.cursorIndex = cursorIndex;
      this.scope.anchorDate = normalizedDates[cursorIndex] || anchorDate || "";
      this.reconcile();
      return this.snapshot();
    }
    this.cancelScheduledReconcile();
    this.cancelQueryScopes(this.scope, { includeActive: true });
    this.releasePinnedFrames();
    this.clock.cancel(this.retryTimer);
    this.retryTimer = null;
    this.clock.cancel(this.scopeSettleTimer);
    this.scopeSettleTimer = null;
    const id = `preheater:${++this.scopeSequence}:${signature}`;
    this.inflight.clear();
    this.retryAfter.clear();
    this.scope = {
      id,
      signature,
      dates: normalizedDates,
      requestContext: normalizedContext,
      cursorIndex,
      anchorDate: normalizedDates[cursorIndex] || anchorDate || "",
      status: normalizedDates.length ? "IDLE" : "STOPPED",
      readyAhead: 0,
      scheduledTotal: 0,
      failed: 0,
      replenishing: false,
      replenishmentReason: "",
      reconcileRuns: 0,
      coalescedReconciles: 0,
      queryScopeIds: new Set([id]),
    };
    this.eventLog?.record?.("PREHEATER_SCOPE_CHANGED", {
      scope_id: id,
      scope_key: this.frameIdentity.scopeKey(normalizedContext),
      dataset: normalizedContext.datasetId,
      date: this.scope.anchorDate,
      frame_count: normalizedDates.length,
    });
    const settleMs = this.options().scopeSettleMs;
    if (settleMs > 0 && normalizedDates.length) {
      this.syncState("IDLE");
      this.eventLog?.record?.("PREHEATER_SCOPE_SETTLING", {
        scope_id: id,
        scope_key: this.frameIdentity.scopeKey(normalizedContext),
        dataset: normalizedContext.datasetId,
        date: this.scope.anchorDate,
        settle_ms: settleMs,
      });
      this.scopeSettleTimer = this.clock.schedule(() => {
        this.scopeSettleTimer = null;
        if (this.scope?.id === id) this.reconcile({ force: true, bypassSettle: true });
      }, settleMs);
    } else {
      this.reconcile({ force: true, bypassSettle: true });
    }
    return this.snapshot();
  }

  activate() {
    this.clock.cancel(this.scopeSettleTimer);
    this.scopeSettleTimer = null;
    return this.reconcile({ force: true, bypassSettle: true });
  }

  setPlayhead({ date = "", index = null } = {}) {
    if (!this.scope) return this.snapshot();
    const resolvedIndex = Number.isInteger(index) ? index : this.scope.dates.indexOf(date);
    if (resolvedIndex >= 0 && resolvedIndex < this.scope.dates.length) {
      this.scope.cursorIndex = resolvedIndex;
      this.scope.anchorDate = this.scope.dates[resolvedIndex];
      this.eventLog?.record?.("PREHEATER_PLAYHEAD_CHANGED", {
        scope_id: this.scope.id,
        dataset: this.scope.requestContext.datasetId,
        date: this.scope.anchorDate,
        ready_ahead: this.readyAhead(),
      });
      this.reconcile();
    }
    return this.snapshot();
  }

  hasDate(date) {
    const request = this.requestForDate(date);
    return Boolean(request && this.store.inspect(request).status === "ready");
  }

  readyAhead(startIndex = null) {
    if (!this.scope) return 0;
    const start = Number.isInteger(startIndex) ? startIndex : this.scope.cursorIndex + 1;
    let count = 0;
    for (let index = Math.max(0, start); index < this.scope.dates.length; index += 1) {
      if (!this.hasDate(this.scope.dates[index])) break;
      count += 1;
    }
    return count;
  }

  readinessRequirement(startIndex = null) {
    if (!this.scope) return 0;
    const start = Number.isInteger(startIndex) ? startIndex : this.scope.cursorIndex + 1;
    const remaining = Math.max(0, this.scope.dates.length - Math.max(0, start));
    return Math.min(remaining, 1);
  }

  releasePinnedFrames() {
    for (const frameKey of this.pinnedFrames.values()) {
      this.store.release?.(frameKey, this.pinOwner);
    }
    this.pinnedFrames.clear();
  }

  syncRetainedFrames(options = this.options()) {
    if (!this.scope || options.bufferUnit !== "calendar_month" || typeof this.store.pin !== "function") {
      this.releasePinnedFrames();
      return 0;
    }
    const desired = new Map(this.windowRequests(options).map((request) => (
      [this.frameIdentity.intentKey(request), request]
    )));
    for (const [intentKey, frameKey] of [...this.pinnedFrames.entries()]) {
      if (desired.has(intentKey)) continue;
      this.store.release?.(frameKey, this.pinOwner);
      this.pinnedFrames.delete(intentKey);
    }
    for (const [intentKey, request] of desired.entries()) {
      const inspected = this.store.inspect(request);
      if (inspected.status !== "ready" || !inspected.frameKey) {
        const staleFrameKey = this.pinnedFrames.get(intentKey);
        if (staleFrameKey) this.store.release?.(staleFrameKey, this.pinOwner);
        this.pinnedFrames.delete(intentKey);
        continue;
      }
      const previousFrameKey = this.pinnedFrames.get(intentKey);
      if (previousFrameKey && previousFrameKey !== inspected.frameKey) {
        this.store.release?.(previousFrameKey, this.pinOwner);
      }
      if (this.store.pin(inspected.frameKey, this.pinOwner)) {
        this.pinnedFrames.set(intentKey, inspected.frameKey);
      }
    }
    return this.pinnedFrames.size;
  }

  windowRequests(options = this.options()) {
    if (!this.scope) return [];
    if (options.bufferUnit === "calendar_month") {
      return this.scope.dates
        .slice(options.calendarWindowStartIndex, options.calendarWindowEndIndex)
        .map((date) => this.requestForDate(date));
    }
    const { targetWatermark, windowBehind } = options;
    const start = Math.max(0, this.scope.cursorIndex - windowBehind);
    const end = Math.min(this.scope.dates.length, this.scope.cursorIndex + targetWatermark + 1);
    return this.scope.dates.slice(start, end).map((date) => this.requestForDate(date));
  }

  cancelScheduledReconcile() {
    if (this.reconcileTimer === null) return false;
    this.clock.cancel(this.reconcileTimer);
    this.reconcileTimer = null;
    return true;
  }

  scheduleReconcile() {
    if (!this.scope) return false;
    if (this.reconcileTimer !== null) {
      this.scope.coalescedReconciles += 1;
      return false;
    }
    const scopeId = this.scope.id;
    this.reconcileTimer = this.clock.schedule(() => {
      this.reconcileTimer = null;
      if (this.scope?.id === scopeId) this.reconcile();
    }, 0);
    return true;
  }

  reconcile({
    force = false,
    bypassSettle = false,
    bypassDecreaseHysteresis = false,
    pruneQueued = false,
  } = {}) {
    this.cancelScheduledReconcile();
    if (!this.scope?.dates.length || !this.scope.requestContext.bbox) return this.snapshot();
    if (this.scopeSettleTimer && !bypassSettle) return this.snapshot();
    this.scope.reconcileRuns += 1;
    const options = this.options({ bypassDecreaseHysteresis });
    const {
      highWatermark,
      lowWatermark,
      targetWatermark,
      maxPendingFrames,
      immediateReplenishment,
      tailMode,
      supplyRatio,
      remainingSlices,
    } = options;
    this.syncRetainedFrames(options);
    if (pruneQueued) {
      const cancelled = this.cancelQueryScopes(this.scope, { includeActive: false });
      if (cancelled > 0) {
        this.eventLog?.record?.("PREHEATER_PENDING_PRUNED", {
          scope_id: this.scope.id,
          scope_key: this.frameIdentity.scopeKey(this.scope.requestContext),
          dataset: this.scope.requestContext.datasetId,
          date: this.scope.anchorDate,
          cancelled_consumers: cancelled,
          high_watermark: highWatermark,
          reason: "playback_rate_decreased",
        });
      }
    }
    const readyAhead = this.readyAhead();
    this.scope.readyAhead = readyAhead;
    const wasReplenishing = this.scope.replenishing;
    const decision = evaluatePlaybackReplenishment({
      readyAhead,
      lowWatermark,
      targetWatermark,
      force,
      tailMode,
      immediateReplenishment,
      wasReplenishing,
      previousTrigger: this.scope.replenishmentReason,
    });
    this.scope.replenishing = decision.replenishing;
    const trigger = decision.trigger;
    this.scope.replenishmentReason = trigger;
    if (!wasReplenishing && this.scope.replenishing) {
      this.eventLog?.record?.("PREHEATER_REFILL_STARTED", {
        scope_id: this.scope.id,
        scope_key: this.frameIdentity.scopeKey(this.scope.requestContext),
        dataset: this.scope.requestContext.datasetId,
        date: this.scope.anchorDate,
        trigger,
        ready_ahead: readyAhead,
        low_watermark: lowWatermark,
        high_watermark: highWatermark,
        target_watermark: targetWatermark,
        remaining_slices: remainingSlices,
        supply_ratio: supplyRatio,
      });
    } else if (wasReplenishing && !this.scope.replenishing) {
      this.eventLog?.record?.("PREHEATER_REFILL_COMPLETED", {
        scope_id: this.scope.id,
        scope_key: this.frameIdentity.scopeKey(this.scope.requestContext),
        dataset: this.scope.requestContext.datasetId,
        date: this.scope.anchorDate,
        ready_ahead: readyAhead,
        target_watermark: targetWatermark,
        remaining_slices: remainingSlices,
      });
    }
    if (!this.scope.replenishing) {
      this.syncState("READY");
      return this.snapshot();
    }

    const capacity = Math.max(0, maxPendingFrames - this.inflight.size);
    if (capacity === 0) {
      this.syncState("FETCHING");
      return this.snapshot();
    }

    const now = this.clock.now();
    const missing = this.windowRequests(options).filter((request) => {
      const key = this.frameIdentity.intentKey(request);
      const inspected = this.store.inspect(request);
      const retryAt = Number(this.retryAfter.get(key) || 0);
      return inspected.status !== "ready"
        && !this.inflight.has(key)
        && (force || inspected.status !== "failed" || retryAt <= now);
    }).slice(0, capacity);
    if (!missing.length) {
      const retryPending = this.windowRequests(options).some((request) => (
        Number(this.retryAfter.get(this.frameIdentity.intentKey(request)) || 0) > now
      ));
      this.syncState(this.inflight.size ? "FETCHING" : retryPending ? "DEGRADED" : "READY");
      if (retryPending) this.scheduleRetry();
      return this.snapshot();
    }
    const scopeId = this.scope.id;
    this.scope.scheduledTotal += missing.length;
    this.syncState("FETCHING");
    const intentKeys = missing.map((request) => this.frameIdentity.intentKey(request));
    const promise = this.demandService.demandMany(missing, {
      lane: "playback-window",
      scopeId,
      rangeMode: options.bufferUnit === "calendar_month" ? "calendar_month" : "individual",
      onProgress: ({ ok, request, error }) => {
        const intentKey = this.frameIdentity.intentKey(request);
        if (ok) {
          this.retryAfter.delete(intentKey);
          return;
        }
        if (error?.name !== "AbortError" && this.ownsQueryScope(scopeId)) {
          this.scope.failed += 1;
          this.retryAfter.set(intentKey, this.clock.now() + 5000);
        }
      },
    })
      .catch(() => null)
      .finally(() => {
        for (const intentKey of intentKeys) {
          if (this.inflight.get(intentKey) === promise) this.inflight.delete(intentKey);
        }
        if (!this.ownsQueryScope(scopeId)) return;
        const hasRetry = [...this.retryAfter.values()].some((retryAt) => (
          Number(retryAt || 0) > this.clock.now()
        ));
        this.syncState(
          this.inflight.size
            ? "FETCHING"
            : hasRetry
              ? "DEGRADED"
              : this.scope.replenishing
                ? "FETCHING"
                : "READY",
        );
        if (hasRetry) this.scheduleRetry();
        else if (this.scope.replenishing) this.scheduleReconcile();
      });
    for (const intentKey of intentKeys) this.inflight.set(intentKey, promise);
    return this.snapshot();
  }

  scheduleRetry() {
    if (!this.scope || this.retryTimer) return;
    const scopeId = this.scope.id;
    const candidates = this.windowRequests()
      .map((request) => Number(this.retryAfter.get(this.frameIdentity.intentKey(request)) || 0))
      .filter((value) => value > this.clock.now());
    if (!candidates.length) return;
    const delay = Math.max(25, Math.min(...candidates) - this.clock.now());
    this.retryTimer = this.clock.schedule(() => {
      this.retryTimer = null;
      if (this.scope?.id === scopeId) this.reconcile();
    }, delay);
  }

  demandTarget(date, { scopeId = "playback-engine" } = {}) {
    const request = this.requestForDate(date);
    if (!request) return Promise.reject(new Error("Playback target is outside the active preheater scope"));
    return this.demandService.demand(request, {
      lane: "playback-target",
      scopeId,
      consumerId: `target:${date}`,
    });
  }

  async waitForDates(dates, {
    lane = "playback-target",
    scopeId = "playback-startup",
    signal = null,
  } = {}) {
    const requests = (dates || []).map((date) => this.requestForDate(date)).filter(Boolean);
    const progress = { total: requests.length, completed: 0, cacheHits: 0, fetched: 0, failed: 0 };
    const chunkSize = this.options().maxPendingFrames;
    for (let index = 0; index < requests.length; index += chunkSize) {
      if (signal?.aborted) throw this.demandService.abortError?.() || Object.assign(new Error("Playback gate changed"), { name: "AbortError" });
      const chunk = await this.demandService.demandMany(
        requests.slice(index, index + chunkSize),
        { lane, scopeId, signal },
      );
      progress.completed += Number(chunk.completed || 0);
      progress.cacheHits += Number(chunk.cacheHits || 0);
      progress.fetched += Number(chunk.fetched || 0);
      progress.failed += Number(chunk.failed || 0);
      if (progress.failed > 0) break;
    }
    return progress;
  }

  handleStoreChange(change) {
    if (!this.scope || !["committed", "evicted"].includes(change?.type)) return;
    if (String(change.datasetId || "") !== this.scope.requestContext.datasetId) return;
    if (change.date && !this.scope.dates.includes(String(change.date))) return;
    this.syncRetainedFrames(this.options());
    this.scheduleReconcile();
  }

  syncState(status) {
    if (!this.scope) return;
    this.scope.status = status;
    this.stateSink?.(this.snapshot());
  }

  stop(reason = "scope_stopped") {
    this.cancelQueryScopes(this.scope, { includeActive: true });
    this.eventLog?.record?.("PREHEATER_STOPPED", {
      scope_id: this.scope?.id || "",
      reason,
    });
    this.inflight.clear();
    this.retryAfter.clear();
    this.clock.cancel(this.retryTimer);
    this.retryTimer = null;
    this.clock.cancel(this.scopeSettleTimer);
    this.scopeSettleTimer = null;
    this.cancelScheduledReconcile();
    this.releasePinnedFrames();
    this.scope = null;
    this.stateSink?.(this.snapshot());
  }

  snapshot() {
    if (!this.scope) return Object.freeze({ status: "STOPPED", readyAhead: 0, inflight: 0 });
    return Object.freeze({
      id: this.scope.id,
      signature: this.scope.signature,
      status: this.scope.status,
      datasetId: this.scope.requestContext.datasetId,
      scopeKey: this.frameIdentity.scopeKey(this.scope.requestContext),
      bbox: this.scope.requestContext.bbox,
      resolution: this.scope.requestContext.resolution ?? null,
      queryResolution: this.frameIdentity.queryResolution(this.scope.requestContext),
      anchorDate: this.scope.anchorDate,
      cursorIndex: this.scope.cursorIndex,
      frameCount: this.scope.dates.length,
      readyAhead: this.scope.readyAhead,
      inflight: this.inflight.size,
      queued: this.inflight.size,
      scheduledTotal: this.scope.scheduledTotal,
      failed: this.scope.failed,
      pinnedFrameCount: this.pinnedFrames.size,
      replenishing: this.scope.replenishing,
      scopeSettlePending: Boolean(this.scopeSettleTimer),
      reconcilePending: this.reconcileTimer !== null,
      reconcileRuns: this.scope.reconcileRuns,
      coalescedReconciles: this.scope.coalescedReconciles,
      ...this.options(),
    });
  }

  dispose() {
    this.stop("disposed");
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.evaluatePlaybackReplenishment = evaluatePlaybackReplenishment;
  globalThis.playbackCalendarMonthKey = playbackCalendarMonthKey;
  globalThis.playbackCalendarMonthWindow = playbackCalendarMonthWindow;
  globalThis.normalizedPlaybackCacheCapacityPolicy = normalizedPlaybackCacheCapacityPolicy;
  globalThis.PlaybackPreheaterController = PlaybackPreheaterController;
}
