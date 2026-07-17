const LIFECYCLE_DEFAULT_MAX_ENTRIES = 20000;

function lifecyclePercentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function lifecycleDurationStats(values) {
  const finite = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return Object.freeze({
    count: finite.length,
    totalMs: finite.reduce((total, value) => total + value, 0),
    maxMs: finite.length ? Math.max(...finite) : 0,
    p95Ms: lifecyclePercentile(finite, 0.95),
  });
}

function lifecycleMatches(event, filter = {}) {
  if (filter.run_id && event.run_id !== String(filter.run_id)) return false;
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.map((value) => String(value).toUpperCase()).includes(event.type)) return false;
  }
  if (filter.dataset && String(event.dataset || event.dataset_id || "") !== String(filter.dataset)) return false;
  if (filter.frame_key && String(event.frame_key || "") !== String(filter.frame_key)) return false;
  if (filter.intent_key && String(event.intent_key || "") !== String(filter.intent_key)) return false;
  if (filter.scope_id && String(event.scope_id || "") !== String(filter.scope_id)) return false;
  if (Number.isFinite(Number(filter.since)) && event.monotonic_ms < Number(filter.since)) return false;
  if (Number.isFinite(Number(filter.until)) && event.monotonic_ms > Number(filter.until)) return false;
  return true;
}

function lifecyclePairedDurations(selected, startType, endType, directField = "") {
  const started = new Map();
  const durations = [];
  for (const event of selected) {
    const key = event.intent_key || event.frame_key || event.task_id || event.date || "runtime";
    if (event.type === startType && !started.has(key)) started.set(key, event.monotonic_ms);
    if (event.type !== endType) continue;
    const direct = Number(directField ? event[directField] : NaN);
    if (Number.isFinite(direct) && direct >= 0) {
      durations.push(direct);
    } else if (started.has(key)) {
      durations.push(Math.max(0, event.monotonic_ms - started.get(key)));
    }
    started.delete(key);
  }
  return durations;
}

function lifecycleRate(events) {
  if (!Array.isArray(events) || events.length < 2) return 0;
  const first = Number(events[0]?.monotonic_ms);
  const last = Number(events[events.length - 1]?.monotonic_ms);
  const elapsedSeconds = (last - first) / 1000;
  return elapsedSeconds > 0 ? (events.length - 1) / elapsedSeconds : 0;
}

function lifecycleWindowRate(events, startedAt, endedAt) {
  if (!Array.isArray(events) || events.length < 2) return 0;
  const first = Number(startedAt);
  const last = Number(endedAt);
  const elapsedSeconds = (last - first) / 1000;
  return elapsedSeconds > 0 ? events.length / elapsedSeconds : 0;
}

function lifecycleReadyTimings(events, readyEvents, predicate = () => true) {
  const selectedReady = new Set(readyEvents);
  const latestQueuedByIntent = new Map();
  const timings = [];
  for (const event of events) {
    if (event.type === "TASK_QUEUED" && event.intent_key && predicate(event)) {
      latestQueuedByIntent.set(event.intent_key, event);
    }
    if (!selectedReady.has(event)) continue;
    const ready = event;
    const queued = latestQueuedByIntent.get(ready.intent_key);
    if (!queued) continue;
    timings.push(Object.freeze({
      queuedAt: queued.monotonic_ms,
      readyAt: ready.monotonic_ms,
      durationMs: Math.max(0, ready.monotonic_ms - queued.monotonic_ms),
    }));
  }
  return timings;
}

class LifecycleEventLogCore {
  constructor({ maxEntriesProvider = null, eventTarget = null, clock } = {}) {
    if (!clock || typeof clock.now !== "function" || typeof clock.wallNowIso !== "function") {
      throw new TypeError("LifecycleEventLog requires a monotonic clock");
    }
    this.maxEntriesProvider = maxEntriesProvider || (() => LIFECYCLE_DEFAULT_MAX_ENTRIES);
    this.eventTarget = eventTarget;
    this.clock = clock;
    this.listeners = new Set();
    this.events = [];
    this.sequence = 0;
    this.runSequence = 0;
    this.currentRun = "";
    this.disposed = false;
  }

  maxEntries() {
    const configured = Number(this.maxEntriesProvider());
    return Math.max(
      1000,
      Number.isFinite(configured) ? configured : LIFECYCLE_DEFAULT_MAX_ENTRIES,
    );
  }

  nextRunId(prefix = "playback") {
    this.runSequence += 1;
    return `${prefix}-${Math.floor(this.clock.now()).toString(36)}-${this.runSequence.toString(36)}`;
  }

