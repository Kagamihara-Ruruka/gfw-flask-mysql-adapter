class PlaybackEngineCore {
  constructor({ store, demandService, preheater, eventLog, frameIdentity, clock } = {}) {
    if (!store || !demandService || !preheater || !eventLog || !frameIdentity || !clock) {
      throw new TypeError("PlaybackEngine requires store, demand service, preheater, event log, identity and clock");
    }
    if (typeof clock.now !== "function") throw new TypeError("PlaybackEngine requires a monotonic clock");
    this.store = store;
    this.demandService = demandService;
    this.preheater = preheater;
    this.eventLog = eventLog;
    this.frameIdentity = frameIdentity;
    this.clock = clock;
    this.dates = [];
    this.requestContext = null;
    this.currentIndex = -1;
    this.status = "IDLE";
    this.consumptionRate = 0;
    this.runId = "";
    this.targetRuns = new Map();
    this.bufferStartedAt = null;
    this.bufferIntentKey = "";
    this.bufferTargetIndex = -1;
    this.bufferScopeId = "";
    this.bufferRequired = 0;
    this.bufferReady = 0;
    this.bufferPolicyReason = "";
    this.prepareSequence = 0;
    this.prepareStartedAt = null;
    this.prepareScopeId = "";
    this.prepareRequired = 0;
    this.prepareReady = 0;
    this.preparePolicyReason = "";
    this.prepareWaitController = null;
    this.bufferWaitController = null;
    this.displayedFrameKey = "";
    this.unsubscribeEventLog = this.eventLog.subscribe?.((event) => {
      this.handleLifecycleEvent(event);
    }, { emitCurrent: false }) || null;
  }

  handleLifecycleEvent(event) {
    if (event?.type !== "CACHE_READY" || !this.requestContext) return;
    const scopeKey = this.frameIdentity.scopeKey(this.requestContext);
    if (event.scope_key && event.scope_key !== scopeKey) return;
    const requestedResolution = Number(event.requested_resolution_km);
    const effectiveQueryResolution = Number(event.effective_query_resolution_km);
    const actualResolution = Number(event.actual_resolution_km);
    const activeRequestedResolution = Number(this.requestContext.resolution);
    const activeQueryResolution = Number(this.frameIdentity.queryResolution(this.requestContext));
    const resolvedQueryResolution = Number.isFinite(effectiveQueryResolution) && effectiveQueryResolution > 0
      ? effectiveQueryResolution
      : actualResolution;
    if (Number.isFinite(resolvedQueryResolution)
      && resolvedQueryResolution > 0
      && Number.isFinite(requestedResolution)
      && Number.isFinite(activeRequestedResolution)
      && requestedResolution === activeRequestedResolution
      && resolvedQueryResolution !== activeQueryResolution) {
      this.adoptResolvedQueryResolution(resolvedQueryResolution, { reason: "cache_ready_fallback" });
    }
    this.refreshActiveReadiness();
  }

  adoptResolvedQueryResolution(resolution, { reason = "source_resolution_resolved" } = {}) {
    const effectiveQueryResolution = Number(resolution);
    if (!this.requestContext || !Number.isFinite(effectiveQueryResolution) || effectiveQueryResolution <= 0) return false;
    const requestedResolution = Number(this.requestContext.resolution);
    const previousQueryResolution = Number(this.frameIdentity.queryResolution(this.requestContext));
    if (Number.isFinite(previousQueryResolution) && previousQueryResolution === effectiveQueryResolution) return false;
    const previousScope = this.frameIdentity.scopeKey(this.requestContext);
    this.requestContext = this.frameIdentity.normalizeRequest({
      ...this.requestContext,
      date: this.dates[this.currentIndex] || this.requestContext.date || "",
      queryResolution: effectiveQueryResolution,
    });
    this.preheater.adoptRequestContext?.(this.requestContext, { reason });
    this.eventLog.record("PLAYBACK_QUERY_RESOLUTION_ADOPTED", {
      run_id: this.runId,
      previous_scope: previousScope,
      scope_id: this.frameIdentity.scopeKey(this.requestContext),
      dataset: this.requestContext.datasetId,
      date: this.dates[this.currentIndex] || "",
      requested_resolution_km: Number.isFinite(requestedResolution) ? requestedResolution : null,
      previous_effective_query_resolution_km: Number.isFinite(previousQueryResolution)
        ? previousQueryResolution
        : null,
      effective_query_resolution_km: effectiveQueryResolution,
      reason,
    });
    return true;
  }

  refreshActiveReadiness() {
    if (this.status === "PREPARING") {
      const startIndex = Math.max(0, this.currentIndex + 1);
      this.prepareReady = this.preheater.readyAhead?.(startIndex) || 0;
      if (this.prepareReady >= this.prepareRequired) {
        this.prepareWaitController?.abort?.();
      }
      return true;
    }
    if (this.status === "BUFFERING" && this.bufferTargetIndex >= 0) {
      this.bufferReady = this.preheater.readyAhead?.(this.bufferTargetIndex) || 0;
      if (this.bufferReady >= this.bufferRequired) {
        this.bufferWaitController?.abort?.();
      }
      return true;
    }
    return false;
  }

  configure({ dates = [], requestContext = {}, currentDate = "" } = {}) {
    const previousScope = this.requestContext ? this.frameIdentity.scopeKey(this.requestContext) : "";
    const previousStatus = this.status;
    const previousDataset = this.requestContext?.datasetId || "";
    const previousDate = this.dates[this.currentIndex] || "";
    const normalizedDates = [...new Set(dates.filter(Boolean))].sort();
    const nextContext = this.frameIdentity.normalizeRequest({
      ...requestContext,
      date: currentDate || normalizedDates[0] || "",
    });
    const nextScope = this.frameIdentity.scopeKey(nextContext);
    if (previousScope && previousScope !== nextScope) {
      for (const target of this.targetRuns.values()) target.controller?.abort?.();
      this.targetRuns.clear();
      this.cancelPreparation("scope_changed", { dataset: previousDataset, date: previousDate });
      this.cancelBuffer("scope_changed", { dataset: previousDataset, date: previousDate });
      this.releaseDisplayedFrame();
      if (this.runId) {
        this.status = previousStatus === "BUFFERING"
          ? "PLAYING"
          : previousStatus === "PREPARING"
            ? "PAUSED"
            : previousStatus;
        this.eventLog.record("PLAYBACK_SCOPE_CHANGED", {
          run_id: this.runId,
          previous_scope: previousScope,
          scope_id: nextScope,
          dataset: nextContext.datasetId,
          date: currentDate,
        });
      }
    }
    this.dates = normalizedDates;
    this.requestContext = nextContext;
    const requestedIndex = normalizedDates.indexOf(currentDate);
    this.currentIndex = requestedIndex >= 0 ? requestedIndex : (normalizedDates.length ? 0 : -1);
    this.preheater.setScope({
      dates: this.dates,
      requestContext: this.requestContext,
      anchorDate: this.dates[this.currentIndex] || currentDate,
    });
    return this.snapshot();
  }

  async start(metadata = {}) {
    if (!this.dates.length || !this.requestContext) return false;
    this.consumptionRate = Math.max(0, Number(metadata.consumption_rate || 0));
    this.preheater.activate?.();
    this.cancelPreparation("restarted");
    this.cancelBuffer("restarted");
    if (this.runId) this.eventLog.endRun({ run_id: this.runId, reason: "restarted" });
    this.runId = this.eventLog.beginRun({
      kind: "playback",
      dataset: this.requestContext.datasetId,
      scope_key: this.frameIdentity.scopeKey(this.requestContext),
      start_date: this.dates[0],
      end_date: this.dates[this.dates.length - 1],
      frame_count: this.dates.length,
      ...metadata,
    });
    const token = ++this.prepareSequence;
    const startIndex = Math.max(0, this.currentIndex + 1);
    const startedAt = this.clock.now();
    this.status = "PREPARING";
    this.prepareStartedAt = startedAt;
    this.prepareScopeId = `playback-startup:${this.runId}`;
    this.prepareRequired = 0;
    this.prepareReady = this.preheater.readyAhead?.(startIndex) || 0;
    const initialGate = this.readinessGate("startup", startIndex);
    this.prepareRequired = initialGate.required;
    this.preparePolicyReason = initialGate.degradationReason;
    this.eventLog.record("PREPARE_STARTED", {
      run_id: this.runId,
      dataset: this.requestContext.datasetId,
      date: this.dates[startIndex] || this.dates[this.currentIndex] || "",
      ready_slices: this.prepareReady,
      required_slices: this.prepareRequired,
      policy_reason: initialGate.policyReason,
      degradation_reason: initialGate.degradationReason,
      monotonic_ms: startedAt,
    });

    try {
      while (token === this.prepareSequence && this.status === "PREPARING") {
        const gate = this.readinessGate("startup", startIndex);
        this.prepareRequired = this.prepareRequired > 0
          ? Math.min(this.prepareRequired, gate.required)
          : gate.required;
        this.prepareReady = this.preheater.readyAhead?.(startIndex) || 0;
        this.preparePolicyReason = gate.degradationReason;
        if (this.prepareReady >= this.prepareRequired) break;
        const requestedDates = this.dates.slice(startIndex, startIndex + this.prepareRequired);
        const waitController = new AbortController();
        this.prepareWaitController = waitController;
        let progress;
        try {
          progress = await this.preheater.waitForDates(requestedDates, {
            lane: "playback-window",
            scopeId: this.prepareScopeId,
            signal: waitController.signal,
          });
        } catch (error) {
          if (error?.name === "AbortError" && token === this.prepareSequence && this.status === "PREPARING") {
            continue;
          }
          throw error;
        } finally {
          if (this.prepareWaitController === waitController) this.prepareWaitController = null;
        }
        if (token !== this.prepareSequence || this.status !== "PREPARING") return false;
        this.prepareReady = this.preheater.readyAhead?.(startIndex) || 0;
        this.eventLog.record("PREPARE_PROGRESS", {
          run_id: this.runId,
          dataset: this.requestContext.datasetId,
          date: this.dates[startIndex] || "",
          ready_slices: this.prepareReady,
          required_slices: this.prepareRequired,
          failed_slices: Number(progress?.failed || 0),
          degradation_reason: this.preparePolicyReason,
        });
        if (Number(progress?.failed || 0) > 0 && this.prepareReady < this.prepareRequired) {
          throw new Error(`Startup buffer failed for ${Number(progress.failed)} frame(s)`);
        }
      }
      if (token !== this.prepareSequence || this.status !== "PREPARING") return false;
      const readyAt = this.clock.now();
      this.status = "PLAYING";
      this.eventLog.record("PREPARE_READY", {
        run_id: this.runId,
        dataset: this.requestContext.datasetId,
        date: this.dates[startIndex] || this.dates[this.currentIndex] || "",
        ready_slices: this.prepareReady,
        required_slices: this.prepareRequired,
        duration_ms: Math.max(0, readyAt - startedAt),
        degradation_reason: this.preparePolicyReason,
        monotonic_ms: readyAt,
      });
      this.prepareStartedAt = null;
      this.prepareScopeId = "";
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || token !== this.prepareSequence) return false;
      const failedAt = this.clock.now();
      this.status = "FAILED";
      this.eventLog.record("PREPARE_FAILED", {
        run_id: this.runId,
        dataset: this.requestContext.datasetId,
        date: this.dates[startIndex] || "",
        ready_slices: this.prepareReady,
        required_slices: this.prepareRequired,
        duration_ms: Math.max(0, failedAt - startedAt),
        error: error?.message || String(error),
        monotonic_ms: failedAt,
      });
      if (this.prepareScopeId) {
        this.demandService.cancelScope?.(this.prepareScopeId, { includeActive: true });
      }
      this.prepareStartedAt = null;
      this.prepareScopeId = "";
      throw error;
    }
  }

  pause(reason = "paused") {
    if (this.status === "IDLE") return;
    this.status = "PAUSED";
    this.eventLog.record("PLAYBACK_PAUSED", { run_id: this.runId, reason });
  }

  stop(reason = "stopped") {
    for (const target of this.targetRuns.values()) {
      target.controller?.abort?.();
    }
    this.targetRuns.clear();
    this.cancelPreparation(reason);
    this.cancelBuffer(reason);
    this.status = reason === "ended" ? "ENDED" : "IDLE";
    if (this.runId) this.eventLog.endRun({ run_id: this.runId, reason });
    this.runId = "";
  }

  cancelPreparation(reason = "cancelled", detail = {}) {
    if (this.prepareStartedAt === null) return false;
    const endedAt = this.clock.now();
    this.prepareSequence += 1;
    if (this.prepareScopeId) {
      this.demandService.cancelScope?.(this.prepareScopeId, { includeActive: true });
    }
    this.prepareWaitController?.abort?.();
    this.prepareWaitController = null;
    this.eventLog.record("PREPARE_CANCELLED", {
      run_id: this.runId,
      dataset: detail.dataset || this.requestContext?.datasetId || "",
      date: detail.date || this.dates[this.currentIndex + 1] || this.dates[this.currentIndex] || "",
      ready_slices: this.prepareReady,
      required_slices: this.prepareRequired,
      duration_ms: Math.max(0, endedAt - this.prepareStartedAt),
      reason,
      ...detail,
      monotonic_ms: endedAt,
    });
    this.prepareStartedAt = null;
    this.prepareScopeId = "";
    return true;
  }

  cancelBuffer(reason = "cancelled", detail = {}) {
    if (this.bufferStartedAt === null) return false;
    const endedAt = this.clock.now();
    if (this.bufferScopeId) {
      this.demandService.cancelScope?.(this.bufferScopeId, { includeActive: true });
    }
    this.bufferWaitController?.abort?.();
    this.bufferWaitController = null;
    this.eventLog.record("BUFFER_CANCELLED", {
      run_id: this.runId,
      intent_key: this.bufferIntentKey,
      dataset: detail.dataset || this.requestContext?.datasetId || "",
      date: detail.date || this.dates[this.currentIndex + 1] || this.dates[this.currentIndex] || "",
      duration_ms: Math.max(0, endedAt - this.bufferStartedAt),
      reason,
      ...detail,
      monotonic_ms: endedAt,
    });
    this.bufferStartedAt = null;
    this.bufferIntentKey = "";
    this.bufferTargetIndex = -1;
    this.bufferScopeId = "";
    this.bufferRequired = 0;
    this.bufferReady = 0;
    this.bufferPolicyReason = "";
    return true;
  }

  readinessGate(kind, startIndex) {
    const remaining = Math.max(0, this.dates.length - Math.max(0, startIndex));
    const policy = this.preheater.snapshot?.() || {};
    return Object.freeze({
      kind,
      remaining,
      required: Math.min(remaining, 1),
      policyReason: "next_frame_ready",
      degradationReason: String(policy.degradationReason || ""),
    });
  }

  updatePlaybackRate({ rate = 1, interval_ms = 0, consumption_rate = 0 } = {}) {
    const normalizedRate = Math.max(0.25, Number(rate || 1));
    const normalizedConsumption = Math.max(0, Number(consumption_rate || 0));
    const previousConsumption = this.consumptionRate;
    const rateDecreased = previousConsumption > 0
      && normalizedConsumption > 0
      && normalizedConsumption < previousConsumption;
    this.consumptionRate = normalizedConsumption;
    if (this.runId) {
      this.eventLog.record("PLAYBACK_RATE_CHANGED", {
        run_id: this.runId,
        rate: normalizedRate,
        interval_ms: Math.max(0, Number(interval_ms || 0)),
        consumption_rate: normalizedConsumption,
      });
    }
    this.preheater.reconcile?.({
      force: rateDecreased,
      bypassDecreaseHysteresis: rateDecreased,
      pruneQueued: rateDecreased,
    });
    return this.snapshot();
  }

  bufferGate() {
    const active = this.bufferStartedAt !== null && this.bufferTargetIndex >= 0;
    if (!active) return Object.freeze({ active: false, ready: true, readyCount: 0, required: 0 });
    this.bufferReady = this.preheater.readyAhead?.(this.bufferTargetIndex) || 0;
    return Object.freeze({
      active: true,
      ready: this.bufferReady >= this.bufferRequired,
      readyCount: this.bufferReady,
      required: this.bufferRequired,
      targetIndex: this.bufferTargetIndex,
      degradationReason: this.bufferPolicyReason,
    });
  }

  requestForIndex(index) {
    const date = this.dates[index];
    if (!date || !this.requestContext) return null;
    return this.frameIdentity.normalizeRequest({ ...this.requestContext, date });
  }

  inspectTarget(index) {
    const request = this.requestForIndex(index);
    if (!request) return { status: "missing", request: null, packet: null, frameKey: "" };
    const inspected = this.store.inspect(request);
    return { ...inspected, request, date: request.date, index };
  }

  requireTarget(index) {
    const inspected = this.inspectTarget(index);
    const intentKey = inspected.request ? this.frameIdentity.intentKey(inspected.request) : "";
    if (intentKey && this.targetRuns.has(intentKey)) return this.targetRuns.get(intentKey).promise;
    if (inspected.status === "ready") return Promise.resolve(inspected);
    if (!intentKey) return Promise.reject(new Error("Playback target is outside the configured scope"));

    const controller = new AbortController();
    this.eventLog.record("TARGET_REQUIRED", {
      run_id: this.runId,
      intent_key: intentKey,
      dataset: inspected.request.datasetId,
      date: inspected.date,
    });
    if (this.status !== "BUFFERING") {
      this.status = "BUFFERING";
      this.bufferStartedAt = this.clock.now();
      this.bufferIntentKey = intentKey;
      this.bufferTargetIndex = index;
      this.bufferScopeId = `playback-buffer:${this.runId || "idle"}:${inspected.date}`;
      const gate = this.readinessGate("resume", index);
      this.bufferRequired = gate.required;
      this.bufferReady = this.preheater.readyAhead?.(index) || 0;
      this.bufferPolicyReason = gate.degradationReason;
      this.eventLog.record("BUFFER_ENTERED", {
        run_id: this.runId,
        intent_key: intentKey,
        dataset: inspected.request.datasetId,
        date: inspected.date,
        ready_slices: this.bufferReady,
        required_slices: this.bufferRequired,
        policy_reason: gate.policyReason,
        degradation_reason: gate.degradationReason,
        monotonic_ms: this.bufferStartedAt,
      });
    }
    const targetPromise = this.demandService.demand(inspected.request, {
      lane: "playback-target",
      signal: controller.signal,
      scopeId: `playback:${this.runId || "idle"}`,
      consumerId: `target:${inspected.date}`,
    });
    const promise = (async () => {
      const result = await targetPromise;
      while (this.bufferStartedAt !== null && this.bufferIntentKey === intentKey) {
        const gate = this.readinessGate("resume", index);
        this.bufferRequired = this.bufferRequired > 0
          ? Math.min(this.bufferRequired, gate.required)
          : gate.required;
        this.bufferPolicyReason = gate.degradationReason;
        this.bufferReady = this.preheater.readyAhead?.(index) || 0;
        if (this.bufferReady >= this.bufferRequired) break;
        const waitController = new AbortController();
        this.bufferWaitController = waitController;
        let progress;
        try {
          progress = await this.preheater.waitForDates(
            this.dates.slice(index, index + this.bufferRequired),
            {
              lane: "playback-window",
              scopeId: this.bufferScopeId,
              signal: waitController.signal,
            },
          );
        } catch (error) {
          if (
            error?.name === "AbortError"
            && this.bufferStartedAt !== null
            && this.bufferIntentKey === intentKey
          ) {
            continue;
          }
          throw error;
        } finally {
          if (this.bufferWaitController === waitController) this.bufferWaitController = null;
        }
        this.bufferReady = this.preheater.readyAhead?.(index) || 0;
        if (Number(progress?.failed || 0) > 0 && this.bufferReady < this.bufferRequired) {
          throw new Error(`Resume buffer failed for ${Number(progress.failed)} frame(s)`);
        }
      }
      const resumedAt = this.clock.now();
      if (this.status === "BUFFERING") this.status = "PLAYING";
      this.eventLog.record("BUFFER_RESUMED", {
        run_id: this.runId,
        intent_key: intentKey,
        frame_key: result.frameKey,
        dataset: inspected.request.datasetId,
        date: inspected.date,
        ready_slices: this.bufferReady,
        required_slices: this.bufferRequired,
        degradation_reason: this.bufferPolicyReason,
        duration_ms: this.bufferStartedAt === null ? 0 : Math.max(0, resumedAt - this.bufferStartedAt),
        monotonic_ms: resumedAt,
      });
      this.bufferStartedAt = null;
      this.bufferIntentKey = "";
      this.bufferTargetIndex = -1;
      this.bufferScopeId = "";
      this.bufferRequired = 0;
      this.bufferReady = 0;
      this.bufferPolicyReason = "";
      return { ...result, request: inspected.request, date: inspected.date, index };
    })().catch((error) => {
      if (error?.name !== "AbortError") {
        this.cancelBuffer("target_failed", {
          dataset: inspected.request.datasetId,
          date: inspected.date,
        });
        this.status = "FAILED";
        this.eventLog.record("PLAYBACK_TARGET_FAILED", {
          run_id: this.runId,
          intent_key: intentKey,
          dataset: inspected.request.datasetId,
          date: inspected.date,
          error: error?.message || String(error),
        });
      }
      throw error;
    }).finally(() => {
      this.targetRuns.delete(intentKey);
    });
    this.targetRuns.set(intentKey, { promise, controller });
    return promise;
  }

  markFrameVisible(index, { renderMs = 0 } = {}) {
    if (["PREPARING", "BUFFERING"].includes(this.status)) return false;
    const inspected = this.inspectTarget(index);
    if (inspected.status !== "ready") return false;
    this.currentIndex = index;
    if (inspected.frameKey !== this.displayedFrameKey) {
      this.store.pin(inspected.frameKey, "renderer-current");
      if (this.displayedFrameKey) this.store.release(this.displayedFrameKey, "renderer-current");
      this.displayedFrameKey = inspected.frameKey;
    }
    this.preheater.setPlayhead({ date: inspected.date, index });
    this.eventLog.record("FRAME_VISIBLE", {
      run_id: this.runId,
      intent_key: inspected.intentKey,
      frame_key: inspected.frameKey,
      dataset: inspected.request.datasetId,
      date: inspected.date,
      index,
      render_ms: Number(renderMs || 0),
    });
    return true;
  }

  markRenderStarted(index) {
    const inspected = this.inspectTarget(index);
    this.eventLog.record("RENDER_STARTED", {
      run_id: this.runId,
      intent_key: inspected.intentKey || "",
      frame_key: inspected.frameKey || "",
      dataset: inspected.request?.datasetId || this.requestContext?.datasetId || "",
      date: inspected.date || this.dates[index] || "",
      index,
    });
  }

  releaseDisplayedFrame() {
    if (!this.displayedFrameKey) return false;
    const released = this.store.release(this.displayedFrameKey, "renderer-current");
    this.displayedFrameKey = "";
    return released;
  }

  bufferWaitMs() {
    return this.bufferStartedAt === null ? 0 : Math.max(0, this.clock.now() - this.bufferStartedAt);
  }

  preparationWaitMs() {
    return this.prepareStartedAt === null ? 0 : Math.max(0, this.clock.now() - this.prepareStartedAt);
  }

  currentStatus() {
    return this.status;
  }

  snapshot() {
    if (this.prepareStartedAt !== null) {
      this.prepareReady = this.preheater.readyAhead?.(Math.max(0, this.currentIndex + 1)) || 0;
    }
    return Object.freeze({
      status: this.status,
      runId: this.runId,
      datasetId: this.requestContext?.datasetId || "",
      scopeKey: this.requestContext ? this.frameIdentity.scopeKey(this.requestContext) : "",
      currentIndex: this.currentIndex,
      currentDate: this.dates[this.currentIndex] || "",
      frameCount: this.dates.length,
      targetInflight: this.targetRuns.size,
      displayedFrameKey: this.displayedFrameKey,
      bufferStartedMonotonicMs: this.bufferStartedAt,
      bufferIntentKey: this.bufferIntentKey,
      bufferWaitMs: this.bufferWaitMs(),
      bufferGate: this.bufferGate(),
      preparationStartedMonotonicMs: this.prepareStartedAt,
      preparationWaitMs: this.preparationWaitMs(),
      preparationReady: this.prepareReady,
      preparationRequired: this.prepareRequired,
      preparationDegradationReason: this.preparePolicyReason,
      preheater: this.preheater.snapshot(),
    });
  }

  dispose() {
    this.unsubscribeEventLog?.();
    this.unsubscribeEventLog = null;
    this.stop("disposed");
    this.releaseDisplayedFrame();
  }
}

if (typeof globalThis !== "undefined") globalThis.PlaybackEngineCore = PlaybackEngineCore;
