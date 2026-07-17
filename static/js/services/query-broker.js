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
  if (!["batch.started", "batch.result", "batch.completed"].includes(type)) {
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
    params: Object.freeze({
      date: String(request?.date || ""),
      bbox: String(request?.bbox || ""),
      limit: request?.limit == null ? "max" : request.limit,
      columns: String(request?.columns || "render"),
      resolution: request?.queryResolution ?? request?.resolution ?? null,
      zoom: request?.zoom ?? null,
      latitude: request?.latitude ?? null,
    }),
  });
}

class QueryBroker {
  constructor({
    fetchFn,
    eventLog,
    clock,
    priorityForLane,
    maxBatchSizeProvider = null,
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
    this.maxBatchSizeProvider = maxBatchSizeProvider || (() => 3);
    this.endpoint = endpoint;
    this.pending = [];
    this.activeBatches = new Map();
    this.activeSources = new Set();
    this.sequence = 0;
    this.itemSequence = 0;
    this.flushScheduled = false;
    this.disposed = false;
  }

  maxBatchSize() {
    const numeric = Number(this.maxBatchSizeProvider());
    return Math.max(1, Math.min(32, Number.isFinite(numeric) ? Math.floor(numeric) : 3));
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

  activeBatchForSource(sourceKey) {
    return [...this.activeBatches.values()].find((batch) => batch.sourceKey === sourceKey) || null;
  }

  record(type, detail = {}) {
    this.eventLog.record?.(type, detail);
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
        abortListener: null,
      };
      item.abortListener = () => this.abortItem(item);
      signal?.addEventListener("abort", item.abortListener, { once: true });
      this.pending.push(item);
      const activeBatch = this.activeBatchForSource(this.sourceKey(operation));
      if (activeBatch && item.priority < activeBatch.priority && !activeBatch.preemptRequested) {
        activeBatch.preemptRequested = true;
        this.record("HTTP_BATCH_PREEMPT_REQUESTED", {
          batch_id: activeBatch.id,
          lane: activeBatch.lane,
          requested_lane: item.lane,
          source_key: activeBatch.sourceKey,
        });
      }
      this.scheduleFlush();
    });
  }

  requestSampledGrid(request, { operationId, ...options } = {}) {
    return this.request(sampledGridBatchOperation(request, operationId), options);
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
    const firstIndex = this.pending.findIndex((item) => !this.activeSources.has(this.sourceKey(item.operation)));
    if (firstIndex < 0) return null;
    const first = this.pending[firstIndex];
    const sourceKey = this.sourceKey(first.operation);
    const priority = first.priority;
    const selected = [];
    for (let index = 0; index < this.pending.length && selected.length < this.maxBatchSize(); index += 1) {
      const item = this.pending[index];
      if (item.priority !== priority || this.sourceKey(item.operation) !== sourceKey) continue;
      selected.push(item);
    }
    const selectedIds = new Set(selected.map((item) => item.id));
    this.pending = this.pending.filter((item) => !selectedIds.has(item.id));
    return { items: selected, lane: first.lane, priority, sourceKey };
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
      preemptRequested: false,
      preempted: false,
    };
    this.activeBatches.set(batchId, batch);
    this.activeSources.add(batch.sourceKey);
    this.record("HTTP_BATCH_STARTED", {
      batch_id: batchId,
      lane: batch.lane,
      operation_count: envelope.operations.length,
      source_key: batch.sourceKey,
    });

    const handleEvent = (rawEvent) => {
      const event = splitQueryBatchEvent(rawEvent, batchId);
      if (event.type !== "batch.result") return;
      const operationId = String(event.operation_id);
      if (batch.completedOperations.has(operationId)) {
        throw new Error(`Duplicate query batch result: ${operationId}`);
      }
      batch.completedOperations.add(operationId);
      const consumers = operationItems.get(operationId) || [];
      if (event.status === "ok") {
        for (const item of consumers) this.settle(item, item.resolve, event.packet);
      } else {
        const error = new Error(String(event.error || "Query batch operation failed"));
        error.name = "QueryBatchOperationError";
        for (const item of consumers) this.settle(item, item.reject, error);
      }
      if (batch.preemptRequested && batch.completedOperations.size < operationItems.size) {
        batch.preempted = true;
        return false;
      }
      return batch.completedOperations.size < operationItems.size;
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
        if (batch.preempted) {
          throw this.abortError("Query batch yielded to higher-priority demand");
        }
        for (const [operationId, consumers] of operationItems.entries()) {
          if (batch.completedOperations.has(operationId)) continue;
          const error = new Error(`Query batch result missing: ${operationId}`);
          for (const item of consumers) this.settle(item, item.reject, error);
        }
        this.record("HTTP_BATCH_FINISHED", {
          batch_id: batchId,
          lane: batch.lane,
          operation_count: envelope.operations.length,
          duration_ms: Math.max(0, this.clock.now() - batch.startedAt),
          source_key: batch.sourceKey,
        });
      })
      .catch((error) => {
        const cancelled = error?.name === "AbortError" || controller.signal.aborted;
        if (batch.preempted) {
          for (const item of items) {
            if (item.settled || item.signal?.aborted) continue;
            item.batchId = "";
            this.pending.push(item);
          }
          this.record("HTTP_BATCH_PREEMPTED", {
            batch_id: batchId,
            lane: batch.lane,
            operation_count: envelope.operations.length,
            duration_ms: Math.max(0, this.clock.now() - batch.startedAt),
            source_key: batch.sourceKey,
          });
          return;
        }
        for (const item of items) {
          if (!item.settled) this.settle(item, item.reject, cancelled ? this.abortError() : error);
        }
        this.record(cancelled ? "HTTP_BATCH_CANCELLED" : "HTTP_BATCH_FAILED", {
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
        this.activeSources.delete(batch.sourceKey);
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
      maxBatchSize: this.maxBatchSize(),
    });
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
    this.activeSources.clear();
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.QueryBroker = QueryBroker;
  globalThis.compileQueryBatch = compileQueryBatch;
  globalThis.sampledGridBatchOperation = sampledGridBatchOperation;
  globalThis.splitQueryBatchEvent = splitQueryBatchEvent;
}
