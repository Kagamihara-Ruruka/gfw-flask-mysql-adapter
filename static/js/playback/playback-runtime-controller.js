class PlaybackRuntimeController {
  constructor({ engine, preheater, clock, scheduler } = {}) {
    if (!engine || !preheater || !clock || !scheduler) {
      throw new TypeError("PlaybackRuntimeController requires engine, preheater, clock and scheduler");
    }
    if (typeof clock.now !== "function" || typeof clock.schedule !== "function" || typeof clock.cancel !== "function") {
      throw new TypeError("PlaybackRuntimeController requires a playback clock");
    }
    this.engine = engine;
    this.preheater = preheater;
    this.clock = clock;
    this.scheduler = scheduler;
    this.generation = 0;
    this.timeline = null;
    this.timer = null;
    this.session = null;
    this.suspensionReasons = new Set();
  }

  isActive() {
    return ["PREPARING", "PLAYING", "BUFFERING"].includes(
      String(this.lifecycleSnapshot()?.status || "IDLE"),
    );
  }

  lifecycleSnapshot() {
    return this.engine.snapshot();
  }

  configure(options) {
    return this.engine.configure(options);
  }

  inspectTarget(index) {
    return this.engine.inspectTarget(index);
  }

  requireTarget(index) {
    return this.engine.requireTarget(index);
  }

  bufferGate() {
    return this.engine.bufferGate();
  }

  bufferWaitMs() {
    return this.engine.bufferWaitMs();
  }

  markRenderStarted(index) {
    return this.engine.markRenderStarted(index);
  }

  markFrameVisible(index, detail) {
    return this.engine.markFrameVisible(index, detail);
  }

  releaseDisplayedFrame() {
    return this.engine.releaseDisplayedFrame?.();
  }

  nextGeneration() {
    this.generation += 1;
    return this.generation;
  }

  isGenerationActive(generation) {
    return this.generation === generation;
  }

  startTimeline(generation, { firstDelayMs = 0 } = {}) {
    if (!this.session || !this.isGenerationActive(generation)) return null;
    const currentIndex = Number(this.session.currentIndexProvider?.() ?? -1);
    this.timeline = this.scheduler.start({
      generation,
      intervalMs: this.session.intervalMs,
      rate: this.session.rate,
      stepMode: this.session.stepMode,
      baseDateIndex: currentIndex,
      nowMs: this.clock.now(),
      firstDelayMs,
    });
    return this.timeline;
  }

  activeTimeline(generation) {
    if (this.timeline?.generation === generation) return this.timeline;
    return this.startTimeline(generation);
  }

  targetIndex(generation, frameNumber) {
    const timeline = this.activeTimeline(generation);
    if (!timeline || !this.session) return -1;
    return this.scheduler.targetDateIndex(timeline, {
      datesLength: Number(this.session.datesLengthProvider?.() || 0),
      currentIndex: Number(this.session.currentIndexProvider?.() ?? -1),
      frameNumber,
    });
  }

  shift(deltaMs) {
    if (!this.timeline) return;
    this.scheduler.shift(this.timeline, Math.max(0, Number(deltaMs || 0)));
  }

  schedule(generation = this.generation) {
    this.clock.cancel(this.timer);
    this.timer = null;
    const timeline = this.activeTimeline(generation);
    if (
      !timeline
      || !this.session
      || this.suspensionReasons.size
      || !this.isActive()
      || !this.isGenerationActive(generation)
    ) return;
    const delayMs = this.scheduler.delayUntilNextFrame(timeline, {
      nowMs: this.clock.now(),
      fallbackIntervalMs: this.session.intervalMs,
    });
    this.timer = this.clock.schedule(async () => {
      this.timer = null;
      if (
        this.suspensionReasons.size
        || !this.isActive()
        || !this.isGenerationActive(generation)
        || !this.session
      ) return;
      try {
        const frameNumber = this.scheduler.dueFrameNumber(timeline, {
          nowMs: this.clock.now(),
          fallbackIntervalMs: this.session.intervalMs,
        });
        const targetIndex = this.targetIndex(generation, frameNumber);
        const result = await this.session.onFrameDue?.({
          frameNumber,
          generation,
          stepMode: timeline.stepMode,
          targetIndex,
        }) || {};
        if (result.buffering) {
          this.shift(this.session.bufferPollMs);
          this.schedule(generation);
          return;
        }
        if (result.failed) {
          const onTerminal = this.session.onTerminal;
          this.stop({ clearPreheater: false, reason: "failed" });
          onTerminal?.({ reason: "failed", result });
          return;
        }
        if (!result.advanced && result.done) {
          const onTerminal = this.session.onTerminal;
          this.stop({ clearPreheater: false, reason: "ended" });
          onTerminal?.({ reason: "ended", result });
          return;
        }
        if (!result.advanced) {
          const onTerminal = this.session.onTerminal;
          this.stop({ clearPreheater: false, reason: "stopped" });
          onTerminal?.({ reason: "stopped", result });
          return;
        }
        this.scheduler.markFrameShown(timeline, { frameNumber });
        if (this.isActive() && this.isGenerationActive(generation)) this.schedule(generation);
      } catch (error) {
        const onError = this.session?.onError;
        this.stop({ clearPreheater: false, reason: "failed" });
        onError?.(error);
      }
    }, Math.max(0, Number(delayMs || 0)));
  }

  async start({
    prepare,
    configure,
    engineOptions,
    rate,
    intervalMs,
    stepMode,
    currentIndexProvider,
    datesLengthProvider,
    onFrameDue,
    onTerminal,
    onError,
    bufferPollMs = 180,
  } = {}) {
    const generation = this.nextGeneration();
    this.clock.cancel(this.timer);
    this.timer = null;
    this.timeline = null;
    this.suspensionReasons.clear();
    this.session = {
      bufferPollMs: Math.max(1, Number(bufferPollMs || 180)),
      currentIndexProvider,
      datesLengthProvider,
      intervalMs: Math.max(1, Number(intervalMs || 1)),
      onError,
      onFrameDue,
      onTerminal,
      rate: Math.max(0.25, Number(rate || 1)),
      stepMode: stepMode === "fluid" ? "fluid" : "sequential",
    };
    if (typeof prepare === "function" && !(await prepare())) {
      if (this.isGenerationActive(generation)) this.stop({ reason: "prepare_cancelled" });
      return false;
    }
    if (!this.isGenerationActive(generation)) return false;
    this.engine.configure(configure || {});
    const started = await this.engine.start(engineOptions || {});
    if (!started || !this.isGenerationActive(generation) || !this.isActive()) {
      if (this.isGenerationActive(generation)) this.stop({ reason: "prepare_cancelled" });
      return false;
    }
    this.startTimeline(generation);
    this.schedule(generation);
    return true;
  }

  updateRate({ consumptionRate = null, rate, intervalMs, stepMode } = {}) {
    if (!this.session) return false;
    this.session.rate = Math.max(0.25, Number(rate || 1));
    this.session.intervalMs = Math.max(1, Number(intervalMs || 1));
    this.session.stepMode = stepMode === "fluid" ? "fluid" : "sequential";
    this.engine.updatePlaybackRate?.({
      rate: this.session.rate,
      interval_ms: this.session.intervalMs,
      consumption_rate: consumptionRate,
    });
    if (!this.isActive()) return false;
    this.startTimeline(this.generation, { firstDelayMs: this.session.intervalMs });
    this.schedule(this.generation);
    return true;
  }

  suspend({ reason = "suspended" } = {}) {
    if (!this.session || !this.isActive()) return false;
    const normalizedReason = String(reason || "suspended");
    const wasSuspended = this.suspensionReasons.size > 0;
    this.suspensionReasons.add(normalizedReason);
    if (!wasSuspended) {
      this.clock.cancel(this.timer);
      this.timer = null;
    }
    return !wasSuspended;
  }

  resume({ reason = "suspended" } = {}) {
    const normalizedReason = String(reason || "suspended");
    const removed = this.suspensionReasons.delete(normalizedReason);
    this.preheater.reconcile?.({ force: true });
    if (
      !removed
      || this.suspensionReasons.size
      || !this.session
      || !this.isActive()
    ) return false;
    this.startTimeline(this.generation, { firstDelayMs: this.session.intervalMs });
    this.schedule(this.generation);
    return true;
  }

  stop({ clearPreheater = false, reason = "stopped" } = {}) {
    const wasActive = Boolean(this.isActive() || this.timer || this.timeline);
    this.nextGeneration();
    this.clock.cancel(this.timer);
    this.timer = null;
    this.timeline = null;
    this.session = null;
    this.suspensionReasons.clear();
    if (clearPreheater) this.preheater.stop?.(reason);
    if (wasActive || this.lifecycleSnapshot()?.runId) this.engine.stop(reason);
    return wasActive;
  }

  snapshot() {
    return Object.freeze({
      active: this.isActive(),
      generation: this.generation,
      hasTimer: Boolean(this.timer),
      suspended: this.suspensionReasons.size > 0,
      suspensionReasons: Object.freeze([...this.suspensionReasons]),
      timeline: this.timeline ? Object.freeze({ ...this.timeline }) : null,
    });
  }

  dispose() {
    this.stop({ clearPreheater: true, reason: "disposed" });
  }
}

globalThis.PlaybackRuntimeController = PlaybackRuntimeController;
