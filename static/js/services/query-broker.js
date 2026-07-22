function compileQueryBatch(items, batchId) {
  const operations = new Map();
  for (const item of items || []) {
    const operation = item?.operation || {};
    const operationId = String(operation.operation_id || "");
    if (!operationId || operations.has(operationId)) continue;
    operations.set(operationId, Object.freeze({
      operation_id: operationId,
      kind: String(operation.kind || ""),
      dataset_id: String(operation.dataset_id || ""),
      lane: String(item?.lane || "foreground"),
      params: Object.freeze({ ...(operation.params || {}) }),
    }));
  }
  return Object.freeze({
    schema: "query_batch.v1",
    batch_id: String(batchId || ""),
    operations: Object.freeze([...operations.values()]),
  });
}

function splitQueryBatchEvent(rawEvent, expectedBatchId) {
  const event = rawEvent && typeof rawEvent === "object" ? rawEvent : {};
  const batchId = String(event.batch_id || "");
  if (batchId !== String(expectedBatchId || "")) {
    throw new Error(`Query batch response mismatch: ${batchId || "<missing>"}`);
  }
  const type = String(event.type || "");
  if (!["batch.started", "batch.result", "batch.completed", "batch.metrics"].includes(type)) {
    throw new Error(`Unsupported query batch event: ${type || "<missing>"}`);
  }
  if (type === "batch.result" && !String(event.operation_id || "")) {
    throw new Error("Query batch result is missing operation_id");
  }
  return Object.freeze({ ...event, batch_id: batchId, type });
}

function sampledGridBatchOperation(request, operationId) {
  return Object.freeze({
    operation_id: String(operationId || ""),
    kind: "sampled_grid.records",
    dataset_id: String(request?.datasetId || ""),
    source_key: String(request?.transportKey || ""),
    query_backend: String(request?.queryBackend || ""),
    params: Object.freeze({
      date: String(request?.date || ""),
      bbox: String(request?.bbox || ""),
      limit: request?.limit == null ? "max" : request.limit,
      columns: String(request?.columns || "render"),
      resolution: request?.queryResolution ?? request?.resolution ?? null,
    }),
  });
}

function sampledGridRangeBatchOperation(request, operationId) {
  return Object.freeze({
    operation_id: String(operationId || ""),
    kind: "sampled_grid.records_range",
    dataset_id: String(request?.datasetId || ""),
    source_key: String(request?.transportKey || ""),
    query_backend: String(request?.queryBackend || ""),
    params: Object.freeze({
      start: String(request?.start || request?.startDate || ""),
      end: String(request?.end || request?.endDate || ""),
      bbox: String(request?.bbox || ""),
      limit: request?.limit == null ? "max" : request.limit,
      columns: String(request?.columns || "render"),
      resolution: request?.queryResolution ?? request?.resolution ?? null,
    }),
  });
}

function decodeSampledGridBatchPacket(packet) {
  if (String(packet?.snapshot_profile || "") !== "canonical_frame") {
    return decodeCanonicalGridFramePacket(packet);
  }
  const sourceSnapshots = packet?.snapshots;
  if (!sourceSnapshots || typeof sourceSnapshots !== "object" || Array.isArray(sourceSnapshots)) {
    throw new Error("Canonical sampled-grid range packet is missing snapshots");
  }
  const snapshots = Object.fromEntries(Object.entries(sourceSnapshots).map(([date, snapshot]) => (
    [String(date), decodeCanonicalGridFramePacket(snapshot)]
  )));
  return Object.freeze({ ...packet, snapshots: Object.freeze(snapshots) });
}

class QueryBroker {
  constructor({
    fetchFn,
    eventLog,
    clock,
    priorityForLane,
    batchSizeProvider = null,
    sourceCapacityProvider = null,
    endpoint = "/api/query/batch",
  } = {}) {
    if (typeof fetchFn !== "function" || !eventLog || !clock || typeof clock.now !== "function") {
      throw new TypeError("QueryBroker requires fetch, event log and monotonic clock");
    }
    if (typeof priorityForLane !== "function") {
      throw new TypeError("QueryBroker requires a lane priority provider");
    }
    this.fetch = fetchFn;
    this.eventLog = eventLog;
    this.clock = clock;
    this.priorityForLane = priorityForLane;
    this.batchSizeProvider = batchSizeProvider || (() => 1);
    this.sourceCapacityProvider = sourceCapacityProvider || (() => 1);
    this.endpoint = endpoint;
    this.pending = [];
    this.activeBatches = new Map();
    this.sequence = 0;
    this.itemSequence = 0;
    this.flushScheduled = false;
    this.disposed = false;
  }

