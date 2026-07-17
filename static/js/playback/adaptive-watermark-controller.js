function normalizedFixedWatermarkPolicy(policy = {}) {
  const highWatermark = Math.max(2, Math.round(adaptiveNumber(
    policy.highWatermark ?? policy.windowAhead,
    15,
    { minimum: 2 },
  )));
  const lowWatermark = Math.max(1, Math.min(
    highWatermark - 1,
    Math.round(adaptiveNumber(policy.lowWatermark, 10, { minimum: 1 })),
  ));
  return Object.freeze({
    highWatermark,
    lowWatermark,
    windowBehind: Math.max(0, Math.round(adaptiveNumber(policy.windowBehind, 1, { minimum: 0 }))),
  });
}

function adaptiveNumber(value, fallback, { minimum = -Infinity, maximum = Infinity } = {}) {
  const parsed = Number(value);
  const finite = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.min(maximum, Math.max(minimum, finite));
}

function calculateAdaptiveWatermarkPolicy({
  fixedPolicy = {},
  metrics = {},
  cacheSnapshot = {},
  config = {},
  remainingSlices = 0,
} = {}) {
  const fixed = normalizedFixedWatermarkPolicy(fixedPolicy);
  const adaptive = config.adaptiveWatermark || {};
  const consumptionRate = Math.max(0, Number(metrics.consumption_rate || 0));
  const supplyRate = Math.max(0, Number(metrics.supply_rate || 0));
  const latencyP95Ms = Math.max(0, Number(metrics.cache_ready_latency_p95 || 0));
  const playbackStatus = String(metrics.playback_status || "").toUpperCase();
  const preparing = !playbackStatus || ["IDLE", "PREPARING"].includes(playbackStatus);
  const supplySamples = Math.max(0, Number(metrics.supply_samples || 0));
  const latencySamples = Math.max(0, Number(metrics.cache_ready_latency_samples || 0));
  const remaining = Math.max(0, Math.round(Number(remainingSlices || 0)));
  const minimumSupplySamples = Math.max(2, Math.round(adaptiveNumber(
    adaptive.minimumSupplySamples,
    2,
    { minimum: 2 },
  )));
  const trustworthy = consumptionRate > 0
    && supplyRate > 0
    && supplySamples >= minimumSupplySamples
    && latencySamples >= 1;

  const defaultFrameBytes = adaptiveNumber(
    adaptive.defaultFrameBytes,
    4 * 1024 * 1024,
    { minimum: 512 },
  );
  const observedFrameBytes = Number(
    cacheSnapshot.estimatedFrameBytes || cacheSnapshot.averageFrameBytes || 0,
  );
  const hasObservedFrameSize = Number.isFinite(observedFrameBytes) && observedFrameBytes > 0;
  const estimatedFrameBytes = adaptiveNumber(
    hasObservedFrameSize ? observedFrameBytes : defaultFrameBytes,
    defaultFrameBytes,
    { minimum: 512 },
  );
  const maxBytes = Math.max(0, Number(cacheSnapshot.maxBytes || 0));
  const maxEntries = Math.max(0, Number(cacheSnapshot.maxEntries || 0));
  const playbackRamBudgetBytes = maxBytes > 0 ? Math.floor(maxBytes * 0.5) : 0;
  const byteCapacity = hasObservedFrameSize && playbackRamBudgetBytes > 0
    ? Math.max(2, Math.floor(playbackRamBudgetBytes / estimatedFrameBytes))
    : null;
  const entryCapacity = maxEntries > 0 ? Math.max(2, maxEntries) : null;
  const rawAdaptiveCapacity = byteCapacity === null
    ? null
    : entryCapacity === null
      ? byteCapacity
      : Math.min(byteCapacity, entryCapacity);
  const ramBudgetFrames = rawAdaptiveCapacity === null
    ? null
    : Math.max(2, rawAdaptiveCapacity);
  const configuredHigh = ramBudgetFrames === null
    ? fixed.highWatermark
    : Math.max(2, Math.floor((ramBudgetFrames * 2) / 3));
  const configuredLow = ramBudgetFrames === null
    ? Math.max(1, Math.min(configuredHigh - 1, fixed.lowWatermark))
    : Math.max(1, Math.min(configuredHigh - 1, Math.floor(ramBudgetFrames / 3)));
  const supplyRatio = consumptionRate > 0 && supplyRate > 0
    ? supplyRate / consumptionRate
    : null;
  const tailMode = remaining > 0 && remaining < configuredLow;

  if (tailMode) {
    return Object.freeze({
      strategy: "adaptive",
      status: "TAIL",
      reason: "terminal_tail",
      lowWatermark: configuredLow,
      highWatermark: configuredHigh,
      candidateLowWatermark: configuredLow,
      candidateHighWatermark: configuredHigh,
      targetWatermark: remaining,
      immediateReplenishment: true,
      tailMode: true,
      ramBudgetFrames,
      playbackRamBudgetBytes,
      hasObservedFrameSize,
      estimatedFrameBytes,
      consumptionRate,
      supplyRate,
      supplyRatio,
      latencyP95Ms,
      supplySamples,
      latencySamples,
      tailDemandSlices: 0,
      deficitCoverageSlices: 0,
      remainingSlices: remaining,
      supplyDeficitFactor: 1,
      sustainable: null,
      degradationReason: "",
      minimumSupplySamples,
      preparing,
    });
  }

  if (!trustworthy) {
    return Object.freeze({
      strategy: "adaptive",
      status: "WARMING",
      reason: "insufficient_metrics",
      lowWatermark: configuredLow,
      highWatermark: configuredHigh,
      candidateLowWatermark: configuredLow,
      candidateHighWatermark: configuredHigh,
      targetWatermark: configuredHigh,
      immediateReplenishment: false,
      tailMode: false,
      ramBudgetFrames,
      playbackRamBudgetBytes,
      hasObservedFrameSize,
      estimatedFrameBytes,
      consumptionRate,
      supplyRate,
      supplyRatio,
      latencyP95Ms,
      supplySamples,
      latencySamples,
      tailDemandSlices: 0,
      deficitCoverageSlices: 0,
      remainingSlices: remaining,
      supplyDeficitFactor: 1,
      sustainable: null,
      degradationReason: "insufficient_metrics",
      minimumSupplySamples,
      preparing,
    });
  }

  const latencySafetyFactor = adaptiveNumber(
    adaptive.latencySafetyFactor,
    1.35,
    { minimum: 1, maximum: 4 },
  );
  const reserveSlices = Math.max(0, Math.round(adaptiveNumber(
    adaptive.reserveSlices,
    2,
    { minimum: 0, maximum: configuredHigh },
  )));
  const maxSupplyDeficitFactor = adaptiveNumber(
    adaptive.maxSupplyDeficitFactor,
    2,
    { minimum: 1, maximum: 4 },
  );
  const supplyDeficitFactor = Math.min(
    maxSupplyDeficitFactor,
    Math.max(1, consumptionRate / supplyRate),
  );
  const tailDemandSlices = Math.ceil(
    consumptionRate * (latencyP95Ms / 1000) * latencySafetyFactor * supplyDeficitFactor,
  );
  const latencySafetySlices = Math.ceil(
    consumptionRate * (latencyP95Ms / 1000) * latencySafetyFactor,
  );
  const sustainable = supplyRate >= consumptionRate;
  const supplyDeficitRatio = consumptionRate > 0
    ? Math.max(0, 1 - Math.min(1, supplyRate / consumptionRate))
    : 0;
  const deficitCoverageSlices = Math.ceil(remaining * supplyDeficitRatio) + latencySafetySlices;
  const candidateHighWatermark = configuredHigh;
  const candidateLowWatermark = configuredLow;

  return Object.freeze({
    strategy: "adaptive",
    status: "ADAPTIVE",
    reason: supplyRatio < 1 ? "supply_deficit" : "trusted_metrics",
    lowWatermark: candidateLowWatermark,
    highWatermark: candidateHighWatermark,
    candidateLowWatermark,
    candidateHighWatermark,
    targetWatermark: candidateHighWatermark,
    immediateReplenishment: supplyRatio < 1,
    tailMode: false,
    ramBudgetFrames,
    playbackRamBudgetBytes,
    hasObservedFrameSize,
    estimatedFrameBytes,
    consumptionRate,
    supplyRate,
    supplyRatio,
    latencyP95Ms,
    supplySamples,
    latencySamples,
    tailDemandSlices,
    deficitCoverageSlices,
    remainingSlices: remaining,
    supplyDeficitFactor,
    sustainable,
    degradationReason: sustainable ? "" : "supply_below_consumption",
    minimumSupplySamples,
    preparing,
  });
}

