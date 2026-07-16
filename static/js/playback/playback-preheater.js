class PlaybackPreheaterController {
  constructor({
    store,
    demandService,
    eventLog,
    frameIdentity,
    clock,
    optionsProvider = null,
    watermarkPolicyProvider = null,
    stateSink = null,
  } = {}) {
    if (!store || !demandService || !eventLog || !frameIdentity || !clock) {
      throw new TypeError("PlaybackPreheater requires store, demand service, event log, identity and clock");
    }
    if (typeof clock.now !== "function" || typeof clock.schedule !== "function" || typeof clock.cancel !== "function") {
      throw new TypeError("PlaybackPreheater requires a schedulable monotonic clock");
    }
    this.store = store;
    this.demandService = demandService;
    this.eventLog = eventLog;
    this.frameIdentity = frameIdentity;
    this.clock = clock;
    this.optionsProvider = optionsProvider || (() => ({}));
    this.watermarkPolicyProvider = watermarkPolicyProvider;
    this.stateSink = stateSink;
    this.scope = null;
    this.scopeSequence = 0;
    this.inflight = new Map();
    this.retryAfter = new Map();
    this.retryTimer = null;
    this.scopeSettleTimer = null;
    this.unsubscribeStore = this.store.subscribe?.((change) => this.handleStoreChange(change)) || null;
  }

  options(policyContext = {}) {
    const cache = this.optionsProvider() || {};
    const highWatermark = Math.max(2, Number(cache.highWatermark ?? cache.windowAhead ?? 10));
    const lowWatermark = Math.max(1, Math.min(highWatermark - 1, Number(cache.lowWatermark ?? 5)));
    const fixedPolicy = {
      highWatermark,
      lowWatermark,
      maxPendingFrames: Math.max(1, Math.min(32, Number(cache.maxPendingFrames ?? 12))),
      startupWatermark: Math.max(1, Math.min(
        highWatermark,
        Number(cache.startupWatermark ?? lowWatermark),
      )),
      resumeWatermark: Math.max(2, Math.min(
        highWatermark,
        Number(cache.resumeWatermark ?? lowWatermark),
      )),
      windowBehind: Math.max(0, Number(cache.windowBehind ?? 1)),
      scopeSettleMs: Math.max(0, Number(cache.scopeSettleMs ?? 0)),
    };
    const requestContext = this.scope?.requestContext || {};
    const policy = this.watermarkPolicyProvider?.(fixedPolicy, {
      datasetId: requestContext.datasetId || "",
      scopeKey: this.scope ? this.frameIdentity.scopeKey(requestContext) : "",
      bbox: requestContext.bbox || "",
      resolution: requestContext.resolution ?? null,
      date: this.scope?.anchorDate || "",
      remainingSlices: this.scope
        ? Math.max(0, this.scope.dates.length - this.scope.cursorIndex - 1)
        : 0,
      ...policyContext,
    }) || fixedPolicy;
    const effectiveHigh = Math.max(2, Number(policy.highWatermark ?? highWatermark));
    const candidateStartupWatermark = Math.max(1, Number(
      policy.startupWatermark ?? fixedPolicy.startupWatermark,
    ));
    const effectiveStartupWatermark = Math.max(1, Math.min(
      effectiveHigh,
      fixedPolicy.maxPendingFrames,
      candidateStartupWatermark,
    ));
    const candidateResumeWatermark = Math.max(2, Number(
      policy.resumeWatermark ?? fixedPolicy.resumeWatermark,
    ));
    const effectiveResumeWatermark = Math.max(2, Math.min(
      effectiveHigh,
      fixedPolicy.maxPendingFrames,
      candidateResumeWatermark,
    ));
    return {
      ...fixedPolicy,
      highWatermark: effectiveHigh,
      lowWatermark: Math.max(1, Math.min(
        effectiveHigh - 1,
        Number(policy.lowWatermark ?? lowWatermark),
      )),
      windowBehind: fixedPolicy.windowBehind,
      startupWatermark: effectiveStartupWatermark,
      candidateStartupWatermark,
      startupWatermarkCapped: effectiveStartupWatermark < candidateStartupWatermark,
      resumeWatermark: effectiveResumeWatermark,
      candidateResumeWatermark,
      resumeWatermarkCapped: effectiveResumeWatermark < candidateResumeWatermark,
      strategy: policy.strategy || "fixed",
      policyStatus: policy.status || "FIXED",
      policyReason: policy.reason || "configured",
      candidateLowWatermark: Number(policy.candidateLowWatermark ?? lowWatermark),
      candidateHighWatermark: Number(policy.candidateHighWatermark ?? highWatermark),
      ramBudgetFrames: Number.isFinite(Number(policy.ramBudgetFrames))
        ? Number(policy.ramBudgetFrames)
        : null,
      estimatedFrameBytes: Math.max(0, Number(policy.estimatedFrameBytes || 0)),
      consumptionRate: Math.max(0, Number(policy.consumptionRate || 0)),
      supplyRate: Math.max(0, Number(policy.supplyRate || 0)),
      supplySamples: Math.max(0, Number(policy.supplySamples || 0)),
      latencyP95Ms: Math.max(0, Number(policy.latencyP95Ms || 0)),
      latencySamples: Math.max(0, Number(policy.latencySamples || 0)),
      minimumSupplySamples: Math.max(2, Number(policy.minimumSupplySamples || 2)),
      remainingSlices: Math.max(0, Number(policy.remainingSlices || 0)),
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
    this.scope.queryScopeIds = this.scope.queryScopeIds || new Set([previousScopeId]);
    this.scope.queryScopeIds.add(id);
    this.scope.id = id;
    this.scope.signature = signature;
    this.scope.requestContext = normalizedContext;
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
    this.cancelQueryScopes(this.scope, { includeActive: true });
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
      replenishing: true,
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

  windowRequests(options = this.options()) {
    if (!this.scope) return [];
    const { highWatermark, windowBehind } = options;
    const start = Math.max(0, this.scope.cursorIndex - windowBehind);
    const end = Math.min(this.scope.dates.length, this.scope.cursorIndex + highWatermark + 1);
    return this.scope.dates.slice(start, end).map((date) => this.requestForDate(date));
  }

  reconcile({
    force = false,
    bypassSettle = false,
    bypassDecreaseHysteresis = false,
    pruneQueued = false,
  } = {}) {
    if (!this.scope?.dates.length || !this.scope.requestContext.bbox) return this.snapshot();
    if (this.scopeSettleTimer && !bypassSettle) return this.snapshot();
    const options = this.options({ bypassDecreaseHysteresis });
    const { highWatermark, lowWatermark, maxPendingFrames } = options;
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
    if (force || readyAhead < lowWatermark) this.scope.replenishing = true;
    if (readyAhead >= highWatermark) this.scope.replenishing = false;
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
    for (const request of missing) {
      const intentKey = this.frameIdentity.intentKey(request);
      const promise = this.demandService.demand(request, {
        lane: "playback-window",
        scopeId,
        consumerId: `window:${request.date}`,
      })
        .then((result) => {
          this.retryAfter.delete(intentKey);
          return result;
        })
        .catch((error) => {
          if (error?.name !== "AbortError" && this.ownsQueryScope(scopeId)) {
            this.scope.failed += 1;
            this.retryAfter.set(intentKey, this.clock.now() + 5000);
          }
          return null;
        })
        .finally(() => {
          if (this.inflight.get(intentKey) === promise) this.inflight.delete(intentKey);
          if (!this.ownsQueryScope(scopeId)) return;
          this.scope.readyAhead = this.readyAhead();
          const hasRetry = this.windowRequests().some((candidate) => (
            Number(this.retryAfter.get(this.frameIdentity.intentKey(candidate)) || 0) > this.clock.now()
          ));
          this.syncState(this.inflight.size ? "FETCHING" : hasRetry ? "DEGRADED" : "READY");
          if (hasRetry) this.scheduleRetry();
          else if (this.scope.replenishing) queueMicrotask(() => this.reconcile());
        });
      this.inflight.set(intentKey, promise);
    }
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
    if (!this.scope || change?.type !== "committed") return;
    if (String(change.datasetId || "") !== this.scope.requestContext.datasetId) return;
    if (!this.scope.dates.includes(String(change.date || ""))) return;
    this.scope.readyAhead = this.readyAhead();
    this.reconcile();
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
      replenishing: this.scope.replenishing,
      scopeSettlePending: Boolean(this.scopeSettleTimer),
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
  globalThis.PlaybackPreheaterController = PlaybackPreheaterController;
}
