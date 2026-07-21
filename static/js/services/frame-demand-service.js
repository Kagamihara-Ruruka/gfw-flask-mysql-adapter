function createFrameDemandService({
  frameIdentity,
  queryCoordinator,
  dataFrameStore,
  eventLog,
  fetchJson: fetchJsonFn,
  sampledGridContract = null,
  clock,
} = {}) {
  if (!frameIdentity || !queryCoordinator || !dataFrameStore || !eventLog) {
    throw new TypeError("FrameDemandService requires identity, coordinator, store and event log");
  }
  if (typeof fetchJsonFn !== "function") throw new TypeError("FrameDemandService requires fetchJson");
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("FrameDemandService requires a monotonic clock");
  }
  const FrameIdentity = frameIdentity;
  const LayerQueryCoordinator = queryCoordinator;
  const DataFrameStore = dataFrameStore;
  const LifecycleEventLog = eventLog;
  const SampledGridContract = sampledGridContract;
  const inflight = new Map();
  function abortError(reason = "Frame demand cancelled") {
    const error = new Error(reason);
    error.name = "AbortError";
    return error;
  }

  function waitWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const handleAbort = () => reject(abortError());
      signal.addEventListener("abort", handleAbort, { once: true });
      Promise.resolve(promise)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", handleAbort));
    });
  }
  function urlFor(request) {
    const params = new URLSearchParams();
    params.set("date", request.date);
    params.set("limit", request.limit == null ? "max" : String(request.limit));
    params.set("bbox", request.bbox);
    if (request.aoi) params.set("aoi", request.aoi);
    if (request.columns) params.set("columns", request.columns);
    const effectiveQueryResolution = FrameIdentity.queryResolution(request);
    if (effectiveQueryResolution != null) params.set("resolution", String(effectiveQueryResolution));
    if (request.zoom != null) params.set("zoom", String(request.zoom));
    if (request.latitude != null) params.set("latitude", String(request.latitude));
    return `/api/datasets/${request.datasetId}/records?${params}`;
  }

  function eventDetail(request, extra = {}) {
    return {
      intent_key: FrameIdentity.intentKey(request),
      scope_key: FrameIdentity.scopeKey(request),
      dataset: request.datasetId,
      layer_id: request.layerId || "",
      date: request.date,
      bbox: request.bbox,
      aoi: request.aoi || "",
      requested_resolution_km: request.resolution,
      effective_query_resolution_km: FrameIdentity.queryResolution(request),
      ...extra,
    };
  }

  function canonicalPacket(request, packet) {
    const sourceGrid = packet?.grid && typeof packet.grid === "object" ? packet.grid : {};
    const requestedResolution = Number(request.resolution);
    const effectiveQueryResolution = Number(FrameIdentity.queryResolution(request));
    const actualResolution = Number(FrameIdentity.actualResolutionFrom(packet, {
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

  async function fetchRequest(request, { lane, signal, scopeId, consumerId } = {}) {
    const intentKey = FrameIdentity.intentKey(request);
    return LayerQueryCoordinator.schedule({
      key: `sampled-grid:${intentKey}`,
      lane,
      signal,
      scopeId,
      consumerId,
      metadata: eventDetail(request, { resource: "sampled-grid", scope_id: scopeId }),
      execute: async (taskSignal) => {
        const startedAt = clock.now();
        LifecycleEventLog?.record?.("HTTP_STARTED", eventDetail(request, { lane, scope_id: scopeId }));
        try {
          const sourcePacket = await fetchJsonFn(urlFor(request), { signal: taskSignal });
          const packet = canonicalPacket(request, sourcePacket);
          const elapsedMs = clock.now() - startedAt;
          LifecycleEventLog?.record?.("HTTP_FINISHED", eventDetail(request, {
            lane,
            scope_id: scopeId,
            duration_ms: elapsedMs,
            row_count: Number(packet?.row_count || packet?.rows?.length || 0),
          }));
          if (typeof SampledGridContract !== "undefined") {
            SampledGridContract.recordResolvedResolution?.(request.datasetId, packet?.grid || null);
          }
          return DataFrameStore.put(request, packet, { lane, scopeId });
        } catch (error) {
          const cancelled = error?.name === "AbortError" || taskSignal?.aborted;
          LifecycleEventLog?.record?.(cancelled ? "HTTP_CANCELLED" : "HTTP_FAILED", eventDetail(request, {
            lane,
            scope_id: scopeId,
            error: error?.message || String(error),
            reason: cancelled ? "query_cancelled" : "request_failed",
          }));
          if (!cancelled) DataFrameStore.markFailed(request, error);
          throw error;
        }
      },
    });
  }

  async function demand(rawRequest, {
    lane = "background",
    signal = null,
    scopeId = "",
    consumerId = "",
    allowPartial = false,
  } = {}) {
    const request = FrameIdentity.normalizeRequest(rawRequest);
    if (signal?.aborted) throw abortError();
    if (!request.datasetId || !request.date || !request.bbox) {
      const error = new Error("Frame demand requires datasetId, date and canonical bbox");
      error.name = "FrameDemandError";
      throw error;
    }
    const existing = DataFrameStore.inspect(request);
    if (existing.status === "ready") {
      LifecycleEventLog?.record?.("CACHE_HIT", eventDetail(request, { frame_key: existing.frameKey, lane }));
      return existing;
    }
    LifecycleEventLog?.record?.("CACHE_MISS", eventDetail(request, { lane }));
    DataFrameStore.clearFailure(request);

    const covering = [...inflight.values()].find((entry) => (
      DataFrameStore.canSatisfy?.(entry.request, request)
    ));
    if (covering) {
      if (FrameIdentity.intentKey(covering.request) === FrameIdentity.intentKey(request)) {
        return fetchRequest(request, { lane, signal, scopeId, consumerId });
      }
      LifecycleEventLog?.record?.("CACHE_WAIT", eventDetail(request, {
        lane,
        covering_intent_key: FrameIdentity.intentKey(covering.request),
      }));
      try {
        await waitWithSignal(covering.promise, signal);
        if (signal?.aborted) throw abortError();
        const reused = DataFrameStore.inspect(request);
        if (reused.status === "ready") {
          LifecycleEventLog?.record?.("CACHE_HIT", eventDetail(request, {
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
      const missing = DataFrameStore.missingRegions(request);
      if (missing.length > 0 && missing.length <= 8 && missing.some((bbox) => bbox !== request.bbox)) {
        await Promise.all(missing.map((bbox, index) => demand(
          { ...request, bbox },
          { lane, signal, scopeId, consumerId: `${consumerId || "partial"}-${index}`, allowPartial: false },
        )));
        const materialized = DataFrameStore.materialize(request);
        if (materialized) return materialized;
      }
    }
    const intentKey = FrameIdentity.intentKey(request);
    const promise = fetchRequest(request, { lane, signal, scopeId, consumerId });
    inflight.set(intentKey, { request, promise });
    try {
      return await promise;
    } finally {
      if (inflight.get(intentKey)?.promise === promise) inflight.delete(intentKey);
    }
  }

  async function demandMany(requests, {
    lane = "background",
    signal = null,
    scopeId = "",
    onProgress = null,
  } = {}) {
    const unique = new Map();
    for (const request of requests || []) {
      const normalized = FrameIdentity.normalizeRequest(request);
      unique.set(FrameIdentity.intentKey(normalized), normalized);
    }
    const progress = { total: unique.size, completed: 0, cacheHits: 0, fetched: 0, failed: 0 };
    await Promise.all([...unique.values()].map(async (request, index) => {
      try {
        const result = await demand(request, {
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

  function requestsForDates({ dates = [], ...context } = {}) {
    return [...new Set(dates.filter(Boolean))].map((date) => ({ ...context, date }));
  }

  function demandRange(context, options = {}) {
    return demandMany(requestsForDates(context), options);
  }

  return Object.freeze({
    cancelScope: (...args) => LayerQueryCoordinator.cancelScope(...args),
    demand,
    demandMany,
    demandRange,
    inspect: (request) => DataFrameStore.inspect(FrameIdentity.normalizeRequest(request)),
    requestsForDates,
    urlFor,
  });
}

if (typeof globalThis !== "undefined") globalThis.createFrameDemandService = createFrameDemandService;
