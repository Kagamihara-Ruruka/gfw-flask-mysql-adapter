function normalizedFixedWatermarkPolicy(policy = {}) {
  const highWatermark = Math.max(2, Math.round(adaptiveNumber(
    policy.highWatermark ?? policy.windowAhead,
    10,
    { minimum: 2 },
  )));
  const lowWatermark = Math.max(1, Math.min(
    highWatermark - 1,
    Math.round(adaptiveNumber(policy.lowWatermark, 5, { minimum: 1 })),
  ));
  const startupWatermark = Math.max(1, Math.min(
    highWatermark,
    Math.round(adaptiveNumber(policy.startupWatermark, lowWatermark, { minimum: 1 })),
  ));
  const resumeWatermark = Math.max(2, Math.min(
    highWatermark,
    Math.round(adaptiveNumber(policy.resumeWatermark, lowWatermark, { minimum: 2 })),
  ));
  return Object.freeze({
    highWatermark,
    lowWatermark,
    startupWatermark,
    resumeWatermark,
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
  const startupPhase = !playbackStatus || ["IDLE", "PREPARING"].includes(playbackStatus);
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

  const maxHighWatermark = Math.max(
    fixed.highWatermark,
    Math.round(adaptiveNumber(adaptive.maxHighWatermark, 60, { minimum: 2 })),
  );
  const defaultFrameBytes = adaptiveNumber(
    adaptive.defaultFrameBytes,
    4 * 1024 * 1024,
    { minimum: 512 },
  );
  const observedFrameBytes = Number(
    cacheSnapshot.estimatedFrameBytes || cacheSnapshot.averageFrameBytes || 0,
  );
  const estimatedFrameBytes = adaptiveNumber(
    observedFrameBytes > 0 ? observedFrameBytes : defaultFrameBytes,
    defaultFrameBytes,
    { minimum: 512 },
  );
  const ramBudgetFraction = adaptiveNumber(
    adaptive.ramBudgetFraction,
    0.75,
    { minimum: 0.1, maximum: 1 },
  );
  const maxBytes = Math.max(0, Number(cacheSnapshot.maxBytes || 0));
  const maxEntries = Math.max(0, Number(cacheSnapshot.maxEntries || 0));
  const reservedFrames = fixed.windowBehind + 1;
  const byteCapacity = maxBytes > 0
    ? Math.floor((maxBytes * ramBudgetFraction) / estimatedFrameBytes)
    : Infinity;
  const entryCapacity = maxEntries > 0 ? maxEntries : Infinity;
  const rawRamBudgetFrames = Math.max(2, Math.min(
    Number.isFinite(byteCapacity) ? Math.max(2, byteCapacity - reservedFrames) : Infinity,
    Number.isFinite(entryCapacity) ? Math.max(2, entryCapacity - reservedFrames) : Infinity,
  ));
  const ramBudgetFrames = Number.isFinite(rawRamBudgetFrames) ? rawRamBudgetFrames : null;
  const effectiveHighCap = Math.min(maxHighWatermark, ramBudgetFrames ?? maxHighWatermark);

  if (!trustworthy) {
    const minimumStartupSamples = Math.max(2, Math.round(adaptiveNumber(
      adaptive.minimumStartupSamples,
      10,
      { minimum: 2, maximum: maxHighWatermark },
    )));
    const startupWatermark = startupPhase && remaining > 0
      ? Math.min(effectiveHighCap, remaining, Math.max(fixed.startupWatermark, minimumStartupSamples))
      : Math.min(fixed.startupWatermark, effectiveHighCap);
    return Object.freeze({
      strategy: "adaptive",
      status: "WARMING",
      reason: "insufficient_metrics",
      lowWatermark: Math.min(fixed.lowWatermark, effectiveHighCap - 1),
      highWatermark: Math.min(fixed.highWatermark, effectiveHighCap),
      candidateLowWatermark: Math.min(fixed.lowWatermark, effectiveHighCap - 1),
      candidateHighWatermark: Math.min(fixed.highWatermark, effectiveHighCap),
      startupWatermark,
      resumeWatermark: Math.min(fixed.resumeWatermark, effectiveHighCap),
      ramBudgetFrames,
      estimatedFrameBytes,
      consumptionRate,
      supplyRate,
      latencyP95Ms,
      supplySamples,
      latencySamples,
      tailDemandSlices: 0,
      startupDemandSlices: 0,
      remainingSlices: remaining,
      supplyDeficitFactor: 1,
      sustainable: null,
      degradationReason: "insufficient_metrics",
      minimumStartupSamples,
      minimumSupplySamples,
      startupPhase,
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
    { minimum: 0, maximum: maxHighWatermark },
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
  const startupDemandSlices = Math.ceil(remaining * supplyDeficitRatio) + latencySafetySlices;
  const candidateStartupWatermark = Math.max(
    fixed.startupWatermark,
    startupDemandSlices,
  );
  const protectedSlices = Math.max(
    tailDemandSlices + reserveSlices,
    startupPhase ? candidateStartupWatermark : 0,
  );
  const candidateHighWatermark = Math.max(2, Math.min(
    effectiveHighCap,
    Math.max(fixed.highWatermark, protectedSlices),
  ));
  const lowRatio = adaptiveNumber(adaptive.lowRatio, 0.5, { minimum: 0.1, maximum: 0.9 });
  const candidateLowWatermark = Math.max(1, Math.min(
    candidateHighWatermark - 1,
    Math.max(fixed.lowWatermark, Math.floor(candidateHighWatermark * lowRatio)),
  ));
  const startupWatermark = Math.max(1, Math.min(
    candidateHighWatermark,
    startupPhase ? candidateStartupWatermark : fixed.startupWatermark,
  ));
  const resumeWatermark = Math.max(2, Math.min(
    candidateHighWatermark,
    Math.max(fixed.resumeWatermark, tailDemandSlices + reserveSlices),
  ));
  const ramIsEffectiveCap = ramBudgetFrames !== null
    && ramBudgetFrames <= maxHighWatermark
    && protectedSlices > ramBudgetFrames;

  return Object.freeze({
    strategy: "adaptive",
    status: "ADAPTIVE",
    reason: ramIsEffectiveCap
      ? "ram_budget_capped"
      : protectedSlices > maxHighWatermark
        ? "max_watermark_capped"
        : "trusted_metrics",
    lowWatermark: candidateLowWatermark,
    highWatermark: candidateHighWatermark,
    candidateLowWatermark,
    candidateHighWatermark,
    startupWatermark,
    resumeWatermark,
    ramBudgetFrames,
    estimatedFrameBytes,
    consumptionRate,
    supplyRate,
    latencyP95Ms,
    supplySamples,
    latencySamples,
    tailDemandSlices,
    startupDemandSlices,
    remainingSlices: remaining,
    supplyDeficitFactor,
    sustainable,
    degradationReason: sustainable
      ? ""
      : startupPhase && candidateStartupWatermark > effectiveHighCap
        ? "startup_capacity_capped"
        : "supply_below_consumption",
    minimumSupplySamples,
    startupPhase,
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
      startupWatermark: fixed.startupWatermark,
      resumeWatermark: fixed.resumeWatermark,
      ramBudgetFrames: null,
      estimatedFrameBytes: 0,
      consumptionRate: 0,
      supplyRate: 0,
      supplySamples: 0,
      latencyP95Ms: 0,
      latencySamples: 0,
      minimumSupplySamples: 2,
      tailDemandSlices: 0,
      startupDemandSlices: 0,
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
    bbox = "",
    resolution = null,
  } = {}) {
    const config = this.configProvider() || {};
    const strategy = this.strategy(config);
    if (strategy === "fixed") return this.fixedPolicy(fixedPolicy);
    const metrics = this.metricsProvider({ scopeKey, datasetId, bbox, resolution }) || {};
    if (
      this.current?.strategy === strategy
      && this.current.scopeKey === String(metrics.scope_key || scopeKey || "")
    ) return this.current;
    return calculateAdaptiveWatermarkPolicy({
      fixedPolicy,
      metrics,
      cacheSnapshot: this.cacheSnapshotProvider() || {},
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
      return Object.freeze({
        ...candidate,
        status: candidate.status === "ADAPTIVE" ? "HOLDING" : candidate.status,
        reason: "decrease_hysteresis",
        highWatermark: previous.highWatermark,
        lowWatermark: Math.min(previous.lowWatermark, previous.highWatermark - 1),
      });
    }
    if (this.lastDecreaseAt !== null && now - this.lastDecreaseAt < decreaseStepIntervalMs) {
      return Object.freeze({
        ...candidate,
        status: candidate.status === "ADAPTIVE" ? "HOLDING" : candidate.status,
        reason: "decrease_interval",
        highWatermark: previous.highWatermark,
        lowWatermark: Math.min(previous.lowWatermark, previous.highWatermark - 1),
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
    });
  }

  resolve({
    fixedPolicy = {},
    remainingSlices = 0,
    scopeKey = "",
    datasetId = "",
    bbox = "",
    resolution = null,
    bypassDecreaseHysteresis = false,
  } = {}) {
    if (this.disposed) return this.current || this.fixedPolicy(fixedPolicy);
    const now = this.clock.now();
    const config = this.configProvider() || {};
    const metrics = this.metricsProvider({ scopeKey, datasetId, bbox, resolution }) || {};
    const runId = String(metrics.run_id || "");
    const effectiveScopeKey = String(metrics.scope_key || scopeKey || "");
    const strategy = this.strategy(config);
    const rawCandidate = strategy === "fixed"
      ? this.fixedPolicy(fixedPolicy)
      : calculateAdaptiveWatermarkPolicy({
        fixedPolicy,
        metrics,
        cacheSnapshot: this.cacheSnapshotProvider() || {},
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
      || previous.startupWatermark !== effective.startupWatermark
      || previous.resumeWatermark !== effective.resumeWatermark
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
        startup_watermark: this.current.startupWatermark,
        resume_watermark: this.current.resumeWatermark,
        ram_budget_frames: this.current.ramBudgetFrames,
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
