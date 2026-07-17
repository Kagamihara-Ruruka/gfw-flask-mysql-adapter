function decorateFrameDemandService(service, { eventLog, clock } = {}) {
  if (!service || typeof service.demand !== "function") {
    throw new TypeError("Frame demand telemetry decorator requires a demand service");
  }
  if (!eventLog || typeof eventLog.record !== "function") {
    throw new TypeError("Frame demand telemetry decorator requires an event log");
  }
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("Frame demand telemetry decorator requires a monotonic clock");
  }

  function detailFor(operation, request = {}, options = {}, extra = {}) {
    return {
      operation,
      dataset: String(request?.datasetId || ""),
      layer_id: String(request?.layerId || ""),
      date: String(request?.date || ""),
      lane: String(options?.lane || "background"),
      scope_id: String(options?.scopeId || ""),
      ...extra,
    };
  }

  function trace(detail, invoke) {
    const startedAt = clock.now();
    eventLog.record("FRAME_DEMAND_STARTED", detail);
    let result;
    try {
      result = invoke();
    } catch (error) {
      eventLog.record("FRAME_DEMAND_FAILED", {
        ...detail,
        duration_ms: Math.max(0, clock.now() - startedAt),
        error: error?.message || String(error),
      });
      throw error;
    }
    return Promise.resolve(result).then(
      (value) => {
        eventLog.record("FRAME_DEMAND_FINISHED", {
          ...detail,
          duration_ms: Math.max(0, clock.now() - startedAt),
        });
        return value;
      },
      (error) => {
        eventLog.record(error?.name === "AbortError" ? "FRAME_DEMAND_CANCELLED" : "FRAME_DEMAND_FAILED", {
          ...detail,
          duration_ms: Math.max(0, clock.now() - startedAt),
          error: error?.message || String(error),
        });
        throw error;
      },
    );
  }

  return Object.freeze({
    demand(request, options = {}) {
      return trace(detailFor("single", request, options), () => service.demand(request, options));
    },
    demandMany(requests, options = {}) {
      const items = Array.isArray(requests) ? requests : [];
      return trace(
        detailFor("many", items[0], options, { request_count: items.length }),
        () => service.demandMany(items, options),
      );
    },
    demandRange(context = {}, options = {}) {
      const dates = Array.isArray(context?.dates) ? context.dates : [];
      return trace(
        detailFor("range", { ...context, date: dates[0] || "" }, options, { request_count: dates.length }),
        () => service.demandRange(context, options),
      );
    },
    requestsForDates(context) {
      return service.requestsForDates(context);
    },
    cancelScope(scopeId, options) {
      return service.cancelScope(scopeId, options);
    },
    inspect(request) {
      return service.inspect(request);
    },
    dispose() {
      service.dispose?.();
    },
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.decorateFrameDemandService = decorateFrameDemandService;
}