class AdaptiveWatermarkControllerCore {
  constructor({
    metricsProvider,
    cacheSnapshotProvider,
    configProvider,
    eventLog,
    clock,
  } = {}) {
    if (
      typeof metricsProvider !== "function"
      || typeof cacheSnapshotProvider !== "function"
      || typeof configProvider !== "function"
      || !eventLog
      || !clock
      || typeof clock.now !== "function"
    ) {
      throw new TypeError("AdaptiveWatermarkController requires metrics, cache, config, event log and clock");
    }
    this.metricsProvider = metricsProvider;
    this.cacheSnapshotProvider = cacheSnapshotProvider;
    this.configProvider = configProvider;
    this.eventLog = eventLog;
    this.clock = clock;
    this.current = null;
    this.lastIncreaseAt = null;
    this.lastDecreaseAt = null;
    this.disposed = false;
  }

  strategy(config = this.configProvider() || {}) {
    return String(config.watermarkStrategy || "adaptive").toLowerCase() === "fixed"
      ? "fixed"
      : "adaptive";
  }

  fixedPolicy(fixedPolicy = {}) {
    const fixed = normalizedFixedWatermarkPolicy(fixedPolicy);
    return Object.freeze({
      strategy: "fixed",
      status: "FIXED",
      reason: "configured",
      ...fixed,
      candidateLowWatermark: fixed.lowWatermark,
      candidateHighWatermark: fixed.highWatermark,
      targetWatermark: fixed.highWatermark,
      immediateReplenishment: false,
      tailMode: false,
      supplyRatio: null,
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
      tailDemandSlices: 0,
      deficitCoverageSlices: 0,
      remainingSlices: 0,
      supplyDeficitFactor: 1,
      sustainable: null,
      degradationReason: "",
    });
  }