  notify(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn("Lifecycle event subscriber failed", error);
      }
    }
    if (this.eventTarget?.dispatchEvent && typeof CustomEvent === "function") {
      this.eventTarget.dispatchEvent(new CustomEvent("rrkal:lifecycle-event", { detail: event }));
    }
  }

  normalizeRecord(typeOrEvent, detail = {}) {
    const source = typeof typeOrEvent === "string"
      ? { ...detail, type: typeOrEvent }
      : { ...(typeOrEvent || {}) };
    const type = String(source.type || "UNKNOWN").trim().toUpperCase();
    const runId = String(source.run_id || source.runId || this.currentRun || "");
    const monotonicMs = Number.isFinite(Number(source.monotonic_ms))
      ? Number(source.monotonic_ms)
      : this.clock.now();
    delete source.runId;
    delete source.timestamp;
    return Object.freeze({
      ...source,
      seq: ++this.sequence,
      type,
      run_id: runId,
      monotonic_ms: monotonicMs,
      wall_time: source.wall_time || this.clock.wallNowIso(),
    });
  }

  record(typeOrEvent, detail = {}) {
    if (this.disposed) return null;
    const event = this.normalizeRecord(typeOrEvent, detail);
    this.events.push(event);
    const overflow = this.events.length - this.maxEntries();
    if (overflow > 0) this.events.splice(0, overflow);
    this.notify(event);
    return event;
  }

  beginRun(metadata = {}) {
    const runId = String(metadata.run_id || metadata.runId || this.nextRunId(metadata.kind || "playback"));
    this.currentRun = runId;
    this.record("RUN_STARTED", { ...metadata, run_id: runId });
    return runId;
  }

  endRun(metadata = {}) {
    const runId = String(metadata.run_id || metadata.runId || this.currentRun || "");
    if (!runId) return null;
    const event = this.record("RUN_FINISHED", { ...metadata, run_id: runId });
    if (runId === this.currentRun) this.currentRun = "";
    return event;
  }

  query(filter = {}) {
    const limit = Number(filter.limit || 0);
    if (limit > 0) {
      const result = [];
      for (let index = this.events.length - 1; index >= 0 && result.length < limit; index -= 1) {
        const event = this.events[index];
        if (lifecycleMatches(event, filter)) result.push(event);
      }
      return result.reverse();
    }
    return this.events.filter((event) => lifecycleMatches(event, filter));
  }

  latest(filter = {}) {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (lifecycleMatches(event, filter)) return event;
    }
    return null;
  }

  summary(runId = this.currentRun) {
    const selected = this.query(runId ? { run_id: runId } : {});
    const first = selected[0];
    const last = selected[selected.length - 1];
    const visible = selected.filter((event) => event.type === "FRAME_VISIBLE");
    const cadence = visible.slice(1).map((event, index) => event.monotonic_ms - visible[index].monotonic_ms);
    const runStarted = selected.find((event) => event.type === "RUN_STARTED");
    const playbackScopeKey = String(runStarted?.scope_key || "");
    const playbackSupplyLanes = new Set(["map-current", "playback-target", "playback-window"]);
    const isPlaybackSupply = (event) => (
      playbackSupplyLanes.has(String(event.lane || ""))
      && (!playbackScopeKey || String(event.scope_key || "") === playbackScopeKey)
    );
    const cacheReady = selected.filter((event) => event.type === "CACHE_READY" && isPlaybackSupply(event));
    const openStalls = new Map();
    const stallDurations = [];
    for (const event of selected) {
      const key = event.intent_key || event.frame_key || event.date || "playback";
      if (event.type === "BUFFER_ENTERED" && !openStalls.has(key)) {
        openStalls.set(key, event.monotonic_ms);
      }
      if (["BUFFER_RESUMED", "BUFFER_CANCELLED"].includes(event.type) && openStalls.has(key)) {
        const direct = Number(event.duration_ms);
        stallDurations.push(Number.isFinite(direct) && direct >= 0
          ? direct
          : Math.max(0, event.monotonic_ms - openStalls.get(key)));
        openStalls.delete(key);
      }
      if (event.type === "RUN_FINISHED" && openStalls.size) {
        for (const startedAt of openStalls.values()) {
          stallDurations.push(Math.max(0, event.monotonic_ms - startedAt));
        }
        openStalls.clear();
      }
    }
    const summaryTimestamp = last?.monotonic_ms ?? this.clock.now();
    const activeStalls = [...openStalls.values()].map((startedAt) => Math.max(0, summaryTimestamp - startedAt));
    const allStalls = [...stallDurations, ...activeStalls];
    const elapsedMs = first && last ? Math.max(0, last.monotonic_ms - first.monotonic_ms) : 0;
    const totalStallMs = allStalls.reduce((total, value) => total + value, 0);
    const firstVisible = visible[0];
    const queueDurations = selected
      .filter((event) => event.type === "TASK_DISPATCHED")
      .map((event) => Number(event.wait_ms));
    const networkDurations = selected
      .filter((event) => event.type === "HTTP_BATCH_FINISHED")
      .map((event) => Number(event.duration_ms));
    const cacheCommitDurations = lifecyclePairedDurations(
      selected,
      "QUERY_OPERATION_FINISHED",
      "CACHE_READY",
    );
    const cacheReadyTimings = lifecycleReadyTimings(this.events, cacheReady, isPlaybackSupply);
    const cacheReadyDurations = cacheReadyTimings.map((timing) => timing.durationMs);
    const renderDurations = lifecyclePairedDurations(selected, "RENDER_STARTED", "FRAME_VISIBLE", "render_ms");
    const targetDurations = lifecyclePairedDurations(selected, "TARGET_REQUIRED", "FRAME_VISIBLE");
    const preparationDurations = lifecyclePairedDurations(selected, "PREPARE_STARTED", "PREPARE_READY");
    const firstSupplyQueuedAt = cacheReadyTimings.length
      ? Math.min(...cacheReadyTimings.map((timing) => timing.queuedAt))
      : cacheReady[0]?.monotonic_ms;
    const supplyEndedAt = this.currentRun === runId ? this.clock.now() : last?.monotonic_ms;
    return Object.freeze({
      runId: runId || "",
      eventCount: selected.length,
      frameCount: visible.length,
      cacheHits: selected.filter((event) => event.type === "CACHE_HIT").length,
      cacheMisses: selected.filter((event) => event.type === "CACHE_MISS").length,
      promotedTasks: selected.filter((event) => event.type === "TASK_PROMOTED").length,
      httpRequests: selected.filter((event) => event.type === "HTTP_BATCH_STARTED").length,
      queryOperations: selected.filter((event) => event.type === "QUERY_OPERATION_STARTED").length,
      prepareCount: selected.filter((event) => event.type === "PREPARE_STARTED").length,
      stallCount: allStalls.length,
      activeStallCount: activeStalls.length,
      totalStallMs,
      maxStallMs: allStalls.length ? Math.max(...allStalls) : 0,
      stallRatio: elapsedMs > 0 ? totalStallMs / elapsedMs : 0,
      cadenceP95Ms: lifecyclePercentile(cadence, 0.95),
      clickToFirstFrameMs: firstVisible && first ? Math.max(0, firstVisible.monotonic_ms - first.monotonic_ms) : 0,
      targetToVisibleP95Ms: lifecyclePercentile(targetDurations, 0.95),
      maxQueueDepth: selected.reduce((maximum, event) => Math.max(maximum, Number(event.queue_depth) || 0), 0),
      phases: Object.freeze({
        queue: lifecycleDurationStats(queueDurations),
        network: lifecycleDurationStats(networkDurations),
        cacheCommit: lifecycleDurationStats(cacheCommitDurations),
        render: lifecycleDurationStats(renderDurations),
        preparation: lifecycleDurationStats(preparationDurations),
      }),
      trustedMetrics: Object.freeze({
        observed_consumption_rate: lifecycleRate(visible),
        supply_rate: lifecycleWindowRate(
          cacheReady,
          firstSupplyQueuedAt,
          supplyEndedAt,
        ),
        cache_ready_latency_p95: lifecyclePercentile(cacheReadyDurations, 0.95),
        consumption_samples: visible.length,
        supply_samples: cacheReady.length,
        cache_ready_latency_samples: cacheReadyDurations.length,
      }),
      elapsedMs,
      startedAt: first?.wall_time || "",
      finishedAt: last?.wall_time || "",
    });
  }

  snapshot(filter = {}) {
    const selected = this.query(filter);
    const runId = filter.run_id || this.currentRun || selected[selected.length - 1]?.run_id || "";
    return Object.freeze({
      currentRunId: this.currentRun,
      events: selected,
      summary: this.summary(runId),
      totalEntries: this.events.length,
      maxEntries: this.maxEntries(),
    });
  }

  subscribe(listener, { emitCurrent = true } = {}) {
    if (typeof listener !== "function" || this.disposed) return () => {};
    this.listeners.add(listener);
    if (emitCurrent) listener(null);
    return () => this.listeners.delete(listener);
  }

  exportRun(runId = this.currentRun) {
    const payload = {
      schema: "rrkal.lifecycle-events.v2",
      exported_at: this.clock.wallNowIso(),
      run_id: runId || "",
      summary: this.summary(runId),
      events: this.query(runId ? { run_id: runId } : {}),
    };
    return JSON.stringify(payload, null, 2);
  }

  clear({ runId = "" } = {}) {
    if (!runId) {
      this.events.splice(0, this.events.length);
      this.currentRun = "";
    } else {
      for (let index = this.events.length - 1; index >= 0; index -= 1) {
        if (this.events[index].run_id === runId) this.events.splice(index, 1);
      }
      if (this.currentRun === runId) this.currentRun = "";
    }
    this.notify(null);
  }

  currentRunId() {
    return this.currentRun;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.events.splice(0, this.events.length);
    this.currentRun = "";
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.LifecycleEventLogCore = LifecycleEventLogCore;
  globalThis.lifecycleDurationStats = lifecycleDurationStats;
  globalThis.lifecycleMatches = lifecycleMatches;
  globalThis.lifecyclePercentile = lifecyclePercentile;
  globalThis.lifecycleRate = lifecycleRate;
}
