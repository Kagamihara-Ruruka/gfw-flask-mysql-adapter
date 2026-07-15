class QueryScheduler {
  static PRIORITY = Object.freeze({
    "map-current": 0,
    "playback-target": 5,
    widget: 10,
    "playback-window": 20,
    background: 40,
  });

  static LANE_ALIAS = Object.freeze({
    map: "map-current",
    overlay: "map-current",
    playback: "playback-window",
    prewarm: "background",
  });

  constructor({
    concurrency = null,
    concurrencyProvider = null,
    foregroundCutoff = 5,
    eventLog = null,
    snapshotSink = null,
  } = {}) {
    this.configuredConcurrency = concurrency;
    this.concurrencyProvider = concurrencyProvider || (() => 6);
    this.foregroundCutoff = foregroundCutoff;
    this.eventLog = eventLog;
    this.snapshotSink = snapshotSink;
    this.queue = [];
    this.active = new Map();
    this.tasksByKey = new Map();
    this.sequence = 0;
    this.consumerSequence = 0;
  }

  concurrency() {
    const configured = this.configuredConcurrency ?? this.concurrencyProvider();
    const numeric = Number(configured);
    return Math.max(1, Math.min(16, Number.isFinite(numeric) ? numeric : 6));
  }

  normalizeLane(lane) {
    const requested = String(lane || "background");
    return QueryScheduler.LANE_ALIAS[requested] || (
      Object.hasOwn(QueryScheduler.PRIORITY, requested) ? requested : "background"
    );
  }

  priorityFor(lane) {
    return QueryScheduler.PRIORITY[this.normalizeLane(lane)];
  }

  isForeground(task) {
    return task.priority <= this.foregroundCutoff;
  }

  abortError(reason = "Query task cancelled") {
    const error = new Error(reason);
    error.name = "AbortError";
    return error;
  }

  record(type, task, detail = {}) {
    this.eventLog?.record?.(type, {
      task_id: task?.id || "",
      intent_key: task?.key || "",
      lane: task?.lane || "",
      queue_depth: this.queue.length,
      active_count: this.active.size,
      ...(task?.metadata || {}),
      ...detail,
    });
  }

  updateStats() {
    this.snapshotSink?.(Object.freeze({
      queued: this.queue.length,
      active: this.active.size,
      concurrency: this.concurrency(),
      foregroundQueued: this.queue.filter((task) => this.isForeground(task)).length,
      backgroundActive: [...this.active.values()].filter((task) => !this.isForeground(task)).length,
    }));
  }

  createConsumer(task, { signal = null, scopeId = "", consumerId = "", lane = task.lane } = {}) {
    const id = String(consumerId || `consumer-${++this.consumerSequence}`);
    let resolveConsumer;
    let rejectConsumer;
    const promise = new Promise((resolve, reject) => {
      resolveConsumer = resolve;
      rejectConsumer = reject;
    });
    const consumer = {
      id,
      lane: this.normalizeLane(lane),
      scopeId: String(scopeId || ""),
      signal,
      resolve: resolveConsumer,
      reject: rejectConsumer,
      settled: false,
      abortListener: null,
    };
    consumer.abortListener = () => this.removeConsumer(task, consumer, this.abortError());
    if (signal?.aborted) {
      consumer.settled = true;
      rejectConsumer(this.abortError());
      return promise;
    }
    signal?.addEventListener("abort", consumer.abortListener, { once: true });
    task.consumers.set(id, consumer);
    return promise;
  }

  settleConsumer(consumer, method, value) {
    if (!consumer || consumer.settled) return;
    consumer.settled = true;
    consumer.signal?.removeEventListener("abort", consumer.abortListener);
    method.call(consumer, value);
  }

  removeConsumer(task, consumer, error = this.abortError()) {
    if (!task?.consumers?.has(consumer.id)) return;
    task.consumers.delete(consumer.id);
    this.settleConsumer(consumer, consumer.reject, error);
    if (task.consumers.size > 0) return;
    if (task.status === "queued") {
      this.removeQueued(task);
      this.finishTask(task);
    } else if (task.status === "active") {
      task.controller.abort();
    }
    this.updateStats();
  }

  removeQueued(task) {
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
  }

  finishTask(task) {
    this.removeQueued(task);
    this.active.delete(task.id);
    if (this.tasksByKey.get(task.key) === task) this.tasksByKey.delete(task.key);
    task.status = "settled";
  }

  promote(task, lane) {
    const normalizedLane = this.normalizeLane(lane);
    const priority = this.priorityFor(normalizedLane);
    if (priority >= task.priority) return false;
    const previousLane = task.lane;
    task.lane = normalizedLane;
    task.priority = priority;
    this.record("TASK_PROMOTED", task, { previous_lane: previousLane });
    return true;
  }

  schedule({
    key = "",
    lane = "background",
    signal = null,
    execute,
    metadata = {},
    scopeId = "",
    consumerId = "",
  } = {}) {
    if (typeof execute !== "function") {
      return Promise.reject(new TypeError("Query task requires execute(signal)"));
    }
    const normalizedLane = this.normalizeLane(lane);
    const normalizedKey = String(key || `${normalizedLane}-${this.sequence + 1}`);
    const existing = this.tasksByKey.get(normalizedKey);
    const reusable = existing
      && existing.status !== "settled"
      && !existing.controller.signal.aborted
      && existing.consumers.size > 0;
    if (reusable) {
      this.promote(existing, normalizedLane);
      const shared = this.createConsumer(existing, { signal, scopeId, consumerId, lane: normalizedLane });
      this.drain();
      return shared;
    }
    if (existing && existing.status !== "settled") this.finishTask(existing);

    const task = {
      id: `query-${++this.sequence}`,
      key: normalizedKey,
      lane: normalizedLane,
      priority: this.priorityFor(normalizedLane),
      sequence: this.sequence,
      metadata: { ...metadata },
      execute,
      controller: new AbortController(),
      consumers: new Map(),
      status: "queued",
      queuedAt: Date.now(),
    };
    this.tasksByKey.set(task.key, task);
    this.queue.push(task);
    const promise = this.createConsumer(task, { signal, scopeId, consumerId, lane: normalizedLane });
    if (task.consumers.size === 0) {
      this.finishTask(task);
      return promise;
    }
    this.record("TASK_QUEUED", task);
    this.drain();
    return promise;
  }

  nextRunnableTask() {
    this.queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    const total = this.concurrency();
    const backgroundLimit = Math.max(1, total - 1);
    const backgroundActive = [...this.active.values()].filter((task) => !this.isForeground(task)).length;
    const index = this.queue.findIndex((task) => (
      this.isForeground(task) || backgroundActive < backgroundLimit
    ));
    if (index < 0) return null;
    return this.queue.splice(index, 1)[0];
  }

  dispatch(task) {
    if (!task || task.controller.signal.aborted || task.consumers.size === 0) {
      this.finishTask(task);
      return;
    }
    task.status = "active";
    this.active.set(task.id, task);
    this.record("TASK_DISPATCHED", task, { wait_ms: Math.max(0, Date.now() - task.queuedAt) });
    Promise.resolve()
      .then(() => task.execute(task.controller.signal))
      .then((value) => {
        for (const consumer of task.consumers.values()) {
          this.settleConsumer(consumer, consumer.resolve, value);
        }
      })
      .catch((error) => {
        for (const consumer of task.consumers.values()) {
          this.settleConsumer(consumer, consumer.reject, error);
        }
      })
      .finally(() => {
        this.finishTask(task);
        this.updateStats();
        this.drain();
      });
  }

  drain() {
    while (this.active.size < this.concurrency()) {
      const task = this.nextRunnableTask();
      if (!task) break;
      this.dispatch(task);
    }
    this.updateStats();
  }

  cancelScope(scopeId, { includeActive = true } = {}) {
    const normalized = String(scopeId || "");
    if (!normalized) return 0;
    let cancelled = 0;
    for (const task of [...this.queue, ...this.active.values()]) {
      if (!includeActive && task.status === "active") continue;
      for (const consumer of [...task.consumers.values()]) {
        if (consumer.scopeId !== normalized) continue;
        cancelled += 1;
        this.removeConsumer(task, consumer, this.abortError(`Query scope cancelled: ${normalized}`));
      }
    }
    this.drain();
    return cancelled;
  }

  cancelPending({ lane = "", predicate = null, includeActive = false } = {}) {
    const normalizedLane = lane ? this.normalizeLane(lane) : "";
    for (const task of [...this.queue, ...(includeActive ? this.active.values() : [])]) {
      if (predicate && !predicate(task)) continue;
      for (const consumer of [...task.consumers.values()]) {
        if (normalizedLane && consumer.lane !== normalizedLane && task.lane !== normalizedLane) continue;
        this.removeConsumer(task, consumer, this.abortError());
      }
    }
    this.drain();
  }

  snapshot() {
    const taskView = (task) => ({
      id: task.id,
      key: task.key,
      lane: task.lane,
      priority: task.priority,
      consumers: task.consumers.size,
      scopes: [...new Set([...task.consumers.values()].map((consumer) => consumer.scopeId).filter(Boolean))],
      metadata: task.metadata,
    });
    return {
      queued: this.queue.map(taskView),
      active: [...this.active.values()].map(taskView),
      concurrency: this.concurrency(),
    };
  }

  dispose() {
    const error = this.abortError("QueryScheduler disposed");
    for (const task of [...this.queue, ...this.active.values()]) {
      task.controller?.abort?.();
      for (const consumer of task.consumers.values()) {
        this.settleConsumer(consumer, consumer.reject, error);
      }
      task.consumers.clear();
    }
    this.queue.length = 0;
    this.active.clear();
    this.tasksByKey.clear();
    this.updateStats();
  }
}