  preview({
    fixedPolicy = {},
    remainingSlices = 0,
    scopeKey = "",
    datasetId = "",
    cacheNamespace = "",
    bbox = "",
    resolution = null,
  } = {}) {
    const config = this.configProvider() || {};
    const strategy = this.strategy(config);
    if (strategy === "fixed") return this.fixedPolicy(fixedPolicy);
    const context = { scopeKey, datasetId, cacheNamespace, bbox, resolution };
    const metrics = this.metricsProvider(context) || {};
    if (
      this.current?.strategy === strategy
      && this.current.scopeKey === String(metrics.scope_key || scopeKey || "")
    ) return this.current;
    return calculateAdaptiveWatermarkPolicy({
      fixedPolicy,
      metrics,
      cacheSnapshot: this.cacheSnapshotProvider(context) || {},
      config,
      remainingSlices,
    });
  }

  applyHysteresis(candidate, config, now, { bypassDecreaseHysteresis = false } = {}) {
    const previous = this.current;
    if (!previous || previous.strategy !== candidate.strategy) return candidate;
    if (candidate.strategy !== "adaptive") return candidate;
    if (candidate.runId !== previous.runId || candidate.scopeKey !== previous.scopeKey) return candidate;
    if (candidate.highWatermark >= previous.highWatermark) return candidate;
    if (
      candidate.ramBudgetFrames !== null
      && (previous.ramBudgetFrames === null || candidate.ramBudgetFrames < previous.ramBudgetFrames)
    ) return candidate;
    if (bypassDecreaseHysteresis) return candidate;

    const adaptive = config.adaptiveWatermark || {};
    const decreaseHoldMs = adaptiveNumber(
      adaptive.decreaseHoldMs,
      15_000,
      { minimum: 0, maximum: 300_000 },
    );
    const decreaseStep = Math.max(1, Math.round(adaptiveNumber(
      adaptive.decreaseStep,
      2,
      { minimum: 1, maximum: 30 },
    )));
    const decreaseStepIntervalMs = adaptiveNumber(
      adaptive.decreaseStepIntervalMs,
      1000,
      { minimum: 0, maximum: 60_000 },
    );
    const raisedAt = this.lastIncreaseAt ?? previous.appliedMonotonicMs ?? now;
    if (now - raisedAt < decreaseHoldMs) {
      const highWatermark = previous.highWatermark;
      return Object.freeze({
        ...candidate,
        status: candidate.status === "ADAPTIVE" ? "HOLDING" : candidate.status,
        reason: "decrease_hysteresis",
        highWatermark,
        lowWatermark: Math.min(previous.lowWatermark, highWatermark - 1),
        targetWatermark: candidate.tailMode ? candidate.targetWatermark : highWatermark,
      });
    }
    if (this.lastDecreaseAt !== null && now - this.lastDecreaseAt < decreaseStepIntervalMs) {
      const highWatermark = previous.highWatermark;
      return Object.freeze({
        ...candidate,
        status: candidate.status === "ADAPTIVE" ? "HOLDING" : candidate.status,
        reason: "decrease_interval",
        highWatermark,
        lowWatermark: Math.min(previous.lowWatermark, highWatermark - 1),
        targetWatermark: candidate.tailMode ? candidate.targetWatermark : highWatermark,
      });
    }
    const highWatermark = Math.max(candidate.highWatermark, previous.highWatermark - decreaseStep);
    return Object.freeze({
      ...candidate,
      reason: highWatermark === candidate.highWatermark ? candidate.reason : "decrease_step",
      highWatermark,
      lowWatermark: Math.max(1, Math.min(
        highWatermark - 1,
        candidate.lowWatermark,
      )),
      targetWatermark: candidate.tailMode ? candidate.targetWatermark : highWatermark,
    });
  }

