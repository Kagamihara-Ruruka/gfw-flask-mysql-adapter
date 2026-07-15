class PlaybackPreheaterController {
  constructor({
    store,
    demandService,
    eventLog,
    optionsProvider = null,
    stateSink = null,
  } = {}) {
    if (!store || !demandService || !eventLog) {
      throw new TypeError("PlaybackPreheater requires store, demandService and eventLog");
    }
    this.store = store;
    this.demandService = demandService;
    this.eventLog = eventLog;
    this.optionsProvider = optionsProvider || (() => ({}));
    this.stateSink = stateSink;
    this.scope = null;
    this.scopeSequence = 0;
    this.inflight = new Map();
    this.retryAfter = new Map();
    this.retryTimer = null;
    this.unsubscribeStore = this.store.subscribe?.((change) => this.handleStoreChange(change)) || null;
  }

  options() {
    const cache = this.optionsProvider() || {};
    const highWatermark = Math.max(2, Number(cache.highWatermark ?? cache.windowAhead ?? 10));
    const lowWatermark = Math.max(1, Math.min(highWatermark - 1, Number(cache.lowWatermark ?? 5)));
    return {
      highWatermark,
      lowWatermark,
      windowBehind: Math.max(0, Number(cache.windowBehind ?? 1)),
    };
  }

  scopeSignature({ dates = [], requestContext = {} } = {}) {
    return [
      FrameIdentity.scopeKey(requestContext),
      dates[0] || "",
      dates[dates.length - 1] || "",
      dates.length,
    ].join("|");
  }

  requestForDate(date) {
    if (!this.scope || !date) return null;
    return FrameIdentity.normalizeRequest({ ...this.scope.requestContext, date });
  }

  setScope({ dates = [], requestContext = {}, anchorDate = "" } = {}) {
    const normalizedDates = [...new Set(dates.filter(Boolean))].sort();
    const normalizedContext = FrameIdentity.normalizeRequest({ ...requestContext, date: anchorDate || normalizedDates[0] || "" });
    const signature = this.scopeSignature({ dates: normalizedDates, requestContext: normalizedContext });
    const cursorIndex = Math.max(0, normalizedDates.indexOf(anchorDate));
    if (this.scope?.signature === signature) {
      this.scope.cursorIndex = cursorIndex;
      this.scope.anchorDate = normalizedDates[cursorIndex] || anchorDate || "";
      this.reconcile();
      return this.snapshot();
    }
    if (this.scope?.id) this.demandService.cancelScope?.(this.scope.id, { includeActive: true });
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
    };
    this.eventLog?.record?.("PREHEATER_SCOPE_CHANGED", {
      scope_id: id,
      dataset: normalizedContext.datasetId,
      date: this.scope.anchorDate,
      frame_count: normalizedDates.length,
    });
    this.reconcile({ force: true });
    return this.snapshot();
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

  windowRequests() {
    if (!this.scope) return [];
    const { highWatermark, windowBehind } = this.options();
    const start = Math.max(0, this.scope.cursorIndex - windowBehind);
    const end = Math.min(this.scope.dates.length, this.scope.cursorIndex + highWatermark + 1);
    return this.scope.dates.slice(start, end).map((date) => this.requestForDate(date));
  }

  reconcile({ force = false } = {}) {
    if (!this.scope?.dates.length || !this.scope.requestContext.bbox) return this.snapshot();
    const { lowWatermark } = this.options();
    const readyAhead = this.readyAhead();
    this.scope.readyAhead = readyAhead;
    if (!force && readyAhead >= lowWatermark) {
      this.syncState("READY");
      return this.snapshot();
    }

    const now = Date.now();
    const missing = this.windowRequests().filter((request) => {
      const key = FrameIdentity.intentKey(request);
      const inspected = this.store.inspect(request);
      const retryAt = Number(this.retryAfter.get(key) || 0);
      return inspected.status !== "ready"
        && !this.inflight.has(key)
        && (force || inspected.status !== "failed" || retryAt <= now);
    });
    if (!missing.length) {
      const retryPending = this.windowRequests().some((request) => (
        Number(this.retryAfter.get(FrameIdentity.intentKey(request)) || 0) > now
      ));
      this.syncState(this.inflight.size ? "FETCHING" : retryPending ? "DEGRADED" : "READY");
      if (retryPending) this.scheduleRetry();
      return this.snapshot();
    }
    const scopeId = this.scope.id;
    this.scope.scheduledTotal += missing.length;
    this.syncState("FETCHING");
    for (const request of missing) {
      const intentKey = FrameIdentity.intentKey(request);
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
          if (error?.name !== "AbortError" && this.scope?.id === scopeId) {
            this.scope.failed += 1;
            this.retryAfter.set(intentKey, Date.now() + 5000);
          }
          return null;
        })
        .finally(() => {
          if (this.inflight.get(intentKey) === promise) this.inflight.delete(intentKey);
          if (this.scope?.id !== scopeId) return;
          this.scope.readyAhead = this.readyAhead();
          const hasRetry = this.windowRequests().some((candidate) => (
            Number(this.retryAfter.get(FrameIdentity.intentKey(candidate)) || 0) > Date.now()
          ));
          this.syncState(this.inflight.size ? "FETCHING" : hasRetry ? "DEGRADED" : "READY");
          if (hasRetry) this.scheduleRetry();
          else if (this.scope.readyAhead < this.options().lowWatermark) queueMicrotask(() => this.reconcile());
        });
      this.inflight.set(intentKey, promise);
    }
    return this.snapshot();
  }

  scheduleRetry() {
    if (!this.scope || this.retryTimer) return;
    const scopeId = this.scope.id;
    const candidates = this.windowRequests()
      .map((request) => Number(this.retryAfter.get(FrameIdentity.intentKey(request)) || 0))
      .filter((value) => value > Date.now());
    if (!candidates.length) return;
    const delay = Math.max(25, Math.min(...candidates) - Date.now());
    this.retryTimer = setTimeout(() => {
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

  async waitForDates(dates, { lane = "playback-target", scopeId = "playback-startup" } = {}) {
    const requests = (dates || []).map((date) => this.requestForDate(date)).filter(Boolean);
    return this.demandService.demandMany(requests, { lane, scopeId });
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
    if (this.scope?.id) this.demandService.cancelScope?.(this.scope.id, { includeActive: true });
    this.eventLog?.record?.("PREHEATER_STOPPED", {
      scope_id: this.scope?.id || "",
      reason,
    });
    this.inflight.clear();
    this.retryAfter.clear();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
      anchorDate: this.scope.anchorDate,
      cursorIndex: this.scope.cursorIndex,
      frameCount: this.scope.dates.length,
      readyAhead: this.scope.readyAhead,
      inflight: this.inflight.size,
      queued: this.inflight.size,
      scheduledTotal: this.scope.scheduledTotal,
      failed: this.scope.failed,
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