function createLayerQueryCoordinator({ scheduler, fetchJson: fetchJsonFn } = {}) {
  if (!(scheduler instanceof QueryScheduler)) {
    throw new TypeError("LayerQueryCoordinator requires a QueryScheduler instance");
  }
  if (typeof fetchJsonFn !== "function") {
    throw new TypeError("LayerQueryCoordinator requires fetchJson");
  }
  function fetchEezAttribution(params, { signal = null, lane = "map-current", scopeId = "" } = {}) {
    const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
    const queryString = query.toString();
    return scheduler.schedule({
      key: `eez-attribution:${queryString}`,
      lane,
      signal,
      scopeId,
      metadata: { resource: "eez-attribution" },
      execute: (taskSignal) => fetchJsonFn(`/api/overlays/eez/attribution?${queryString}`, { signal: taskSignal }),
    });
  }

  return Object.freeze({
    PRIORITY: QueryScheduler.PRIORITY,
    cancelPending: scheduler.cancelPending.bind(scheduler),
    cancelScope: scheduler.cancelScope.bind(scheduler),
    fetchEezAttribution,
    promote: scheduler.promote.bind(scheduler),
    schedule: scheduler.schedule.bind(scheduler),
    snapshot: scheduler.snapshot.bind(scheduler),
    scheduler,
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.QueryScheduler = QueryScheduler;
  globalThis.createLayerQueryCoordinator = createLayerQueryCoordinator;
}
