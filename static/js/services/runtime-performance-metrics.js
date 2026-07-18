const RUNTIME_SUPPLY_LANES = new Set(["map-current", "playback-target", "playback-window"]);
const RUNTIME_SCOPE_BURST_GAP_MS = 15_000;
const RUNTIME_SCOPE_SAMPLE_LIMIT = 240;
const RUNTIME_SCOPE_HISTORY_LIMIT = 64;
const RUNTIME_PENDING_QUEUE_LIMIT = 2048;
const RUNTIME_RUN_HISTORY_LIMIT = 32;

function runtimeMetricsPercentile(values, ratio = 0.95) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function normalizeRuntimeMetricsContext(value = "") {
  const source = value && typeof value === "object" ? value : { runId: value };
  const resolution = Number(source.resolution ?? source.requested_resolution_km);
  const sinceMonotonicMs = Number(source.sinceMonotonicMs ?? source.since_monotonic_ms);
  return Object.freeze({
    runId: String(source.runId || source.run_id || ""),
    scopeKey: String(source.scopeKey || source.scope_key || ""),
    datasetId: String(source.datasetId || source.dataset || ""),
    bbox: String(source.bbox || ""),
    resolution: Number.isFinite(resolution) && resolution > 0 ? resolution : null,
    sinceMonotonicMs: Number.isFinite(sinceMonotonicMs) && sinceMonotonicMs > 0
      ? sinceMonotonicMs
      : 0,
  });
}

function runtimeResolution(event = {}) {
  const resolution = Number(
    event.requested_resolution_km
    ?? event.effective_query_resolution_km
    ?? event.actual_resolution_km,
  );
  return Number.isFinite(resolution) && resolution > 0 ? resolution : null;
}

function runtimeEventMatchesScope(event, context) {
  if (!RUNTIME_SUPPLY_LANES.has(String(event?.lane || ""))) return false;
  if (context.scopeKey && String(event.scope_key || "") === context.scopeKey) return true;
  if (!context.datasetId || !context.bbox || context.resolution == null) return false;
  return String(event.dataset || event.dataset_id || "") === context.datasetId
    && String(event.bbox || "") === context.bbox
    && runtimeResolution(event) === context.resolution;
}

function runtimeSupplyMetricsFromTimings(timings, sinceMonotonicMs = 0) {
  const selected = timings
    .filter((timing) => (
      Number(timing.queuedAt || 0) >= sinceMonotonicMs
      && Number(timing.readyAt || 0) >= sinceMonotonicMs
    ))
    .slice(-RUNTIME_SCOPE_SAMPLE_LIMIT);
  if (selected.length < 2) return null;

  const bursts = [];
  for (const timing of selected) {
    const burst = bursts[bursts.length - 1];
    if (!burst || timing.readyAt - burst[burst.length - 1].readyAt > RUNTIME_SCOPE_BURST_GAP_MS) {
      bursts.push([timing]);
    } else {
      burst.push(timing);
    }
  }
  const selectedBurst = [...bursts].reverse().find((burst) => burst.length >= 2);
  if (!selectedBurst) return null;
  const firstQueuedAt = Math.min(...selectedBurst.map((timing) => timing.queuedAt));
  const lastReadyAt = selectedBurst[selectedBurst.length - 1].readyAt;
  const elapsedSeconds = Math.max(0, (lastReadyAt - firstQueuedAt) / 1000);
  return Object.freeze({
    supply_rate: elapsedSeconds > 0 ? selectedBurst.length / elapsedSeconds : 0,
    supply_samples: selectedBurst.length,
    cache_ready_latency_p95: runtimeMetricsPercentile(
      selectedBurst.map((timing) => timing.durationMs),
      0.95,
    ),
    cache_ready_latency_samples: selectedBurst.length,
    source: "scope_history",
  });
}

// Retained as a pure reference projection for tests and offline event analysis.
function runtimeScopedSupplyMetrics(events, contextValue = {}) {
  const context = normalizeRuntimeMetricsContext(contextValue);
  if (!context.scopeKey && (!context.datasetId || !context.bbox || context.resolution == null)) {
    return null;
  }
  const latestQueueByIntent = new Map();
  const timings = [];
  for (const event of events) {
    if (event.type === "TASK_QUEUED" && event.intent_key) {
      latestQueueByIntent.set(event.intent_key, event);
      continue;
    }
    const monotonicMs = Number(event.monotonic_ms || 0);
    if (
      event.type !== "CACHE_READY"
      || monotonicMs < context.sinceMonotonicMs
      || !runtimeEventMatchesScope(event, context)
    ) {
      continue;
    }
    const queued = latestQueueByIntent.get(event.intent_key);
    if (!queued) continue;
    timings.push(Object.freeze({
      queuedAt: Number(queued.monotonic_ms),
      readyAt: monotonicMs,
      durationMs: Math.max(0, monotonicMs - Number(queued.monotonic_ms)),
    }));
  }
  return runtimeSupplyMetricsFromTimings(timings, context.sinceMonotonicMs);
}

