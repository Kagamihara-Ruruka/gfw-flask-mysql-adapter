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
  function urlFor(request) {
    const params = new URLSearchParams();
    params.set("date", request.date);
    params.set("limit", request.limit == null ? "max" : String(request.limit));
    params.set("bbox", request.bbox);
    if (request.columns) params.set("columns", request.columns);
    if (request.resolution != null) params.set("resolution", String(request.resolution));
    if (request.zoom != null) params.set("zoom", String(request.zoom));
    if (request.latitude != null) params.set("latitude", String(request.latitude));
    return `/api/datasets/${request.datasetId}/records?${params}`;
  }

  function eventDetail(request, extra = {}) {
    return {
      intent_key: FrameIdentity.intentKey(request),
      dataset: request.datasetId,
      layer_id: request.layerId || "",
      date: request.date,
      requested_resolution_km: request.resolution,
      ...extra,
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
      metadata: eventDetail(request, { resource: "sampled-grid" }),
      execute: async (taskSignal) => {
        const startedAt = clock.now();
        LifecycleEventLog?.record?.("HTTP_STARTED", eventDetail(request, { lane }));
        try {
          const packet = await fetchJsonFn(urlFor(request), { signal: taskSignal });
          const elapsedMs = clock.now() - startedAt;
          LifecycleEventLog?.record?.("HTTP_FINISHED", eventDetail(request, {
            lane,
            duration_ms: elapsedMs,
            row_count: Number(packet?.row_count || packet?.rows?.length || 0),
          }));
          if (typeof SampledGridContract !== "undefined") {
            SampledGridContract.recordResolvedResolution?.(request.datasetId, packet?.grid || null);
          }
          return DataFrameStore.put(request, packet);
        } catch (error) {
          LifecycleEventLog?.record?.("HTTP_FAILED", eventDetail(request, {
            lane,
            error: error?.message || String(error),
          }));
          if (error?.name !== "AbortError") DataFrameStore.markFailed(request, error);
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
    return fetchRequest(request, { lane, signal, scopeId, consumerId });
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
