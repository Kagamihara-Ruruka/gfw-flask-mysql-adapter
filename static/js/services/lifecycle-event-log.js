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
  if (Number.isFinite(Number(filter.since)) && event.timestamp < Number(filter.since)) return false;
  if (Number.isFinite(Number(filter.until)) && event.timestamp > Number(filter.until)) return false;
  return true;
}

function lifecyclePairedDurations(selected, startType, endType, directField = "") {
  const started = new Map();
  const durations = [];
  for (const event of selected) {
    const key = event.intent_key || event.frame_key || event.task_id || event.date || "runtime";
    if (event.type === startType) started.set(key, event.timestamp);
    if (event.type !== endType) continue;
    const direct = Number(directField ? event[directField] : NaN);
    if (Number.isFinite(direct) && direct >= 0) {
      durations.push(direct);
    } else if (started.has(key)) {
      durations.push(Math.max(0, event.timestamp - started.get(key)));
    }
    started.delete(key);
  }
  return durations;
}

class LifecycleEventLogCore {
  constructor({ maxEntriesProvider = null, eventTarget = null, monotonicNow = null, wallNow = null } = {}) {
    this.maxEntriesProvider = maxEntriesProvider || (() => LIFECYCLE_DEFAULT_MAX_ENTRIES);
    this.eventTarget = eventTarget;
    this.monotonicNow = monotonicNow || (() => (
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now()
    ));
    this.wallNow = wallNow || (() => new Date().toISOString());
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
    return `${prefix}-${Date.now().toString(36)}-${this.runSequence.toString(36)}`;
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
    const timestamp = Number.isFinite(Number(source.timestamp))
      ? Number(source.timestamp)
      : this.monotonicNow();
    delete source.runId;
    return Object.freeze({
      ...source,
      seq: ++this.sequence,
      type,
      run_id: runId,
      timestamp,
      wall_time: source.wall_time || this.wallNow(),
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
    const result = this.events.filter((event) => lifecycleMatches(event, filter));
    const limit = Number(filter.limit || 0);
    if (limit > 0 && result.length > limit) return result.slice(-limit);
    return result;
  }

  summary(runId = this.currentRun) {
    const selected = this.query(runId ? { run_id: runId } : {});
    const first = selected[0];
    const last = selected[selected.length - 1];
    const visible = selected.filter((event) => event.type === "FRAME_VISIBLE");
    const cadence = visible.slice(1).map((event, index) => event.timestamp - visible[index].timestamp);
    const openStalls = new Map();
    const stallDurations = [];
    for (const event of selected) {
      const key = event.intent_key || event.frame_key || event.date || "playback";
      if (event.type === "BUFFER_ENTERED" && !openStalls.has(key)) {
        openStalls.set(key, event.timestamp);
      }
      if (["BUFFER_RESUMED", "BUFFER_CANCELLED"].includes(event.type) && openStalls.has(key)) {
        const direct = Number(event.duration_ms);
        stallDurations.push(Number.isFinite(direct) && direct >= 0
          ? direct
          : Math.max(0, event.timestamp - openStalls.get(key)));
        openStalls.delete(key);
      }
      if (event.type === "RUN_FINISHED" && openStalls.size) {
        for (const startedAt of openStalls.values()) {
          stallDurations.push(Math.max(0, event.timestamp - startedAt));
        }
        openStalls.clear();
      }
    }
    const summaryTimestamp = last?.timestamp ?? this.monotonicNow();
    const activeStalls = [...openStalls.values()].map((startedAt) => Math.max(0, summaryTimestamp - startedAt));
    const allStalls = [...stallDurations, ...activeStalls];
    const elapsedMs = first && last ? Math.max(0, last.timestamp - first.timestamp) : 0;
    const totalStallMs = allStalls.reduce((total, value) => total + value, 0);
    const firstVisible = visible[0];
    const queueDurations = selected
      .filter((event) => event.type === "TASK_DISPATCHED")
      .map((event) => Number(event.wait_ms));
    const networkDurations = selected
      .filter((event) => event.type === "HTTP_FINISHED")
      .map((event) => Number(event.duration_ms));
    const cacheCommitDurations = lifecyclePairedDurations(selected, "HTTP_FINISHED", "CACHE_READY");
    const renderDurations = lifecyclePairedDurations(selected, "RENDER_STARTED", "FRAME_VISIBLE", "render_ms");
    const targetDurations = lifecyclePairedDurations(selected, "TARGET_REQUIRED", "FRAME_VISIBLE");
    return Object.freeze({
      runId: runId || "",
      eventCount: selected.length,
      frameCount: visible.length,
      cacheHits: selected.filter((event) => event.type === "CACHE_HIT").length,
      cacheMisses: selected.filter((event) => event.type === "CACHE_MISS").length,
      promotedTasks: selected.filter((event) => event.type === "TASK_PROMOTED").length,
      httpRequests: selected.filter((event) => event.type === "HTTP_STARTED").length,
      stallCount: allStalls.length,
      activeStallCount: activeStalls.length,
      totalStallMs,
      maxStallMs: allStalls.length ? Math.max(...allStalls) : 0,
      stallRatio: elapsedMs > 0 ? totalStallMs / elapsedMs : 0,
      cadenceP95Ms: lifecyclePercentile(cadence, 0.95),
      clickToFirstFrameMs: firstVisible && first ? Math.max(0, firstVisible.timestamp - first.timestamp) : 0,
      targetToVisibleP95Ms: lifecyclePercentile(targetDurations, 0.95),
      maxQueueDepth: selected.reduce((maximum, event) => Math.max(maximum, Number(event.queue_depth) || 0), 0),
      phases: Object.freeze({
        queue: lifecycleDurationStats(queueDurations),
        network: lifecycleDurationStats(networkDurations),
        cacheCommit: lifecycleDurationStats(cacheCommitDurations),
        render: lifecycleDurationStats(renderDurations),
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
      schema: "rrkal.lifecycle-events.v1",
      exported_at: this.wallNow(),
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
}
