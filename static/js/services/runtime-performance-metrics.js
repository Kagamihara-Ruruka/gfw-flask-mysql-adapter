function createRuntimePerformanceMetrics({
  eventLog,
  preheater,
  playbackEngine,
  clock,
} = {}) {
  if (!eventLog || !preheater || !playbackEngine || !clock || typeof clock.now !== "function") {
    throw new TypeError("RuntimePerformanceMetrics requires event log, preheater, playback engine and clock");
  }

  function inputs(runId = "") {
    const activeRunId = String(runId || eventLog.currentRunId?.() || "");
    const latestRunId = activeRunId || String(
      [...eventLog.query({})].reverse().find((event) => event.run_id)?.run_id || "",
    );
    const summary = eventLog.summary(latestRunId);
    const events = eventLog.query(summary.runId ? { run_id: summary.runId } : {});
    const runStarted = [...events].reverse().find((event) => event.type === "RUN_STARTED");
    const consumptionRate = Math.max(0, Number(
      runStarted?.consumption_rate
      || summary.trustedMetrics?.observed_consumption_rate
      || 0,
    ));
    const trusted = summary.trustedMetrics || {};
    return Object.freeze({
      run_id: summary.runId || runId || "",
      monotonic_ms: clock.now(),
      consumption_rate: consumptionRate,
      supply_rate: Math.max(0, Number(trusted.supply_rate || 0)),
      cache_ready_latency_p95: Math.max(0, Number(trusted.cache_ready_latency_p95 || 0)),
      consumption_samples: Math.max(0, Number(trusted.consumption_samples || 0)),
      supply_samples: Math.max(0, Number(trusted.supply_samples || 0)),
      cache_ready_latency_samples: Math.max(0, Number(trusted.cache_ready_latency_samples || 0)),
    });
  }

  function snapshot(runId = "") {
    const trustedInputs = inputs(runId);
    const summary = eventLog.summary(trustedInputs.run_id);
    const preheaterSnapshot = preheater.snapshot();
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
        startup_watermark: Number(preheaterSnapshot.startupWatermark || 0),
        resume_watermark: Number(preheaterSnapshot.resumeWatermark || 0),
        degradation_reason: String(preheaterSnapshot.degradationReason || ""),
      }),
      summary,
    });
  }

  return Object.freeze({ inputs, snapshot });
}

if (typeof globalThis !== "undefined") {
  globalThis.createRuntimePerformanceMetrics = createRuntimePerformanceMetrics;
}
