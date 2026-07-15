function createRuntimePerformanceMetrics({
  eventLog,
  preheater,
  playbackEngine,
  clock,
} = {}) {
  if (!eventLog || !preheater || !playbackEngine || !clock || typeof clock.now !== "function") {
    throw new TypeError("RuntimePerformanceMetrics requires event log, preheater, playback engine and clock");
  }

  function snapshot(runId = "") {
    const summary = eventLog.summary(runId || eventLog.currentRunId?.() || "");
    const events = eventLog.query(summary.runId ? { run_id: summary.runId } : {});
    const runStarted = [...events].reverse().find((event) => event.type === "RUN_STARTED");
    const consumptionRate = Math.max(0, Number(
      runStarted?.consumption_rate
      || summary.trustedMetrics?.observed_consumption_rate
      || 0,
    ));
    const preheaterSnapshot = preheater.snapshot();
    const engineSnapshot = playbackEngine.snapshot();
    const readyAheadSlices = Math.max(0, Number(preheaterSnapshot.readyAhead || 0));
    const trusted = summary.trustedMetrics || {};

    return Object.freeze({
      run_id: summary.runId || runId || "",
      monotonic_ms: clock.now(),
      consumption_rate: consumptionRate,
      supply_rate: Math.max(0, Number(trusted.supply_rate || 0)),
      cache_ready_latency_p95: Math.max(0, Number(trusted.cache_ready_latency_p95 || 0)),
      ready_ahead_slices: readyAheadSlices,
      ready_ahead_seconds: consumptionRate > 0 ? readyAheadSlices / consumptionRate : 0,
      buffer_wait_ms: Math.max(0, Number(engineSnapshot.bufferWaitMs || 0)),
      playback_status: engineSnapshot.status || "IDLE",
      preheater_status: preheaterSnapshot.status || "STOPPED",
      summary,
    });
  }

  return Object.freeze({ snapshot });
}

if (typeof globalThis !== "undefined") {
  globalThis.createRuntimePerformanceMetrics = createRuntimePerformanceMetrics;
}