  batchSize(sourceKey) {
    const numeric = Number(this.batchSizeProvider(String(sourceKey || "")));
    return Math.max(1, Math.min(32, Number.isFinite(numeric) ? Math.floor(numeric) : 1));
  }

  sourceCapacity(sourceKey) {
    const numeric = Number(this.sourceCapacityProvider(String(sourceKey || "")));
    return Math.max(1, Math.min(16, Number.isFinite(numeric) ? Math.floor(numeric) : 1));
  }

  sourceInflightCount(sourceKey) {
    const normalizedKey = String(sourceKey || "");
    return [...this.activeBatches.values()].reduce((total, batch) => {
      if (batch.executionSourceKey !== normalizedKey) return total;
      return total + (batch.envelope?.operations || []).reduce((count, operation) => (
        batch.completedOperations.has(String(operation.operation_id || "")) ? count : count + 1
      ), 0);
    }, 0);
  }

  sourceAvailableSlots(sourceKey) {
    return Math.max(0, this.sourceCapacity(sourceKey) - this.sourceInflightCount(sourceKey));
  }

  abortError(reason = "Query batch consumer cancelled") {
    const error = new Error(reason);
    error.name = "AbortError";
    return error;
  }

  sourceKey(operation) {
    return String(operation?.source_key || "")
      || `${String(operation?.kind || "")}|${String(operation?.dataset_id || "")}`;
  }

  queryLane(lane) {
    return ["background", "playback-window", "widget-auto"].includes(String(lane || ""))
      ? "background"
      : "foreground";
  }

  executionSourceKey(item) {
    const sourceKey = this.sourceKey(item?.operation);
    if (String(item?.operation?.query_backend || "").toLowerCase() !== "hive") return sourceKey;
    return `${sourceKey}|query_lane=${this.queryLane(item?.lane)}`;
  }

  record(type, detail = {}) {
    this.eventLog.record?.(type, detail);
  }

  taskDetail(item, extra = {}) {
    return {
      ...(item?.metadata || {}),
      task_id: item?.id || "",
      intent_key: String(item?.operation?.operation_id || ""),
      lane: item?.lane || "",
      queue_depth: this.pending.filter((candidate) => !candidate.settled).length,
      active_count: this.activeBatches.size,
      source_key: this.sourceKey(item?.operation),
      ...extra,
    };
  }

  batchTraceDetail(items) {
    const operationIds = [...new Set((items || []).map((item) => (
      String(item?.operation?.operation_id || "")
    )).filter(Boolean))];
    const runIds = [...new Set((items || []).map((item) => (
      String(item?.metadata?.run_id || "")
    )).filter(Boolean))];
    return {
      run_id: runIds.length === 1 ? runIds[0] : "",
      run_ids: runIds,
      operation_ids: operationIds,
    };
  }

  promoteOperation(operationId, lane) {
    const normalizedId = String(operationId || "");
    const nextLane = String(lane || "background");
    const nextPriority = Number(this.priorityForLane(nextLane));
    if (!normalizedId || !Number.isFinite(nextPriority)) return false;
    const candidates = [
      ...this.pending,
      ...[...this.activeBatches.values()].flatMap((batch) => batch.items),
    ];
    let promoted = false;
    for (const item of candidates) {
      if (item.settled || String(item.operation?.operation_id || "") !== normalizedId) continue;
      if (nextPriority >= item.priority) continue;
      const previousLane = item.lane;
      item.lane = nextLane;
      item.priority = nextPriority;
      promoted = true;
      this.record("TASK_PROMOTED", this.taskDetail(item, {
        previous_lane: previousLane,
        requested_lane: nextLane,
        preempt_required: false,
      }));
    }
    if (promoted) this.scheduleFlush();
    return promoted;
  }

  settle(item, method, value) {
    if (!item || item.settled) return;
    item.settled = true;
    item.signal?.removeEventListener("abort", item.abortListener);
    method(value);
  }

  abortItem(item) {
    this.settle(item, item.reject, this.abortError());
    const batch = item.batchId ? this.activeBatches.get(item.batchId) : null;
    if (batch && batch.items.every((candidate) => candidate.settled)) {
      batch.controller.abort();
    }
  }

