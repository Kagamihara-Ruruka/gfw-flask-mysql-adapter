const GfwRecordCache = (() => {
  const cache = new Map();
  const metadata = new Map();
  const packetSizes = new Map();
  const inflight = new Map();
  let prewarmGeneration = 0;
  let prewarmTimer = null;
  let cacheBytes = 0;

  const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

  function options() {
    const rawConcurrency = state.gfwRecordCache?.prewarmConcurrency ?? "all";
    const rawMaxEntries = Number(state.gfwRecordCache?.maxEntries ?? 0);
    const rawMaxBytes = Number(state.gfwRecordCache?.maxBytes ?? DEFAULT_MAX_BYTES);
    return {
      maxEntries: rawMaxEntries <= 0 ? 0 : Math.max(12, rawMaxEntries),
      maxBytes: rawMaxBytes <= 0 ? 0 : Math.max(64 * 1024 * 1024, rawMaxBytes),
      prewarmMaxZoom: Math.max(1, Number(state.gfwRecordCache?.prewarmMaxZoom || 12)),
      prewarmConcurrency: rawConcurrency === "all" ? "all" : Math.max(1, Number(rawConcurrency || 1)),
      prewarmIdleDelayMs: Math.max(0, Number(state.gfwRecordCache?.prewarmIdleDelayMs || 120)),
      prewarmDateAhead: Math.max(0, Number(state.gfwRecordCache?.prewarmDateAhead || 0)),
      prewarmDateBehind: Math.max(0, Number(state.gfwRecordCache?.prewarmDateBehind || 0)),
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

  function estimateValueBytes(value) {
    if (value == null) return 4;
    if (typeof value === "number" || typeof value === "boolean") return 8;
    if (typeof value === "string") return 24 + value.length * 2;
    if (Array.isArray(value)) {
      return 32 + value.reduce((total, item) => total + estimateValueBytes(item), 0);
    }
    if (typeof value === "object") {
      return 48 + Object.entries(value).reduce((total, [key, nested]) => (
        total + key.length * 2 + estimateValueBytes(nested)
      ), 0);
    }
    return 16;
  }

  function estimateRowBytes(row) {
    if (!row || typeof row !== "object") return 16;
    return 48 + Object.entries(row).reduce((total, [key, value]) => (
      total + key.length * 2 + estimateValueBytes(value)
    ), 0);
  }

  function estimatePacketBytes(packet) {
    const rows = Array.isArray(packet?.rows) ? packet.rows : [];
    let bytes = 512;
    bytes += estimateValueBytes(packet?.bounds);
    bytes += estimateValueBytes(packet?.timing);
    bytes += estimateValueBytes(packet?.columns);
    for (const row of rows) {
      bytes += estimateRowBytes(row);
    }
    return Math.max(512, Math.ceil(bytes));
  }

  function removePacket(key) {
    if (!cache.has(key)) return;
    cache.delete(key);
    metadata.delete(key);
    cacheBytes -= Number(packetSizes.get(key) || 0);
    packetSizes.delete(key);
    if (cacheBytes < 0) cacheBytes = 0;
  }

  function syncCacheStats(extra = {}) {
    const { maxBytes } = options();
    updateStats({
      cacheEntries: cache.size,
      cacheBytes,
      cacheLimitBytes: maxBytes,
      ...extra,
    });
  }

  function enforceBudget() {
    const { maxEntries, maxBytes } = options();
    while ((maxEntries > 0 && cache.size > maxEntries) || (maxBytes > 0 && cacheBytes > maxBytes)) {
      const staleKey = cache.keys().next().value;
      if (!staleKey) break;
      removePacket(staleKey);
    }
    syncCacheStats();
  }

  function requestKey({ datasetId, date, bbox, limit }) {
    return [datasetId, date, bbox, limit].join("|");
  }

  function parseBbox(bbox) {
    const parts = String(bbox || "").split(",").map(Number);
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
    const [west, south, east, north] = parts;
    if (west > east || south > north) return null;
    return { west, south, east, north };
  }

  function bboxArea(box) {
    return Math.max(0, box.east - box.west) * Math.max(0, box.north - box.south);
  }

  function bboxToString(box) {
    return [box.west, box.south, box.east, box.north].map((value) => value.toFixed(6)).join(",");
  }

  function containsBbox(outer, inner) {
    return outer.west <= inner.west
      && outer.east >= inner.east
      && outer.south <= inner.south
      && outer.north >= inner.north;
  }

  function intersectBbox(left, right) {
    const west = Math.max(left.west, right.west);
    const south = Math.max(left.south, right.south);
    const east = Math.min(left.east, right.east);
    const north = Math.min(left.north, right.north);
    if (west >= east || south >= north) return null;
    return { west, south, east, north };
  }

  function subtractBbox(source, cut) {
    const overlap = intersectBbox(source, cut);
    if (!overlap) return [source];
    const pieces = [];
    if (source.west < overlap.west) {
      pieces.push({ west: source.west, south: source.south, east: overlap.west, north: source.north });
    }
    if (overlap.east < source.east) {
      pieces.push({ west: overlap.east, south: source.south, east: source.east, north: source.north });
    }
    if (source.south < overlap.south) {
      pieces.push({ west: overlap.west, south: source.south, east: overlap.east, north: overlap.south });
    }
    if (overlap.north < source.north) {
      pieces.push({ west: overlap.west, south: overlap.north, east: overlap.east, north: source.north });
    }
    return pieces.filter((piece) => bboxArea(piece) > 0);
  }

  function rowInBbox(row, box) {
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    return Number.isFinite(lat)
      && Number.isFinite(lon)
      && lon >= box.west
      && lon <= box.east
      && lat >= box.south
      && lat <= box.north;
  }

  function compatibleMeta(meta, request) {
    return meta
      && meta.datasetId === request.datasetId
      && meta.date === request.date
      && String(meta.limit) === String(request.limit)
      && meta.box;
  }

  function compatibleCachedEntries(request) {
    return [...cache.entries()]
      .map(([key, packet]) => ({ key, packet, meta: metadata.get(key) }))
      .filter((entry) => compatibleMeta(entry.meta, request))
      .sort((left, right) => bboxArea(left.meta.box) - bboxArea(right.meta.box));
  }

  function clonePacketForRows(sourcePacket, request, rows, timingPatch = {}) {
    const box = parseBbox(request.bbox);
    return {
      ...sourcePacket,
      rows,
      row_count: rows.length,
      bounds: box ? {
        min_lon: box.west,
        min_lat: box.south,
        max_lon: box.east,
        max_lat: box.north,
      } : sourcePacket?.bounds,
      timing: {
        ...(sourcePacket?.timing || {}),
        cache_hit: true,
        ...timingPatch,
      },
    };
  }

  function completeReusablePacket(request) {
    const requestBox = parseBbox(request.bbox);
    if (!requestBox) return null;
    let best = null;
    for (const entry of compatibleCachedEntries(request)) {
      if (!containsBbox(entry.meta.box, requestBox)) continue;
      if (!best || bboxArea(entry.meta.box) < bboxArea(best.meta.box)) {
        best = entry;
      }
    }
    if (!best) return null;
    const rows = (best.packet.rows || []).filter((row) => rowInBbox(row, requestBox));
    return {
      key: best.key,
      packet: clonePacketForRows(best.packet, request, rows, {
        browser_cache_reuse: "covered_bbox",
        browser_cache_source: best.key,
      }),
    };
  }

  function rowsKey(row) {
    return [
      row?.lat ?? "",
      row?.lon ?? "",
      row?.cell_lat ?? "",
      row?.cell_lon ?? "",
      row?.date ?? "",
    ].join("|");
  }

  function mergeRows(packets, requestBox) {
    const seen = new Set();
    const rows = [];
    for (const packet of packets) {
      for (const row of packet.rows || []) {
        if (!rowInBbox(row, requestBox)) continue;
        const key = rowsKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    }
    return rows;
  }

  function partialReusablePlan(request) {
    const requestBox = parseBbox(request.bbox);
    if (!requestBox) return null;
    const cached = [];
    let missing = [requestBox];
    for (const entry of compatibleCachedEntries(request)) {
      if (!intersectBbox(entry.meta.box, requestBox)) continue;
      cached.push(entry);
      missing = missing.flatMap((piece) => subtractBbox(piece, entry.meta.box));
      if (!missing.length) break;
    }
    if (!cached.length || missing.length > 8) return null;
    return { requestBox, cached, missing };
  }

  function hasPacket(request) {
    return cache.has(requestKey(request)) || Boolean(completeReusablePacket(request));
  }

  function remember(key, packet, request) {
    const size = estimatePacketBytes(packet);
    const { maxEntries, maxBytes } = options();
    if (maxBytes > 0 && size > maxBytes) {
      removePacket(key);
      syncCacheStats({ skippedOversizeBytes: size });
      incrementStat("skippedOversize");
      return false;
    }
    removePacket(key);
    cache.set(key, packet);
    packetSizes.set(key, size);
    cacheBytes += size;
    if (request) {
      metadata.delete(key);
      metadata.set(key, { ...request, box: parseBbox(request.bbox) });
    }
    enforceBudget();
    return true;
  }

  function urlFor({ datasetId, date, bbox, limit }) {
    const params = new URLSearchParams();
    params.set("date", date);
    params.set("limit", String(limit));
    params.set("bbox", bbox);
    return `/api/datasets/${datasetId}/records?${params}`;
  }

  async function fetchAndRemember(request) {
    const key = requestKey(request);
    if (cache.has(key)) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const promise = fetchJson(urlFor(request))
      .then((packet) => {
        remember(key, packet, request);
        return packet;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  async function fetchPartialPacket(request, key) {
    const plan = partialReusablePlan(request);
    if (!plan || !plan.missing.length) return null;
    incrementStat("partialReuses");
    const cachedPackets = plan.cached.map((entry) => entry.packet);
    const missingRequests = plan.missing.map((box) => ({
      ...request,
      bbox: bboxToString(box),
    }));
    const fetchedPackets = [];
    for (const missingRequest of missingRequests) {
      fetchedPackets.push(await fetchAndRemember(missingRequest));
    }
    const rows = mergeRows([...cachedPackets, ...fetchedPackets], plan.requestBox);
    const sourcePacket = fetchedPackets[0] || cachedPackets[0] || {};
    const packet = clonePacketForRows(sourcePacket, request, rows, {
      browser_cache_reuse: "partial_bbox",
      browser_cache_sources: plan.cached.length,
      browser_cache_missing_fetches: missingRequests.length,
    });
    remember(key, packet, request);
    return packet;
  }

  async function fetchPacket(request) {
    const key = requestKey(request);
    if (cache.has(key)) {
      incrementStat("hits");
      return { packet: cache.get(key), cacheHit: true, key };
    }
    const reusable = completeReusablePacket(request);
    if (reusable) {
      incrementStat("hits");
      incrementStat("coveredReuses");
      remember(key, reusable.packet, request);
      return { packet: reusable.packet, cacheHit: true, key, reusedFrom: reusable.key };
    }
    const partial = await fetchPartialPacket(request, key);
    if (partial) {
      incrementStat("hits");
      return { packet: partial, cacheHit: true, key, partial: true };
    }
    incrementStat("misses");
    if (inflight.has(key)) {
      return { packet: await inflight.get(key), cacheHit: false, key };
    }
    return { packet: await fetchAndRemember(request), cacheHit: false, key };
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
    const requests = [];
    const dateIndex = state.availableDates.indexOf(context.date);
    if (dateIndex >= 0) {
      const { prewarmDateAhead, prewarmDateBehind } = options();
      for (let offset = 1; offset <= prewarmDateAhead; offset += 1) {
        const date = state.availableDates[dateIndex + offset];
        if (date) {
          requests.push({
            datasetId: context.datasetId,
            date,
            limit: context.limit,
            bbox: context.bbox,
          });
        }
      }
      for (let offset = 1; offset <= prewarmDateBehind; offset += 1) {
        const date = state.availableDates[dateIndex - offset];
        if (date) {
          requests.push({
            datasetId: context.datasetId,
            date,
            limit: context.limit,
            bbox: context.bbox,
          });
        }
      }
    }
    requests.push(...allWarmableZoomsByDistance(context.zoom).map((zoom) => ({
      datasetId: context.datasetId,
      date: context.date,
      limit: context.limit,
      bbox: bboxForCenterZoom(context.center, zoom),
    })));
    return requests;
  }

  async function prewarmWorker(queue, generation) {
    while (queue.length > 0) {
      if (generation !== prewarmGeneration || state.dataLayer !== "gfw") return;
      const request = queue.shift();
      const key = requestKey(request);
      if (!hasPacket(request) && !inflight.has(key)) {
        await fetchPacket(request).catch((err) => console.warn("GFW prewarm failed", err));
        if (generation === prewarmGeneration && state.dataLayer === "gfw") {
          incrementStat("prewarmCompleted");
        }
      }
      await idleDelay();
    }
  }

  async function prefetchWorker(queue, generation, onProgress) {
    while (queue.length > 0) {
      if (generation !== prewarmGeneration || state.dataLayer !== "gfw") return;
      const request = queue.shift();
      const key = requestKey(request);
      const wasCached = hasPacket(request);
      try {
        const result = await fetchPacket(request);
        onProgress?.({
          request,
          cacheHit: wasCached || result.cacheHit,
          ok: true,
        });
      } catch (err) {
        console.warn("GFW playback prefetch failed", err);
        onProgress?.({
          request,
          cacheHit: false,
          ok: false,
          error: err,
        });
      }
      await Promise.resolve();
    }
  }

  function uniqueRequests(requests) {
    const byKey = new Map();
    for (const request of requests) {
      byKey.set(requestKey(request), request);
    }
    return [...byKey.values()];
  }

  async function prefetchRequests(requests, { concurrency = 2, onProgress } = {}) {
    prewarmGeneration += 1;
    const generation = prewarmGeneration;
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
    const unique = uniqueRequests(requests);
    const queue = unique.filter((request) => {
      const key = requestKey(request);
      return !hasPacket(request) || inflight.has(key);
    });
    const immediateHits = unique.length - queue.length;
    for (let index = 0; index < immediateHits; index += 1) {
      onProgress?.({ cacheHit: true, ok: true, immediate: true });
    }
    const workerCount = Math.min(Math.max(1, Number(concurrency || 1)), Math.max(1, queue.length));
    if (!queue.length) {
      return { total: unique.length, fetched: 0, cacheHits: immediateHits, failed: 0 };
    }
    const progress = { fetched: 0, cacheHits: immediateHits, failed: 0 };
    const workers = Array.from({ length: workerCount }, () => prefetchWorker(queue, generation, (event) => {
      if (event.ok && event.cacheHit) progress.cacheHits += 1;
      if (event.ok && !event.cacheHit) progress.fetched += 1;
      if (!event.ok) progress.failed += 1;
      onProgress?.(event);
    }));
    await Promise.all(workers);
    return { total: unique.length, ...progress };
  }

  async function prewarmQueue(context, generation) {
    const queue = prewarmRequests(context).filter((request) => {
      const key = requestKey(request);
      return !hasPacket(request) && !inflight.has(key);
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

  function clear() {
    prewarmGeneration += 1;
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
    cache.clear();
    metadata.clear();
    packetSizes.clear();
    inflight.clear();
    cacheBytes = 0;
    syncCacheStats({
      prewarmQueued: 0,
      prewarmCompleted: 0,
      skippedOversizeBytes: 0,
    });
  }

  return {
    clear,
    fetchPacket,
    hasPacket,
    prefetchRequests,
    enforceBudget,
    schedulePrewarm,
    cancelPrewarm,
  };
})();
