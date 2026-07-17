class FrameDemandServiceCore {
  constructor({
    frameIdentity,
    queryBroker,
    dataFrameStore,
    eventLog,
    sampledGridContract = null,
    clock,
  } = {}) {
    if (!frameIdentity || !queryBroker || !dataFrameStore || !eventLog) {
      throw new TypeError("FrameDemandService requires identity, broker, store and event log");
    }
    if (!clock || typeof clock.now !== "function") {
      throw new TypeError("FrameDemandService requires a monotonic clock");
    }
    this.frameIdentity = frameIdentity;
    this.queryBroker = queryBroker;
    this.dataFrameStore = dataFrameStore;
    this.eventLog = eventLog;
    this.sampledGridContract = sampledGridContract;
    this.clock = clock;
    this.inflight = new Map();
    this.consumerSequence = 0;
    this.disposed = false;
  }

  assertActive() {
    if (this.disposed) throw new Error("FrameDemandService is disposed");
  }

  abortError(reason = "Frame demand cancelled") {
    const error = new Error(reason);
    error.name = "AbortError";
    return error;
  }

  eventDetail(request, extra = {}) {
    return {
      intent_key: this.frameIdentity.intentKey(request),
      scope_key: this.frameIdentity.scopeKey(request),
      dataset: request.datasetId,
      layer_id: request.layerId || "",
      date: request.date,
      bbox: request.bbox,
      requested_resolution_km: request.resolution,
      effective_query_resolution_km: this.frameIdentity.queryResolution(request),
      ...extra,
    };
  }

  canonicalPacket(request, packet) {
    const sourceGrid = packet?.grid && typeof packet.grid === "object" ? packet.grid : {};
    const requestedResolution = Number(request.resolution);
    const effectiveQueryResolution = Number(this.frameIdentity.queryResolution(request));
    const actualResolution = Number(this.frameIdentity.actualResolutionFrom(packet, {
      ...request,
      resolution: effectiveQueryResolution,
    }));
    const normalizedRequested = Number.isFinite(requestedResolution) && requestedResolution > 0
      ? requestedResolution
      : null;
    const normalizedQuery = Number.isFinite(effectiveQueryResolution) && effectiveQueryResolution > 0
      ? effectiveQueryResolution
      : normalizedRequested;
    const normalizedActual = Number.isFinite(actualResolution) && actualResolution > 0
      ? actualResolution
      : normalizedQuery;
    return {
      ...(packet || {}),
      grid: {
        ...sourceGrid,
        source_requested_resolution_km: sourceGrid.requested_resolution_km ?? normalizedQuery,
        requested_resolution_km: normalizedRequested,
        effective_query_resolution_km: normalizedQuery,
        actual_resolution_km: normalizedActual,
        lod_degraded: Number.isFinite(normalizedRequested)
          && Number.isFinite(normalizedActual)
          && normalizedActual > normalizedRequested,
      },
    };
  }

  async fetchRequest(entry) {
    const { request, controller, intentKey, physicalScopeId } = entry;
    const startedAt = this.clock.now();
    this.eventLog.record?.("QUERY_OPERATION_STARTED", this.eventDetail(request, {
      lane: entry.lane,
      scope_id: physicalScopeId,
    }));
    try {
      const sourcePacket = await this.queryBroker.requestSampledGrid(request, {
        operationId: intentKey,
        lane: entry.lane,
        signal: controller.signal,
        metadata: this.eventDetail(request, {
          resource: "sampled-grid",
          scope_id: physicalScopeId,
        }),
      });
      const packet = this.canonicalPacket(request, sourcePacket);
      const elapsedMs = this.clock.now() - startedAt;
      this.eventLog.record?.("QUERY_OPERATION_FINISHED", this.eventDetail(request, {
        lane: entry.lane,
        scope_id: physicalScopeId,
        duration_ms: elapsedMs,
        row_count: Number(packet?.row_count || packet?.rows?.length || 0),
      }));
      this.sampledGridContract?.recordResolvedResolution?.(request.datasetId, packet?.grid || null);
      return this.dataFrameStore.put(request, packet, {
        lane: entry.lane,
        scopeId: physicalScopeId,
      });
    } catch (error) {
      const cancelled = error?.name === "AbortError" || controller.signal.aborted;
      this.eventLog.record?.(
        cancelled ? "QUERY_OPERATION_CANCELLED" : "QUERY_OPERATION_FAILED",
        this.eventDetail(request, {
          lane: entry.lane,
          scope_id: physicalScopeId,
          error: error?.message || String(error),
          reason: cancelled ? "query_cancelled" : "request_failed",
        }),
      );
      if (!cancelled) this.dataFrameStore.markFailed(request, error);
      throw error;
    }
  }

  createEntry(request, lane) {
    const intentKey = this.frameIdentity.intentKey(request);
    const entry = {
      request,
      intentKey,
      lane: String(lane || "background"),
      physicalScopeId: `frame-demand:${intentKey}`,
      controller: new AbortController(),
      consumers: new Map(),
      promise: null,
      settled: false,
    };
    this.inflight.set(intentKey, entry);
    entry.promise = this.fetchRequest(entry).finally(() => {
      entry.settled = true;
      if (this.inflight.get(intentKey) === entry) this.inflight.delete(intentKey);
    });
    return entry;
  }

  settleConsumer(entry, consumer, method, value) {
    if (!consumer || consumer.settled) return;
    consumer.settled = true;
    consumer.signal?.removeEventListener("abort", consumer.abortListener);
    entry.consumers.delete(consumer.id);
    method(value);
    if (!entry.settled && entry.consumers.size === 0) entry.controller.abort();
  }

  attachConsumer(entry, { signal = null, scopeId = "", consumerId = "", lane = "background" } = {}) {
    if (!entry) return Promise.reject(new Error("Frame demand entry is unavailable"));
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (this.queryBroker.promoteSampledGrid?.(entry.intentKey, lane)) entry.lane = String(lane);
    const id = `${String(consumerId || "consumer")}:${++this.consumerSequence}`;
    return new Promise((resolve, reject) => {
      const consumer = {
        id,
        scopeId: String(scopeId || ""),
        signal,
        settled: false,
        abortListener: null,
        resolve,
        reject,
      };
      consumer.abortListener = () => this.settleConsumer(entry, consumer, reject, this.abortError());
      signal?.addEventListener("abort", consumer.abortListener, { once: true });
      entry.consumers.set(id, consumer);
      entry.promise.then(
        (value) => this.settleConsumer(entry, consumer, resolve, value),
        (error) => this.settleConsumer(entry, consumer, reject, error),
      );
    });
  }

  async demand(rawRequest, {
    lane = "background",
    signal = null,
    scopeId = "",
    consumerId = "",
    allowPartial = false,
  } = {}) {
    this.assertActive();
    const request = this.frameIdentity.normalizeRequest(rawRequest);
    if (signal?.aborted) throw this.abortError();
    if (!request.datasetId || !request.date || !request.bbox) {
      const error = new Error("Frame demand requires datasetId, date and canonical bbox");
      error.name = "FrameDemandError";
      throw error;
    }
    const existing = this.dataFrameStore.inspect(request);
    if (existing.status === "ready") {
      this.eventLog.record?.("CACHE_HIT", this.eventDetail(request, { frame_key: existing.frameKey, lane }));
      return existing;
    }
    this.eventLog.record?.("CACHE_MISS", this.eventDetail(request, { lane }));
    this.dataFrameStore.clearFailure(request);

    const covering = [...this.inflight.values()].find((entry) => (
      this.dataFrameStore.canSatisfy?.(entry.request, request)
    ));
    if (covering) {
      if (this.frameIdentity.intentKey(covering.request) === this.frameIdentity.intentKey(request)) {
        return this.attachConsumer(covering, { lane, signal, scopeId, consumerId });
      }
      this.eventLog.record?.("CACHE_WAIT", this.eventDetail(request, {
        lane,
        covering_intent_key: this.frameIdentity.intentKey(covering.request),
      }));
      try {
        await this.attachConsumer(covering, {
          lane,
          signal,
          scopeId,
          consumerId: `${consumerId || "covering"}:covering`,
        });
        if (signal?.aborted) throw this.abortError();
        const reused = this.dataFrameStore.inspect(request);
        if (reused.status === "ready") {
          this.eventLog.record?.("CACHE_HIT", this.eventDetail(request, {
            frame_key: reused.frameKey,
            lane,
            reuse: "inflight_covered_bbox",
          }));
          return reused;
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
    }

    if (allowPartial) {
      const missing = this.dataFrameStore.missingRegions(request);
      if (missing.length > 0 && missing.length <= 8 && missing.some((bbox) => bbox !== request.bbox)) {
        await Promise.all(missing.map((bbox, index) => this.demand(
          { ...request, bbox },
          { lane, signal, scopeId, consumerId: `${consumerId || "partial"}-${index}`, allowPartial: false },
        )));
        const materialized = this.dataFrameStore.materialize(request);
        if (materialized) return materialized;
      }
    }
    const intentKey = this.frameIdentity.intentKey(request);
    const entry = this.inflight.get(intentKey) || this.createEntry(request, lane);
    return this.attachConsumer(entry, { lane, signal, scopeId, consumerId });
  }

  async demandMany(requests, {
    lane = "background",
    signal = null,
    scopeId = "",
    onProgress = null,
  } = {}) {
    this.assertActive();
    const unique = new Map();
    for (const request of requests || []) {
      const normalized = this.frameIdentity.normalizeRequest(request);
      unique.set(this.frameIdentity.intentKey(normalized), normalized);
    }
    const progress = { total: unique.size, completed: 0, cacheHits: 0, fetched: 0, failed: 0 };
    await Promise.all([...unique.values()].map(async (request, index) => {
      try {
        const result = await this.demand(request, {
          lane,
          signal,
          scopeId,
          consumerId: `${scopeId || lane}-${index}`,
        });
        progress.completed += 1;
        if (result.cacheHit) progress.cacheHits += 1;
        else progress.fetched += 1;
        onProgress?.({ ok: true, request, result, ...progress });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        progress.completed += 1;
        progress.failed += 1;
        onProgress?.({ ok: false, request, error, ...progress });
      }
    }));
    return progress;
  }

  requestsForDates({ dates = [], ...context } = {}) {
    return [...new Set(dates.filter(Boolean))].map((date) => ({ ...context, date }));
  }

  demandRange(context, options = {}) {
    return this.demandMany(this.requestsForDates(context), options);
  }

  cancelScope(scopeId, options) {
    const normalized = String(scopeId || "");
    if (!normalized) return 0;
    let cancelled = 0;
    for (const entry of this.inflight.values()) {
      if (
        options?.includeActive === false
        && this.queryBroker.operationStatus?.(entry.intentKey) === "active"
      ) continue;
      for (const consumer of [...entry.consumers.values()]) {
        if (consumer.scopeId !== normalized) continue;
        cancelled += 1;
        this.settleConsumer(entry, consumer, consumer.reject, this.abortError(`Frame demand scope cancelled: ${normalized}`));
      }
    }
    if (cancelled > 0) {
      this.eventLog.record?.("QUERY_SCOPE_CANCELLED", {
        scope_id: normalized,
        cancelled_consumers: cancelled,
        include_active: options?.includeActive !== false,
      });
    }
    return cancelled;
  }

  inspect(request) {
    return this.dataFrameStore.inspect(this.frameIdentity.normalizeRequest(request));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
  }
}

if (typeof globalThis !== "undefined") globalThis.FrameDemandServiceCore = FrameDemandServiceCore;
