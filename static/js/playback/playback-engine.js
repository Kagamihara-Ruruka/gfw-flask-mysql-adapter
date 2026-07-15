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
    this.runId = "";
    this.targetRuns = new Map();
    this.bufferStartedAt = null;
    this.bufferIntentKey = "";
    this.displayedFrameKey = "";
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
      this.cancelBuffer("scope_changed", { dataset: previousDataset, date: previousDate });
      this.releaseDisplayedFrame();
      if (this.runId) {
        this.status = previousStatus === "BUFFERING" ? "PLAYING" : previousStatus;
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

  start(metadata = {}) {
    if (!this.dates.length || !this.requestContext) return false;
    this.cancelBuffer("restarted");
    if (this.runId) this.eventLog.endRun({ run_id: this.runId, reason: "restarted" });
    this.runId = this.eventLog.beginRun({
      kind: "playback",
      dataset: this.requestContext.datasetId,
      start_date: this.dates[0],
      end_date: this.dates[this.dates.length - 1],
      frame_count: this.dates.length,
      ...metadata,
    });
    this.status = "PLAYING";
    return true;
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
    this.cancelBuffer(reason);
    this.status = reason === "ended" ? "ENDED" : "IDLE";
    if (this.runId) this.eventLog.endRun({ run_id: this.runId, reason });
    this.runId = "";
  }

  cancelBuffer(reason = "cancelled", detail = {}) {
    if (this.bufferStartedAt === null) return false;
    const endedAt = this.clock.now();
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
    return true;
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
    if (inspected.status === "ready") return Promise.resolve(inspected);
    const intentKey = inspected.request ? this.frameIdentity.intentKey(inspected.request) : "";
    if (!intentKey) return Promise.reject(new Error("Playback target is outside the configured scope"));
    if (this.targetRuns.has(intentKey)) return this.targetRuns.get(intentKey).promise;

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
      this.eventLog.record("BUFFER_ENTERED", {
        run_id: this.runId,
        intent_key: intentKey,
        dataset: inspected.request.datasetId,
        date: inspected.date,
        monotonic_ms: this.bufferStartedAt,
      });
    }
    const promise = this.demandService.demand(inspected.request, {
      lane: "playback-target",
      signal: controller.signal,
      scopeId: `playback:${this.runId || "idle"}`,
      consumerId: `target:${inspected.date}`,
    }).then((result) => {
      const resumedAt = this.clock.now();
      if (this.status === "BUFFERING") this.status = "PLAYING";
      this.eventLog.record("BUFFER_RESUMED", {
        run_id: this.runId,
        intent_key: intentKey,
        frame_key: result.frameKey,
        dataset: inspected.request.datasetId,
        date: inspected.date,
        duration_ms: this.bufferStartedAt === null ? 0 : Math.max(0, resumedAt - this.bufferStartedAt),
        monotonic_ms: resumedAt,
      });
      this.bufferStartedAt = null;
      this.bufferIntentKey = "";
      return { ...result, request: inspected.request, date: inspected.date, index };
    }).catch((error) => {
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
    const inspected = this.inspectTarget(index);
    if (inspected.status !== "ready") return false;
    this.currentIndex = index;
    this.status = "PLAYING";
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

  snapshot() {
    return Object.freeze({
      status: this.status,
      runId: this.runId,
      datasetId: this.requestContext?.datasetId || "",
      currentIndex: this.currentIndex,
      currentDate: this.dates[this.currentIndex] || "",
      frameCount: this.dates.length,
      targetInflight: this.targetRuns.size,
      displayedFrameKey: this.displayedFrameKey,
      bufferStartedMonotonicMs: this.bufferStartedAt,
      bufferIntentKey: this.bufferIntentKey,
      bufferWaitMs: this.bufferWaitMs(),
      preheater: this.preheater.snapshot(),
    });
  }

  dispose() {
    this.stop("disposed");
    this.releaseDisplayedFrame();
  }
}

if (typeof globalThis !== "undefined") globalThis.PlaybackEngineCore = PlaybackEngineCore;
