const RUNTIME_SUPPLY_LANES = new Set(["map-current", "playback-target", "playback-window"]);
const RUNTIME_SCOPE_BURST_GAP_MS = 15_000;
const RUNTIME_SCOPE_SAMPLE_LIMIT = 240;

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

function runtimeEventMatchesScope(event, context) {
  if (!RUNTIME_SUPPLY_LANES.has(String(event?.lane || ""))) return false;
  if (context.scopeKey && String(event.scope_key || "") === context.scopeKey) return true;
  if (!context.datasetId || !context.bbox || context.resolution == null) return false;
  const resolution = Number(event.actual_resolution_km ?? event.requested_resolution_km);
  return String(event.dataset || event.dataset_id || "") === context.datasetId
    && String(event.bbox || "") === context.bbox
    && Number.isFinite(resolution)
    && resolution === context.resolution;
}

function runtimeFindLast(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

function runtimeScopedSupplyMetrics(events, contextValue = {}) {
  const context = normalizeRuntimeMetricsContext(contextValue);
  if (!context.scopeKey && (!context.datasetId || !context.bbox || context.resolution == null)) {
    return null;
  }
  const selectedReady = events
    .filter((event) => (
      event.type === "CACHE_READY"
      && Number(event.monotonic_ms || 0) >= context.sinceMonotonicMs
      && runtimeEventMatchesScope(event, context)
    ))
    .slice(-RUNTIME_SCOPE_SAMPLE_LIMIT);
  if (selectedReady.length < 2) return null;

  const selectedReadySet = new Set(selectedReady);
  const latestQueueByIntent = new Map();
  const timings = [];
  for (const event of events) {
    const monotonicMs = Number(event.monotonic_ms || 0);
    if (monotonicMs < context.sinceMonotonicMs) continue;
    if (event.type === "TASK_QUEUED" && event.intent_key) {
      latestQueueByIntent.set(event.intent_key, event);
    }
    if (!selectedReadySet.has(event)) continue;
    const queued = latestQueueByIntent.get(event.intent_key);
    if (!queued) continue;
    timings.push(Object.freeze({
      queuedAt: Number(queued.monotonic_ms),
      readyAt: monotonicMs,
      durationMs: Math.max(0, monotonicMs - Number(queued.monotonic_ms)),
    }));
  }
  if (timings.length < 2) return null;

  const bursts = [];
  for (const timing of timings) {
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

function createRuntimePerformanceMetrics({
  eventLog,
  preheater,
  playbackEngine,
  clock,
} = {}) {
  if (!eventLog || !preheater || !playbackEngine || !clock || typeof clock.now !== "function") {
    throw new TypeError("RuntimePerformanceMetrics requires event log, preheater, playback engine and clock");
  }

  function inputs(contextValue = "") {
    const context = normalizeRuntimeMetricsContext(contextValue);
    const activeRunId = String(context.runId || eventLog.currentRunId?.() || "");
    const allEvents = eventLog.query({});
    const latestRunId = activeRunId || String(
      runtimeFindLast(allEvents, (event) => Boolean(event.run_id))?.run_id || "",
    );
    const summary = eventLog.summary(latestRunId);
    const events = eventLog.query(summary.runId ? { run_id: summary.runId } : {});
    const runStarted = runtimeFindLast(events, (event) => event.type === "RUN_STARTED");
    const rateChanged = runtimeFindLast(events, (event) => event.type === "PLAYBACK_RATE_CHANGED");
    const consumptionRate = Math.max(0, Number(
      rateChanged?.consumption_rate
      || runStarted?.consumption_rate
      || summary.trustedMetrics?.observed_consumption_rate
      || 0,
    ));
    const trusted = summary.trustedMetrics || {};
    const rateChangedAt = Math.max(0, Number(rateChanged?.monotonic_ms || 0));
    const scopedSupply = runtimeScopedSupplyMetrics(allEvents, {
      ...context,
      sinceMonotonicMs: rateChangedAt,
    });
    const rateTransitionWarming = rateChangedAt > 0 && !scopedSupply;
    const supply = scopedSupply || (rateTransitionWarming ? {} : trusted);
    const playbackStatus = String(playbackEngine.currentStatus?.() || playbackEngine.status || "IDLE");
    return Object.freeze({
      run_id: summary.runId || context.runId || "",
      scope_key: context.scopeKey,
      monotonic_ms: clock.now(),
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

  function snapshot(contextValue = "") {
    const preheaterSnapshot = preheater.snapshot();
    const suppliedContext = normalizeRuntimeMetricsContext(contextValue);
    const trustedInputs = inputs({
      runId: suppliedContext.runId,
      scopeKey: suppliedContext.scopeKey || preheaterSnapshot.scopeKey,
      datasetId: suppliedContext.datasetId || preheaterSnapshot.datasetId,
      bbox: suppliedContext.bbox || preheaterSnapshot.bbox,
      resolution: suppliedContext.resolution ?? preheaterSnapshot.resolution,
    });
    const summary = eventLog.summary(trustedInputs.run_id);
    const engineSnapshot = playbackEngine.snapshot();
    const readyAheadSlices = Math.max(0, Number(preheaterSnapshot.readyAhead || 0));

    return Object.freeze({
      ...trustedInputs,
      monotonic_ms: clock.now(),
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
      summary,
    });
  }

  return Object.freeze({ inputs, snapshot });
}

if (typeof globalThis !== "undefined") {
  globalThis.createRuntimePerformanceMetrics = createRuntimePerformanceMetrics;
  globalThis.runtimeScopedSupplyMetrics = runtimeScopedSupplyMetrics;
}