  resolve({
    fixedPolicy = {},
    remainingSlices = 0,
    scopeKey = "",
    datasetId = "",
    cacheNamespace = "",
    bbox = "",
    resolution = null,
    bypassDecreaseHysteresis = false,
  } = {}) {
    if (this.disposed) return this.current || this.fixedPolicy(fixedPolicy);
    const now = this.clock.now();
    const config = this.configProvider() || {};
    const context = { scopeKey, datasetId, cacheNamespace, bbox, resolution };
    const metrics = this.metricsProvider(context) || {};
    const runId = String(metrics.run_id || "");
    const effectiveScopeKey = String(metrics.scope_key || scopeKey || "");
    const strategy = this.strategy(config);
    const rawCandidate = strategy === "fixed"
      ? this.fixedPolicy(fixedPolicy)
      : calculateAdaptiveWatermarkPolicy({
        fixedPolicy,
        metrics,
        cacheSnapshot: this.cacheSnapshotProvider(context) || {},
        config,
        remainingSlices,
      });
    const candidate = Object.freeze({ ...rawCandidate, runId, scopeKey: effectiveScopeKey });
    const effective = this.applyHysteresis(candidate, config, now, { bypassDecreaseHysteresis });
    const previous = this.current;
    const raised = previous && effective.highWatermark > previous.highWatermark;
    const lowered = previous && effective.highWatermark < previous.highWatermark;
    const identityChanged = !previous
      || previous.runId !== effective.runId
      || previous.scopeKey !== effective.scopeKey;
    if (raised || identityChanged) {
      this.lastIncreaseAt = now;
      this.lastDecreaseAt = null;
    } else if (lowered) {
      this.lastDecreaseAt = now;
    }
    const changed = !previous
      || previous.strategy !== effective.strategy
      || previous.status !== effective.status
      || previous.lowWatermark !== effective.lowWatermark
      || previous.highWatermark !== effective.highWatermark
      || previous.targetWatermark !== effective.targetWatermark
      || previous.immediateReplenishment !== effective.immediateReplenishment
      || previous.tailMode !== effective.tailMode
      || previous.degradationReason !== effective.degradationReason
      || previous.runId !== effective.runId
      || previous.scopeKey !== effective.scopeKey;
    this.current = Object.freeze({
      ...effective,
      appliedMonotonicMs: changed ? now : previous.appliedMonotonicMs,
    });
    if (changed) {
      this.eventLog.record("WATERMARK_POLICY_CHANGED", {
        run_id: this.current.runId,
        scope_key: this.current.scopeKey,
        strategy: this.current.strategy,
        policy_status: this.current.status,
        reason: this.current.reason,
        low_watermark: this.current.lowWatermark,
        high_watermark: this.current.highWatermark,
        candidate_low_watermark: this.current.candidateLowWatermark,
        candidate_high_watermark: this.current.candidateHighWatermark,
        target_watermark: this.current.targetWatermark,
        immediate_replenishment: this.current.immediateReplenishment,
        tail_mode: this.current.tailMode,
        supply_ratio: this.current.supplyRatio,
        ram_budget_frames: this.current.ramBudgetFrames,
        playback_ram_budget_bytes: this.current.playbackRamBudgetBytes,
        estimated_frame_bytes: this.current.estimatedFrameBytes,
        consumption_rate: this.current.consumptionRate,
        supply_rate: this.current.supplyRate,
        cache_ready_latency_p95: this.current.latencyP95Ms,
        remaining_slices: this.current.remainingSlices,
        sustainable: this.current.sustainable,
        degradation_reason: this.current.degradationReason,
      });
    }
    return this.current;
  }

  reset(reason = "configuration_changed") {
    if (this.disposed) return;
    this.current = null;
    this.lastIncreaseAt = null;
    this.lastDecreaseAt = null;
    this.eventLog.record("WATERMARK_POLICY_RESET", { reason });
  }

  snapshot() {
    return this.current;
  }

  dispose() {
    this.disposed = true;
    this.current = null;
    this.lastIncreaseAt = null;
    this.lastDecreaseAt = null;
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.AdaptiveWatermarkControllerCore = AdaptiveWatermarkControllerCore;
  globalThis.calculateAdaptiveWatermarkPolicy = calculateAdaptiveWatermarkPolicy;
  globalThis.normalizedFixedWatermarkPolicy = normalizedFixedWatermarkPolicy;
}
