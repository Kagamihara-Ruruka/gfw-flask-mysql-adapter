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
    this.rangeInflight = new Map();
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
      requested_intent_key: this.frameIdentity.requestedIntentKey(request),
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
      run_id: entry.runId,
      lane: entry.lane,
      scope_id: physicalScopeId,
    }));
    try {
      const sourcePacket = await this.queryBroker.requestSampledGrid(request, {
        operationId: intentKey,
        lane: entry.lane,
        signal: controller.signal,
        metadata: this.eventDetail(request, {
          run_id: entry.runId,
          resource: "sampled-grid",
          scope_id: physicalScopeId,
        }),
      });
      const packet = this.canonicalPacket(request, sourcePacket);
      const elapsedMs = this.clock.now() - startedAt;
      this.eventLog.record?.("QUERY_OPERATION_FINISHED", this.eventDetail(request, {
        run_id: entry.runId,
        lane: entry.lane,
        scope_id: physicalScopeId,
        duration_ms: elapsedMs,
        row_count: Number(packet?.row_count ?? packet?.frame?.rowCount ?? 0),
      }));
      this.sampledGridContract?.recordResolvedResolution?.(
        request.datasetId,
        packet?.grid || null,
        { bbox: request.bbox },
      );
      return this.dataFrameStore.put(request, packet, {
        lane: entry.lane,
        scopeId: physicalScopeId,
      });
    } catch (error) {
      const cancelled = error?.name === "AbortError" || controller.signal.aborted;
      this.eventLog.record?.(
        cancelled ? "QUERY_OPERATION_CANCELLED" : "QUERY_OPERATION_FAILED",
        this.eventDetail(request, {
          run_id: entry.runId,
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

  monthRange(request) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(request?.date || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || month < 1 || month > 12) return null;
    const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Object.freeze({
      start: `${match[1]}-${match[2]}-01`,
      end: `${match[1]}-${match[2]}-${String(endDay).padStart(2, "0")}`,
    });
  }

  rangeIntentKey(request, range) {
    return `range|${this.frameIdentity.intentKey({ ...request, date: range.start })}|${range.end}`;
  }

  rangeCovers(entry, request) {
    return Boolean(entry)
      && this.frameIdentity.scopeKey(entry.request) === this.frameIdentity.scopeKey(request)
      && String(request.date) >= entry.start
      && String(request.date) <= entry.end;
  }

  rangeUnsupported(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("records_range_packet")
      || message.includes("records_range") && message.includes("unsupported")
      || message.includes("unsupported query batch operation");
  }

  async fetchRangeRequest(entry) {
    const {
      request,
      controller,
      intentKey,
      physicalScopeId,
      start,
      end,
    } = entry;
    const startedAt = this.clock.now();
    this.eventLog.record?.("QUERY_RANGE_STARTED", this.eventDetail(request, {
      run_id: entry.runId,
      lane: entry.lane,
      scope_id: physicalScopeId,
      start,
      end,
    }));
    try {
      const rangePacket = await this.queryBroker.requestSampledGridRange(
        { ...request, start, end },
        {
          operationId: intentKey,
          lane: entry.lane,
          signal: controller.signal,
          metadata: this.eventDetail(request, {
            run_id: entry.runId,
            resource: "sampled-grid-range",
            scope_id: physicalScopeId,
            start,
            end,
          }),
        },
      );
      const stored = {};
      let rowCount = 0;
      for (const [date, sourcePacket] of Object.entries(rangePacket?.snapshots || {})) {
        const snapshotRequest = this.frameIdentity.normalizeRequest({ ...request, date });
        const packet = this.canonicalPacket(snapshotRequest, sourcePacket);
        rowCount += Number(packet?.row_count ?? packet?.frame?.rowCount ?? 0);
        this.sampledGridContract?.recordResolvedResolution?.(
          snapshotRequest.datasetId,
          packet?.grid || null,
          { bbox: snapshotRequest.bbox },
        );
        stored[date] = this.dataFrameStore.put(snapshotRequest, packet, {
          lane: entry.lane,
          scopeId: physicalScopeId,
          reason: "range-query",
        });
      }
      this.eventLog.record?.("QUERY_RANGE_FINISHED", this.eventDetail(request, {
        run_id: entry.runId,
        lane: entry.lane,
        scope_id: physicalScopeId,
        start,
        end,
        duration_ms: this.clock.now() - startedAt,
        snapshot_count: Object.keys(stored).length,
        row_count: rowCount,
        server_cache_hit: Boolean(rangePacket?.timing?.cache_hit),
      }));
      return Object.freeze({ rangePacket, stored: Object.freeze(stored) });
    } catch (error) {
      const cancelled = error?.name === "AbortError" || controller.signal.aborted;
      this.eventLog.record?.(
        cancelled ? "QUERY_RANGE_CANCELLED" : "QUERY_RANGE_FAILED",
        this.eventDetail(request, {
          run_id: entry.runId,
          lane: entry.lane,
          scope_id: physicalScopeId,
          start,
          end,
          error: error?.message || String(error),
        }),
      );
      throw error;
    }
  }

  createEntry(request, lane, runId = "") {
    const intentKey = this.frameIdentity.intentKey(request);
    const entry = {
      request,
      intentKey,
      lane: String(lane || "background"),
      runId: String(runId || ""),
      physicalScopeId: `frame-demand:${intentKey}`,
      controller: new AbortController(),
      consumers: new Map(),
      promise: null,
      settled: false,
      draining: false,
    };
    this.inflight.set(intentKey, entry);
    entry.promise = this.fetchRequest(entry).finally(() => {
      entry.settled = true;
      if (this.inflight.get(intentKey) === entry) this.inflight.delete(intentKey);
    });
    return entry;
  }

  createRangeEntry(request, range, lane, runId = "") {
    const intentKey = this.rangeIntentKey(request, range);
    const entry = {
      request,
      intentKey,
      start: range.start,
      end: range.end,
      lane: String(lane || "background"),
      runId: String(runId || ""),
      physicalScopeId: `frame-demand:${intentKey}`,
      controller: new AbortController(),
      consumers: new Map(),
      promise: null,
      settled: false,
      draining: false,
    };
    this.rangeInflight.set(intentKey, entry);
    entry.promise = this.fetchRangeRequest(entry).finally(() => {
      entry.settled = true;
      if (this.rangeInflight.get(intentKey) === entry) this.rangeInflight.delete(intentKey);
    });
    return entry;
  }

  releaseUnusedEntry(entry) {
    if (!entry || entry.settled || entry.consumers.size > 0) return;
    const operationStatus = this.queryBroker.operationStatus?.(entry.intentKey) || "missing";
    if (operationStatus === "active") {
      if (!entry.draining) {
        entry.draining = true;
        this.eventLog.record?.("QUERY_OPERATION_DRAINING", this.eventDetail(entry.request, {
          run_id: entry.runId,
          lane: entry.lane,
          scope_id: entry.physicalScopeId,
          reason: "consumer_scope_released",
        }));
      }
      return;
    }
    entry.controller.abort();
  }

  settleConsumer(entry, consumer, method, value) {
    if (!consumer || consumer.settled) return;
    consumer.settled = true;
    consumer.signal?.removeEventListener("abort", consumer.abortListener);
    entry.consumers.delete(consumer.id);
    method(value);
    this.releaseUnusedEntry(entry);
  }

  attachConsumer(entry, {
    signal = null,
    scopeId = "",
    consumerId = "",
    lane = "background",
    runId = "",
  } = {}) {
    if (!entry) return Promise.reject(new Error("Frame demand entry is unavailable"));
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (entry.draining) {
      entry.draining = false;
      this.eventLog.record?.("QUERY_OPERATION_REATTACHED", this.eventDetail(entry.request, {
        run_id: entry.runId,
        consumer_run_id: String(runId || ""),
        lane,
        scope_id: entry.physicalScopeId,
      }));
    }
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
    runId = undefined,
  } = {}) {
    this.assertActive();
    const request = this.frameIdentity.normalizeRequest(rawRequest);
    const demandRunId = runId === undefined
      ? String(this.eventLog.activeRunId?.() || "")
      : String(runId || "");
    if (signal?.aborted) throw this.abortError();
    if (!request.datasetId || !request.date || !request.bbox) {
      const error = new Error("Frame demand requires datasetId, date and canonical bbox");
      error.name = "FrameDemandError";
      throw error;
    }
    const existing = this.dataFrameStore.inspect(request);
    if (existing.status === "ready") {
      this.eventLog.record?.("CACHE_HIT", this.eventDetail(request, {
        run_id: demandRunId,
        frame_key: existing.frameKey,
        lane,
      }));
      return existing;
    }
    this.eventLog.record?.("CACHE_MISS", this.eventDetail(request, { run_id: demandRunId, lane }));
    this.dataFrameStore.clearFailure(request);

    const covering = [...this.inflight.values()].find((entry) => (
      this.dataFrameStore.canSatisfy?.(entry.request, request)
    ));
    if (covering) {
      if (this.frameIdentity.intentKey(covering.request) === this.frameIdentity.intentKey(request)) {
        return this.attachConsumer(covering, { lane, signal, scopeId, consumerId, runId: demandRunId });
      }
      this.eventLog.record?.("CACHE_WAIT", this.eventDetail(request, {
        run_id: demandRunId,
        lane,
        covering_intent_key: this.frameIdentity.intentKey(covering.request),
      }));
      try {
        await this.attachConsumer(covering, {
          lane,
          signal,
          scopeId,
          consumerId: `${consumerId || "covering"}:covering`,
          runId: demandRunId,
        });
        if (signal?.aborted) throw this.abortError();
        const reused = this.dataFrameStore.inspect(request);
        if (reused.status === "ready") {
          this.eventLog.record?.("CACHE_HIT", this.eventDetail(request, {
            run_id: demandRunId,
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

    const coveringRange = [...this.rangeInflight.values()].find((entry) => (
      this.rangeCovers(entry, request)
    ));
    if (coveringRange) {
      let fallbackToSingle = false;
      this.eventLog.record?.("CACHE_WAIT", this.eventDetail(request, {
        run_id: demandRunId,
        lane,
        covering_intent_key: coveringRange.intentKey,
        reuse: "inflight_month_range",
      }));
      try {
        await this.attachConsumer(coveringRange, {
          lane,
          signal,
          scopeId,
          consumerId: `${consumerId || "range"}:covering`,
          runId: demandRunId,
        });
      } catch (error) {
        if (error?.name === "AbortError" || !this.rangeUnsupported(error)) throw error;
        fallbackToSingle = true;
      }
      if (signal?.aborted) throw this.abortError();
      const reused = this.dataFrameStore.inspect(request);
      if (reused.status === "ready") {
        this.eventLog.record?.("CACHE_HIT", this.eventDetail(request, {
          run_id: demandRunId,
          frame_key: reused.frameKey,
          lane,
          reuse: "inflight_month_range",
        }));
        return reused;
      }
      if (!fallbackToSingle) {
        throw new Error(`Monthly frame range did not materialize ${request.date}`);
      }
    }

    if (allowPartial) {
      const missing = this.dataFrameStore.missingRegions(request);
      if (missing.length > 0 && missing.length <= 8 && missing.some((bbox) => bbox !== request.bbox)) {
        await Promise.all(missing.map((bbox, index) => this.demand(
          { ...request, bbox },
          {
            lane,
            signal,
            scopeId,
            consumerId: `${consumerId || "partial"}-${index}`,
            allowPartial: false,
            runId: demandRunId,
          },
        )));
        const materialized = this.dataFrameStore.materialize(request);
        if (materialized) return materialized;
      }
    }
    const intentKey = this.frameIdentity.intentKey(request);
    const entry = this.inflight.get(intentKey) || this.createEntry(request, lane, demandRunId);
    return this.attachConsumer(entry, { lane, signal, scopeId, consumerId, runId: demandRunId });
  }

  async demandMany(requests, {
    lane = "background",
    signal = null,
    scopeId = "",
    onProgress = null,
    runId = undefined,
    rangeMode = "individual",
  } = {}) {
    this.assertActive();
    const unique = new Map();
    for (const request of requests || []) {
      const normalized = this.frameIdentity.normalizeRequest(request);
      unique.set(this.frameIdentity.intentKey(normalized), normalized);
    }
    const progress = { total: unique.size, completed: 0, cacheHits: 0, fetched: 0, failed: 0 };
    const demandRunId = runId === undefined
      ? String(this.eventLog.activeRunId?.() || "")
      : String(runId || "");
    const reportSuccess = (request, result, kind) => {
      progress.completed += 1;
      if (kind === "cache") progress.cacheHits += 1;
      else progress.fetched += 1;
      onProgress?.({ ok: true, request, result, ...progress });
    };
    const reportFailure = (request, error) => {
      progress.completed += 1;
      progress.failed += 1;
      onProgress?.({ ok: false, request, error, ...progress });
    };
    const demandIndividually = async (group, offset = 0) => Promise.all(group.map(async (request, index) => {
      try {
        const result = await this.demand(request, {
          lane,
          signal,
          scopeId,
          consumerId: `${scopeId || lane}-${offset + index}`,
          runId: demandRunId,
        });
        reportSuccess(request, result, result.cacheHit ? "cache" : "fetch");
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        reportFailure(request, error);
      }
    }));

    const missing = [];
    for (const request of unique.values()) {
      const inspected = this.dataFrameStore.inspect(request);
      if (inspected.status === "ready") reportSuccess(request, inspected, "cache");
      else missing.push(request);
    }
    if (!missing.length) return progress;
    if (
      rangeMode !== "calendar_month"
      || typeof this.queryBroker.requestSampledGridRange !== "function"
    ) {
      await demandIndividually(missing);
      return progress;
    }

    const rangeGroups = new Map();
    const individual = [];
    for (const request of missing) {
      const range = this.monthRange(request);
      if (!range) {
        individual.push(request);
        continue;
      }
      const key = this.rangeIntentKey(request, range);
      const group = rangeGroups.get(key) || { key, range, requests: [] };
      group.requests.push(request);
      rangeGroups.set(key, group);
    }

    let individualOffset = 0;
    await Promise.all([
      ...[...rangeGroups.values()].map(async (group) => {
        const baseRequest = group.requests[0];
        const entry = this.rangeInflight.get(group.key)
          || this.createRangeEntry(baseRequest, group.range, lane, demandRunId);
        try {
          await this.attachConsumer(entry, {
            lane,
            signal,
            scopeId,
            consumerId: `${scopeId || lane}:range:${group.range.start}`,
            runId: demandRunId,
          });
          for (const request of group.requests) {
            const result = this.dataFrameStore.inspect(request);
            if (result.status !== "ready") {
              throw new Error(`Monthly frame range did not materialize ${request.date}`);
            }
            reportSuccess(request, result, "fetch");
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          if (this.rangeUnsupported(error)) {
            await demandIndividually(group.requests, individualOffset);
            individualOffset += group.requests.length;
            return;
          }
          for (const request of group.requests) {
            this.dataFrameStore.markFailed(request, error);
            reportFailure(request, error);
          }
        }
      }),
      ...(individual.length ? [demandIndividually(individual, missing.length)] : []),
    ]);
    return progress;
  }

  requestsForDates({ dates = [], ...context } = {}) {
    return [...new Set(dates.filter(Boolean))].map((date) => ({ ...context, date }));
  }

  demandRange(context, options = {}) {
    return this.demandMany(this.requestsForDates(context), {
      ...options,
      rangeMode: options.rangeMode || "calendar_month",
    });
  }

  cancelScope(scopeId, options) {
    const normalized = String(scopeId || "");
    if (!normalized) return 0;
    let cancelled = 0;
    const entries = [...this.inflight.values(), ...this.rangeInflight.values()];
    for (const entry of entries) {
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
    for (const entry of this.rangeInflight.values()) entry.controller.abort();
    this.inflight.clear();
    this.rangeInflight.clear();
  }
}

if (typeof globalThis !== "undefined") globalThis.FrameDemandServiceCore = FrameDemandServiceCore;