  request(operation, {
    lane = "background",
    signal = null,
    metadata = {},
  } = {}) {
    if (this.disposed) return Promise.reject(new Error("QueryBroker is disposed"));
    if (!operation?.operation_id || !operation?.kind || !operation?.params) {
      return Promise.reject(new Error("QueryBroker requires a complete query operation"));
    }
    if (signal?.aborted) return Promise.reject(this.abortError());
    return new Promise((resolve, reject) => {
      const item = {
        id: `broker-item-${++this.itemSequence}`,
        sequence: this.itemSequence,
        operation,
        lane: String(lane || "background"),
        priority: Number(this.priorityForLane(lane)),
        signal,
        metadata: { ...metadata },
        resolve,
        reject,
        settled: false,
        batchId: "",
        queuedMonotonicMs: this.clock.now(),
        abortListener: null,
      };
      item.abortListener = () => this.abortItem(item);
      signal?.addEventListener("abort", item.abortListener, { once: true });
      this.pending.push(item);
      this.record("TASK_QUEUED", this.taskDetail(item));
      this.scheduleFlush();
    });
  }

  requestSampledGrid(request, { operationId, ...options } = {}) {
    return this.request(sampledGridBatchOperation(request, operationId), options);
  }

  requestSampledGridRange(request, { operationId, ...options } = {}) {
    return this.request(sampledGridRangeBatchOperation(request, operationId), options);
  }

  promoteSampledGrid(operationId, lane) {
    return this.promoteOperation(operationId, lane);
  }

  operationStatus(operationId) {
    const normalizedId = String(operationId || "");
    if (!normalizedId) return "missing";
    if (this.pending.some((item) => (
      !item.settled && String(item.operation?.operation_id || "") === normalizedId
    ))) return "queued";
    if ([...this.activeBatches.values()].some((batch) => batch.items.some((item) => (
      !item.settled && String(item.operation?.operation_id || "") === normalizedId
    )))) return "active";
    return "missing";
  }

  scheduleFlush() {
    if (this.flushScheduled || this.disposed) return;
    this.flushScheduled = true;
    Promise.resolve().then(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  nextBatch() {
    this.pending = this.pending.filter((item) => !item.settled && !item.signal?.aborted);
    this.pending.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    const firstIndex = this.pending.findIndex((item) => (
      this.sourceAvailableSlots(this.executionSourceKey(item)) > 0
    ));
    if (firstIndex < 0) return null;
    const first = this.pending[firstIndex];
    const sourceKey = this.sourceKey(first.operation);
    const executionSourceKey = this.executionSourceKey(first);
    const priority = first.priority;
    const effectiveBatchSize = Math.min(
      this.batchSize(sourceKey),
      this.sourceAvailableSlots(executionSourceKey),
    );
    const selected = [];
    for (let index = 0; index < this.pending.length && selected.length < effectiveBatchSize; index += 1) {
      const item = this.pending[index];
      if (
        item.priority !== priority
        || this.sourceKey(item.operation) !== sourceKey
        || this.executionSourceKey(item) !== executionSourceKey
      ) continue;
      selected.push(item);
    }
    const selectedIds = new Set(selected.map((item) => item.id));
    this.pending = this.pending.filter((item) => !selectedIds.has(item.id));
    return { items: selected, lane: first.lane, priority, sourceKey, executionSourceKey };
  }

  flush() {
    if (this.disposed) return;
    while (true) {
      const batch = this.nextBatch();
      if (!batch) break;
      this.dispatch(batch);
    }
  }

  async responseError(response) {
    try {
      const payload = await response.json();
      return new Error(payload?.error || response.statusText || `HTTP ${response.status}`);
    } catch (_error) {
      return new Error(response.statusText || `HTTP ${response.status}`);
    }
  }

  async readEvents(response, onEvent) {
    if (!response.body?.getReader) {
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && onEvent(JSON.parse(line)) === false) break;
      }
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line && onEvent(JSON.parse(line)) === false) {
          await reader.cancel();
          return;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  dispatch(batchPlan) {
    const batchId = `query-batch-${++this.sequence}`;
    const items = batchPlan.items.filter((item) => !item.settled && !item.signal?.aborted);
    if (!items.length) {
      this.scheduleFlush();
      return;
    }
    const controller = new AbortController();
    const envelope = compileQueryBatch(items, batchId);
    const operationItems = new Map();
    for (const item of items) {
      item.batchId = batchId;
      const operationId = item.operation.operation_id;
      if (!operationItems.has(operationId)) operationItems.set(operationId, []);
      operationItems.get(operationId).push(item);
    }
    const batch = {
      id: batchId,
      ...batchPlan,
      items,
      controller,
      envelope,
      completedOperations: new Set(),
      startedAt: this.clock.now(),
      transportMetrics: null,
      frameDecodeMs: 0,
      trace: this.batchTraceDetail(items),
    };
    this.activeBatches.set(batchId, batch);
    for (const item of items) {
      this.record("TASK_DISPATCHED", this.taskDetail(item, {
        batch_id: batchId,
        wait_ms: Math.max(0, this.clock.now() - Number(item.queuedMonotonicMs || 0)),
      }));
    }
    this.record("HTTP_BATCH_STARTED", {
      ...batch.trace,
      batch_id: batchId,
      lane: batch.lane,
      operation_count: envelope.operations.length,
      source_key: batch.sourceKey,
    });

    const handleEvent = (rawEvent) => {
      const event = splitQueryBatchEvent(rawEvent, batchId);
      if (event.type === "batch.metrics") {
        batch.transportMetrics = event.metrics || null;
        return;
      }
      if (event.type !== "batch.result") return;
      const operationId = String(event.operation_id);
      if (batch.completedOperations.has(operationId)) {
        throw new Error(`Duplicate query batch result: ${operationId}`);
      }
      batch.completedOperations.add(operationId);
      const consumers = operationItems.get(operationId) || [];
      if (event.status === "ok") {
        const decodeStartedAt = this.clock.now();
        const packet = decodeSampledGridBatchPacket(event.packet);
        batch.frameDecodeMs += Math.max(0, this.clock.now() - decodeStartedAt);
        for (const item of consumers) this.settle(item, item.resolve, packet);
      } else {
        const error = new Error(String(event.error || "Query batch operation failed"));
        error.name = "QueryBatchOperationError";
        for (const item of consumers) this.settle(item, item.reject, error);
      }
      this.scheduleFlush();
    };

    Promise.resolve()
      .then(async () => {
        const response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify(envelope),
          signal: controller.signal,
        });
        if (!response.ok) throw await this.responseError(response);
        await this.readEvents(response, handleEvent);
        for (const [operationId, consumers] of operationItems.entries()) {
          if (batch.completedOperations.has(operationId)) continue;
          const error = new Error(`Query batch result missing: ${operationId}`);
          for (const item of consumers) this.settle(item, item.reject, error);
        }
        this.record("HTTP_BATCH_FINISHED", {
          ...batch.trace,
          batch_id: batchId,
          lane: batch.lane,
          operation_count: envelope.operations.length,
          duration_ms: Math.max(0, this.clock.now() - batch.startedAt),
          source_key: batch.sourceKey,
          canonical_frame_decode_ms: batch.frameDecodeMs,
          ...(batch.transportMetrics || {}),
        });
      })
      .catch((error) => {
        const cancelled = error?.name === "AbortError" || controller.signal.aborted;
        for (const item of items) {
          if (!item.settled) this.settle(item, item.reject, cancelled ? this.abortError() : error);
        }
        this.record(cancelled ? "HTTP_BATCH_CANCELLED" : "HTTP_BATCH_FAILED", {
          ...batch.trace,
          batch_id: batchId,
          lane: batch.lane,
          operation_count: envelope.operations.length,
          duration_ms: Math.max(0, this.clock.now() - batch.startedAt),
          source_key: batch.sourceKey,
          error: error?.message || String(error),
        });
      })
      .finally(() => {
        this.activeBatches.delete(batchId);
        this.scheduleFlush();
      });
  }