function runtimeFallbackScopeKey(value = {}) {
  const context = normalizeRuntimeMetricsContext(value);
  if (!context.datasetId || !context.bbox || context.resolution == null) return "";
  return [context.datasetId, context.bbox, context.resolution].join("|");
}

function runtimeEventContext(event = {}) {
  return normalizeRuntimeMetricsContext({
    scopeKey: event.scope_key,
    datasetId: event.dataset || event.dataset_id,
    bbox: event.bbox,
    resolution: runtimeResolution(event),
  });
}

function runtimeBoundedMapSet(map, key, value, limit) {
  if (!key) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function runtimeAppendHistory(map, key, sample) {
  if (!key) return;
  const history = map.get(key) || [];
  history.push(sample);
  if (history.length > RUNTIME_SCOPE_SAMPLE_LIMIT) {
    history.splice(0, history.length - RUNTIME_SCOPE_SAMPLE_LIMIT);
  }
  runtimeBoundedMapSet(map, key, history, RUNTIME_SCOPE_HISTORY_LIMIT);
}

class RuntimePerformanceMetricsCore {
  constructor({ eventLog, preheater, playbackEngine, clock } = {}) {
    if (!eventLog || !preheater || !playbackEngine || !clock || typeof clock.now !== "function") {
      throw new TypeError("RuntimePerformanceMetrics requires event log, preheater, playback engine and clock");
    }
    this.eventLog = eventLog;
    this.preheater = preheater;
    this.playbackEngine = playbackEngine;
    this.clock = clock;
    this.pendingByIntent = new Map();
    this.scopeHistory = new Map();
    this.fallbackHistory = new Map();
    this.runs = new Map();
    this.lastRunId = "";
    this.disposed = false;
    this.rebuild();
    this.unsubscribe = eventLog.subscribe((event) => {
      if (event) this.consume(event);
      else this.rebuild();
    }, { emitCurrent: false });
  }

  reset() {
    this.pendingByIntent.clear();
    this.scopeHistory.clear();
    this.fallbackHistory.clear();
    this.runs.clear();
    this.lastRunId = "";
  }

  rebuild() {
    this.reset();
    for (const event of this.eventLog.query({})) this.consume(event);
  }

  ensureRun(runId) {
    const normalized = String(runId || "");
    if (!normalized) return null;
    let run = this.runs.get(normalized);
    if (run) return run;
    run = {
      runId: normalized,
      scopeKey: "",
      consumptionRate: 0,
      consumptionSamples: 0,
      firstVisibleAt: null,
      lastVisibleAt: null,
      rateChangedAt: 0,
      hasRateChange: false,
      supplySamples: 0,
      firstSupplyQueuedAt: null,
      cacheReadyLatencies: [],
      eventCount: 0,
      lastEventAt: 0,
      finishedAt: null,
    };
    runtimeBoundedMapSet(this.runs, normalized, run, RUNTIME_RUN_HISTORY_LIMIT);
    return run;
  }

  consume(event) {
    if (!event || this.disposed) return;
    const runId = String(event.run_id || "");
    const monotonicMs = Number(event.monotonic_ms || 0);
    const run = this.ensureRun(runId);
    if (run) {
      run.eventCount += 1;
      run.lastEventAt = Math.max(run.lastEventAt, monotonicMs);
      this.lastRunId = runId;
      if (event.type === "RUN_STARTED") {
        run.scopeKey = String(event.scope_key || "");
        run.consumptionRate = Math.max(0, Number(event.consumption_rate || 0));
      } else if (event.type === "PLAYBACK_RATE_CHANGED") {
        run.consumptionRate = Math.max(0, Number(event.consumption_rate || 0));
        run.rateChangedAt = monotonicMs;
        run.hasRateChange = true;
      } else if (event.type === "FRAME_VISIBLE") {
        run.consumptionSamples += 1;
        if (run.firstVisibleAt === null) run.firstVisibleAt = monotonicMs;
        run.lastVisibleAt = monotonicMs;
      } else if (event.type === "RUN_FINISHED") {
        run.finishedAt = monotonicMs;
      }
    }

    const intentKey = String(event.intent_key || "");
    if (event.type === "TASK_QUEUED" && intentKey && RUNTIME_SUPPLY_LANES.has(String(event.lane || ""))) {
      runtimeBoundedMapSet(this.pendingByIntent, intentKey, event, RUNTIME_PENDING_QUEUE_LIMIT);
      return;
    }
    if (event.type !== "CACHE_READY" || !RUNTIME_SUPPLY_LANES.has(String(event.lane || ""))) return;

    const queued = this.pendingByIntent.get(intentKey);
    if (queued) this.pendingByIntent.delete(intentKey);
    const context = runtimeEventContext({ ...queued, ...event });
    if (queued) {
      const queuedAt = Number(queued.monotonic_ms || 0);
      const timing = Object.freeze({
        queuedAt,
        readyAt: monotonicMs,
        durationMs: Math.max(0, monotonicMs - queuedAt),
      });
      runtimeAppendHistory(this.scopeHistory, context.scopeKey, timing);
      runtimeAppendHistory(this.fallbackHistory, runtimeFallbackScopeKey(context), timing);
    }

    if (run && (!run.scopeKey || context.scopeKey === run.scopeKey)) {
      run.supplySamples += 1;
      const queuedAt = Number(queued?.monotonic_ms);
      if (Number.isFinite(queuedAt)) {
        run.firstSupplyQueuedAt = run.firstSupplyQueuedAt === null
          ? queuedAt
          : Math.min(run.firstSupplyQueuedAt, queuedAt);
        run.cacheReadyLatencies.push(Math.max(0, monotonicMs - queuedAt));
        if (run.cacheReadyLatencies.length > RUNTIME_SCOPE_SAMPLE_LIMIT) {
          run.cacheReadyLatencies.shift();
        }
      }
    }
  }

  scopedSupply(contextValue = {}) {
    const context = normalizeRuntimeMetricsContext(contextValue);
    let history = context.scopeKey ? this.scopeHistory.get(context.scopeKey) : null;
    const fallbackKey = runtimeFallbackScopeKey(context);
    if ((!history || history.length < 2) && fallbackKey) {
      history = this.fallbackHistory.get(fallbackKey);
    }
    return runtimeSupplyMetricsFromTimings(history || [], context.sinceMonotonicMs);
  }

  resolveRun(runId = "") {
    const selected = String(runId || this.eventLog.currentRunId?.() || this.lastRunId || "");
    return this.runs.get(selected) || null;
  }

  trustedMetrics(run) {
    if (!run) {
      return Object.freeze({
        observed_consumption_rate: 0,
        supply_rate: 0,
        cache_ready_latency_p95: 0,
        consumption_samples: 0,
        supply_samples: 0,
        cache_ready_latency_samples: 0,
      });
    }
    const visibleElapsed = run.firstVisibleAt !== null && run.lastVisibleAt !== null
      ? Math.max(0, run.lastVisibleAt - run.firstVisibleAt) / 1000
      : 0;
    const supplyEndedAt = run.finishedAt ?? (
      this.eventLog.currentRunId?.() === run.runId ? this.clock.now() : run.lastEventAt
    );
    const supplyElapsed = run.firstSupplyQueuedAt !== null
      ? Math.max(0, supplyEndedAt - run.firstSupplyQueuedAt) / 1000
      : 0;
    return Object.freeze({
      observed_consumption_rate: visibleElapsed > 0
        ? Math.max(0, run.consumptionSamples - 1) / visibleElapsed
        : 0,
      supply_rate: supplyElapsed > 0 ? run.supplySamples / supplyElapsed : 0,
      cache_ready_latency_p95: runtimeMetricsPercentile(run.cacheReadyLatencies, 0.95),
      consumption_samples: run.consumptionSamples,
      supply_samples: run.supplySamples,
      cache_ready_latency_samples: run.cacheReadyLatencies.length,
    });
  }

  inputs(contextValue = "") {
    const context = normalizeRuntimeMetricsContext(contextValue);
    const run = this.resolveRun(context.runId);
    const trusted = this.trustedMetrics(run);
    const consumptionRate = Math.max(0, Number(
      run?.consumptionRate || trusted.observed_consumption_rate || 0,
    ));
    const rateChangedAt = run?.hasRateChange ? Math.max(0, Number(run.rateChangedAt || 0)) : 0;
    const scopedSupply = this.scopedSupply({ ...context, sinceMonotonicMs: rateChangedAt });
    const rateTransitionWarming = Boolean(run?.hasRateChange) && !scopedSupply;
    const supply = scopedSupply || (rateTransitionWarming ? {} : trusted);
    const playbackStatus = String(
      this.playbackEngine.currentStatus?.() || this.playbackEngine.status || "IDLE",
    );
    return Object.freeze({
      run_id: run?.runId || context.runId || "",
      scope_key: context.scopeKey,
      monotonic_ms: this.clock.now(),
      consumption_rate: consumptionRate,
      playback_status: playbackStatus,
      supply_rate: Math.max(0, Number(supply.supply_rate || 0)),
      cache_ready_latency_p95: Math.max(0, Number(supply.cache_ready_latency_p95 || 0)),
      consumption_samples: Math.max(0, Number(trusted.consumption_samples || 0)),
      supply_samples: Math.max(0, Number(supply.supply_samples || 0)),
      cache_ready_latency_samples: Math.max(0, Number(supply.cache_ready_latency_samples || 0)),
      supply_metric_source: scopedSupply?.source || (
        rateTransitionWarming ? "rate_transition_warmup" : "run_summary"
      ),
    });
  }

  snapshot(contextValue = "") {
    const preheaterSnapshot = this.preheater.snapshot();
    const suppliedContext = normalizeRuntimeMetricsContext(contextValue);
    const trustedInputs = this.inputs({
      runId: suppliedContext.runId,
      scopeKey: suppliedContext.scopeKey || preheaterSnapshot.scopeKey,
      datasetId: suppliedContext.datasetId || preheaterSnapshot.datasetId,
      bbox: suppliedContext.bbox || preheaterSnapshot.bbox,
      resolution: suppliedContext.resolution ?? preheaterSnapshot.resolution,
    });
    const run = this.resolveRun(trustedInputs.run_id);
    const engineSnapshot = this.playbackEngine.snapshot();
    const readyAheadSlices = Math.max(0, Number(preheaterSnapshot.readyAhead || 0));

    return Object.freeze({
      ...trustedInputs,
      monotonic_ms: this.clock.now(),
      ready_ahead_slices: readyAheadSlices,
      ready_ahead_seconds: trustedInputs.consumption_rate > 0
        ? readyAheadSlices / trustedInputs.consumption_rate
        : 0,
      buffer_wait_ms: Math.max(0, Number(engineSnapshot.bufferWaitMs || 0)),
      preparation_wait_ms: Math.max(0, Number(engineSnapshot.preparationWaitMs || 0)),
      playback_status: engineSnapshot.status || "IDLE",
      preheater_status: preheaterSnapshot.status || "STOPPED",
      watermark_policy: Object.freeze({
        strategy: preheaterSnapshot.strategy || "fixed",
        status: preheaterSnapshot.policyStatus || "FIXED",
        low_watermark: Number(preheaterSnapshot.lowWatermark || 0),
        high_watermark: Number(preheaterSnapshot.highWatermark || 0),
        target_watermark: Number(preheaterSnapshot.targetWatermark || 0),
        immediate_replenishment: Boolean(preheaterSnapshot.immediateReplenishment),
        tail_mode: Boolean(preheaterSnapshot.tailMode),
        supply_ratio: Number.isFinite(Number(preheaterSnapshot.supplyRatio))
          ? Number(preheaterSnapshot.supplyRatio)
          : null,
        capacity_frames: Number(preheaterSnapshot.ramBudgetFrames || 0),
        playback_ram_budget_bytes: Number(preheaterSnapshot.playbackRamBudgetBytes || 0),
        degradation_reason: String(preheaterSnapshot.degradationReason || ""),
      }),
      summary: Object.freeze({
        runId: run?.runId || "",
        eventCount: Number(run?.eventCount || 0),
        frameCount: Number(run?.consumptionSamples || 0),
        trustedMetrics: this.trustedMetrics(run),
      }),
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.reset();
  }
}

function createRuntimePerformanceMetrics(options = {}) {
  return new RuntimePerformanceMetricsCore(options);
}

if (typeof globalThis !== "undefined") {
  globalThis.createRuntimePerformanceMetrics = createRuntimePerformanceMetrics;
  globalThis.RuntimePerformanceMetricsCore = RuntimePerformanceMetricsCore;
  globalThis.runtimeScopedSupplyMetrics = runtimeScopedSupplyMetrics;
}
