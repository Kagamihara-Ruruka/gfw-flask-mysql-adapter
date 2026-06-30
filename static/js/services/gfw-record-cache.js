const GfwRecordCache = (() => {
  const cache = new Map();
  const inflight = new Map();
  let prewarmGeneration = 0;
  let prewarmTimer = null;

  function options() {
    const rawConcurrency = state.gfwRecordCache?.prewarmConcurrency ?? "all";
    return {
      maxEntries: Math.max(12, Number(state.gfwRecordCache?.maxEntries || 72)),
      prewarmMaxZoom: Math.max(1, Number(state.gfwRecordCache?.prewarmMaxZoom || 12)),
      prewarmConcurrency: rawConcurrency === "all" ? "all" : Math.max(1, Number(rawConcurrency || 1)),
      prewarmIdleDelayMs: Math.max(0, Number(state.gfwRecordCache?.prewarmIdleDelayMs || 120)),
    };
  }

  function updateStats(patch) {
    if (!state.gfwRecordCache) return;
    state.gfwRecordCache.stats = {
      ...(state.gfwRecordCache.stats || {}),
      ...patch,
    };
  }

  function incrementStat(name, amount = 1) {
    const stats = state.gfwRecordCache?.stats || {};
    updateStats({ [name]: Number(stats[name] || 0) + amount });
  }

  function requestKey({ datasetId, date, bbox, limit }) {
    return [datasetId, date, bbox, limit].join("|");
  }

  function remember(key, packet) {
    cache.delete(key);
    cache.set(key, packet);
    const { maxEntries } = options();
    while (cache.size > maxEntries) {
      cache.delete(cache.keys().next().value);
    }
  }

  function urlFor({ datasetId, date, bbox, limit }) {
    const params = new URLSearchParams();
    params.set("date", date);
    params.set("limit", String(limit));
    params.set("bbox", bbox);
    return `/api/datasets/${datasetId}/records?${params}`;
  }

  async function fetchPacket(request) {
    const key = requestKey(request);
    if (cache.has(key)) {
      incrementStat("hits");
      return { packet: cache.get(key), cacheHit: true, key };
    }
    incrementStat("misses");
    if (inflight.has(key)) {
      return { packet: await inflight.get(key), cacheHit: false, key };
    }
    const promise = fetchJson(urlFor(request))
      .then((packet) => {
        remember(key, packet);
        return packet;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return { packet: await promise, cacheHit: false, key };
  }

  function allWarmableZoomsByDistance(currentZoom) {
    const current = Math.round(currentZoom);
    const minZoom = Math.max(1, Math.floor(map.getMinZoom?.() ?? 1));
    const configuredMax = map.getMaxZoom?.();
    const { prewarmMaxZoom } = options();
    const maxZoom = Math.min(prewarmMaxZoom, Number.isFinite(configuredMax) ? Math.floor(configuredMax) : prewarmMaxZoom);
    const values = [];
    for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
      if (zoom !== current) values.push(zoom);
    }
    return values.sort((left, right) => {
      const leftDistance = Math.abs(left - current);
      const rightDistance = Math.abs(right - current);
      return leftDistance - rightDistance || left - right;
    });
  }

  function idleDelay() {
    return new Promise((resolve) => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(resolve, { timeout: 1600 });
        return;
      }
      window.setTimeout(resolve, options().prewarmIdleDelayMs);
    });
  }

  function prewarmRequests(context) {
    return allWarmableZoomsByDistance(context.zoom).map((zoom) => ({
      datasetId: context.datasetId,
      date: context.date,
      limit: context.limit,
      bbox: bboxForCenterZoom(context.center, zoom),
    }));
  }

  async function prewarmWorker(queue, generation) {
    while (queue.length > 0) {
      if (generation !== prewarmGeneration || state.dataLayer !== "gfw") return;
      const request = queue.shift();
      const key = requestKey(request);
      if (!cache.has(key) && !inflight.has(key)) {
        await fetchPacket(request).catch((err) => console.warn("GFW prewarm failed", err));
        if (generation === prewarmGeneration && state.dataLayer === "gfw") {
          incrementStat("prewarmCompleted");
        }
      }
      await idleDelay();
    }
  }

  async function prewarmQueue(context, generation) {
    const queue = prewarmRequests(context).filter((request) => {
      const key = requestKey(request);
      return !cache.has(key) && !inflight.has(key);
    });
    updateStats({ prewarmQueued: queue.length, prewarmCompleted: 0 });
    const concurrency = options().prewarmConcurrency === "all"
      ? queue.length
      : Math.min(options().prewarmConcurrency, queue.length);
    const workers = Array.from(
      { length: concurrency },
      () => prewarmWorker(queue, generation)
    );
    await Promise.all(workers);
  }

  function schedulePrewarm(context) {
    prewarmGeneration += 1;
    const generation = prewarmGeneration;
    clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null;
      prewarmQueue(context, generation).catch((err) => console.warn("GFW prewarm queue failed", err));
    }, 700);
  }

  function cancelPrewarm() {
    prewarmGeneration += 1;
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
  }

  return {
    fetchPacket,
    schedulePrewarm,
    cancelPrewarm,
  };
})();