  snapshot() {
    return Object.freeze({
      queuedOperations: this.pending.filter((item) => !item.settled).length,
      activeBatches: this.activeBatches.size,
      activeOperations: [...this.activeBatches.values()].reduce(
        (total, batch) => total + batch.items.filter((item) => !item.settled).length,
        0,
      ),
      sourceInflight: Object.freeze(Object.fromEntries(
        [...new Set([
          ...this.pending.map((item) => this.executionSourceKey(item)),
          ...[...this.activeBatches.values()].map((batch) => batch.executionSourceKey),
        ])].map((sourceKey) => [sourceKey, Object.freeze({
          capacity: this.sourceCapacity(sourceKey),
          effectiveBatchSize: this.batchSize(sourceKey),
          inFlight: this.sourceInflightCount(sourceKey),
        })]),
      )),
    });
  }

  reconcilePolicy() {
    this.scheduleFlush();
    return this.snapshot();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = this.abortError("QueryBroker disposed");
    for (const item of this.pending) this.settle(item, item.reject, error);
    this.pending.length = 0;
    for (const batch of this.activeBatches.values()) {
      batch.controller.abort();
      for (const item of batch.items) this.settle(item, item.reject, error);
    }
    this.activeBatches.clear();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.QueryBroker = QueryBroker;
  globalThis.compileQueryBatch = compileQueryBatch;
  globalThis.sampledGridBatchOperation = sampledGridBatchOperation;
  globalThis.sampledGridRangeBatchOperation = sampledGridRangeBatchOperation;
  globalThis.decodeSampledGridBatchPacket = decodeSampledGridBatchPacket;
  globalThis.splitQueryBatchEvent = splitQueryBatchEvent;
}
