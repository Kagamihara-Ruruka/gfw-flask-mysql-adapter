class DataFrameStoreCore {
  constructor({
    frameIdentity,
    eventLog = null,
    optionsProvider = null,
    statsTargetProvider = null,
    retentionPartitionProvider = null,
    heapLimitProvider = null,
    heapBudgetFraction = 0.35,
    eventTarget = null,
    clock,
  } = {}) {
  if (!frameIdentity) throw new TypeError("DataFrameStore requires FrameIdentity");
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("DataFrameStore requires a monotonic clock");
  }
  const FrameIdentity = frameIdentity;
  const LifecycleEventLog = eventLog;
  const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
  const BBOX_EPSILON = 1e-6;
  const cache = new Map();
  const metadata = new Map();
  const aliases = new Map();
  const packetSizes = new Map();
  const pins = new Map();
  const failures = new Map();
  const listeners = new Set();
  const configuredHeapBudgetFraction = Number(heapBudgetFraction);
  const safeHeapBudgetFraction = Number.isFinite(configuredHeapBudgetFraction)
    ? Math.min(0.8, Math.max(0.1, configuredHeapBudgetFraction))
    : 0.35;
  let cacheBytes = 0;

  function observedHeapLimitBytes() {
    try {
      const value = Number(heapLimitProvider?.() || 0);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch (_error) {
      return 0;
    }
  }

  function options() {
    const configured = optionsProvider?.() || {};
    const rawMaxEntries = Number(configured.maxEntries ?? 0);
    const rawMaxBytes = Number(configured.maxBytes ?? DEFAULT_MAX_BYTES);
    const configuredMaxBytes = rawMaxBytes <= 0
      ? 0
      : Math.max(64 * 1024 * 1024, rawMaxBytes);
    const heapLimitBytes = observedHeapLimitBytes();
    const heapSafeMaxBytes = heapLimitBytes > 0
      ? Math.max(64 * 1024 * 1024, Math.floor(heapLimitBytes * safeHeapBudgetFraction))
      : 0;
    const maxBytes = heapSafeMaxBytes > 0
      ? (configuredMaxBytes > 0 ? Math.min(configuredMaxBytes, heapSafeMaxBytes) : heapSafeMaxBytes)
      : configuredMaxBytes;
    return {
      maxEntries: rawMaxEntries <= 0 ? 0 : Math.max(12, rawMaxEntries),
      maxBytes,
      configuredMaxBytes,
      heapLimitBytes,
      heapSafeMaxBytes,
      heapBudgetFraction: safeHeapBudgetFraction,
      heapSafetyApplied: heapSafeMaxBytes > 0
        && (configuredMaxBytes <= 0 || maxBytes < configuredMaxBytes),
    };
  }

  function statsTarget() {
    return statsTargetProvider?.() || null;
  }

  function syncStats(extra = {}) {
    const target = statsTarget();
    const {
      maxBytes,
      configuredMaxBytes,
      heapLimitBytes,
      heapSafeMaxBytes,
      heapBudgetFraction,
      heapSafetyApplied,
    } = options();
    const patch = {
      cacheEntries: cache.size,
      cacheBytes,
      cacheLimitBytes: maxBytes,
      configuredCacheLimitBytes: configuredMaxBytes,
      browserHeapLimitBytes: heapLimitBytes,
      browserHeapSafeCacheBytes: heapSafeMaxBytes,
      browserHeapBudgetFraction: heapBudgetFraction,
      browserHeapSafetyApplied: heapSafetyApplied,
      pinnedEntries: [...pins.values()].filter((owners) => owners.size > 0).length,
      aliasEntries: aliases.size,
      ...extra,
    };
    if (target) Object.assign(target, patch);
  }

  function incrementStat(name, amount = 1) {
    const target = statsTarget();
    if (target) target[name] = Number(target[name] || 0) + amount;
  }

  function estimateValueBytes(value) {
    if (value == null) return 4;
    if (typeof value === "number" || typeof value === "boolean") return 8;
    if (typeof value === "string") return 24 + value.length * 2;
    if (Array.isArray(value)) return 32 + value.reduce((total, item) => total + estimateValueBytes(item), 0);
    if (typeof value === "object") {
      return 48 + Object.entries(value).reduce((total, [key, nested]) => (
        total + key.length * 2 + estimateValueBytes(nested)
      ), 0);
    }
    return 16;
  }

  function estimatePacketBytes(packet) {
    const frameBytes = CanonicalGridFrame.isFrame(packet?.frame) ? packet.frame.estimatedBytes : 0;
    return Math.max(512, Math.ceil(
      512
      + estimateValueBytes(packet?.bounds)
      + estimateValueBytes(packet?.timing)
      + estimateValueBytes(packet?.columns)
      + frameBytes
    ));
  }

  function frameSizeStats(filter = {}) {
    const requestedScopeKey = String(filter.scopeKey || "");
    const requestedDatasetId = String(filter.datasetId || "");
    const requestedCacheNamespace = String(filter.cacheNamespace || "");
    const sizes = [...packetSizes.entries()]
      .filter(([frameKey]) => {
        const meta = metadata.get(frameKey) || {};
        if (requestedDatasetId && meta.datasetId !== requestedDatasetId) return false;
        if (requestedCacheNamespace && meta.cacheNamespace !== requestedCacheNamespace) return false;
        if (requestedScopeKey && FrameIdentity.scopeKey(meta) !== requestedScopeKey) return false;
        return true;
      })
      .map(([, value]) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    if (!sizes.length) {
      return {
        frameSizeSamples: 0,
        averageFrameBytes: 0,
        estimatedFrameBytes: 0,
        largestFrameBytes: 0,
      };
    }
    const p95Index = Math.min(sizes.length - 1, Math.max(0, Math.ceil(sizes.length * 0.95) - 1));
    return {
      frameSizeSamples: sizes.length,
      averageFrameBytes: sizes.reduce((total, value) => total + value, 0) / sizes.length,
      estimatedFrameBytes: sizes[p95Index],
      largestFrameBytes: sizes[sizes.length - 1],
    };
  }

  function notify(change) {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn("DataFrameStore subscriber failed", error);
      }
    }
    if (eventTarget?.dispatchEvent && typeof CustomEvent === "function") {
      eventTarget.dispatchEvent(new CustomEvent("rrkal:data-frame-store-changed", { detail: change }));
    }
  }

  function subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    if (emitCurrent) listener({ type: "snapshot", snapshot: snapshot() });
    return () => listeners.delete(listener);
  }

  function removeAliasesForFrame(frameKey) {
    for (const [intentKey, aliasedFrameKey] of aliases.entries()) {
      if (aliasedFrameKey === frameKey) aliases.delete(intentKey);
    }
  }

  function removeFrame(frameKey, { force = false, reason = "evicted" } = {}) {
    if (!cache.has(frameKey)) return false;
    if (!force && (pins.get(frameKey)?.size || 0) > 0) return false;
    const meta = metadata.get(frameKey) || {};
    cache.delete(frameKey);
    metadata.delete(frameKey);
    removeAliasesForFrame(frameKey);
    cacheBytes -= Number(packetSizes.get(frameKey) || 0);
    packetSizes.delete(frameKey);
    pins.delete(frameKey);
    if (cacheBytes < 0) cacheBytes = 0;
    LifecycleEventLog?.record?.("CACHE_EVICTED", {
      frame_key: frameKey,
      dataset: meta.datasetId || "",
      cache_namespace: meta.cacheNamespace || "",
      reason,
    });
    notify({
      type: "evicted",
      frameKey,
      datasetId: meta.datasetId || "",
      cacheNamespace: meta.cacheNamespace || "",
      date: meta.date || "",
      reason,
    });
    return true;
  }

  function touch(frameKey) {
    if (!cache.has(frameKey)) return null;
    const packet = cache.get(frameKey);
    const meta = metadata.get(frameKey);
    cache.delete(frameKey);
    cache.set(frameKey, packet);
    if (meta) {
      metadata.delete(frameKey);
      metadata.set(frameKey, meta);
    }
    return packet;
  }

  function evictionQueues() {
    const retention = retentionPartitionProvider?.() || {};
    const retainedNamespace = String(retention.cacheNamespace || "");
    const retainedDatasetId = String(retention.datasetId || "");
    const hot = [];
    const cold = [];
    for (const key of cache.keys()) {
      if ((pins.get(key)?.size || 0) > 0) continue;
      const meta = metadata.get(key) || {};
      const retained = retainedNamespace
        ? meta.cacheNamespace === retainedNamespace
        : retainedDatasetId
          ? meta.datasetId === retainedDatasetId
          : false;
      (retained ? hot : cold).push(key);
    }
    return { hot, cold };
  }

  function enforceBudget() {
    const { maxEntries, maxBytes } = options();
    let skippedPinned = 0;
    while ((maxEntries > 0 && cache.size > maxEntries) || (maxBytes > 0 && cacheBytes > maxBytes)) {
      const queues = evictionQueues();
      const candidate = queues.cold[0] || queues.hot[0];
      if (!candidate) {
        skippedPinned = cache.size;
        break;
      }
      removeFrame(candidate, {
        reason: queues.cold.length ? "inactive_dataset_budget" : "lru_budget",
      });
    }
    syncStats({
      budgetBlockedByPins: skippedPinned,
    });
  }

  function boxFromRequest(request) {
    return FrameIdentity.normalizedBbox(request?.bbox);
  }

  function bboxArea(box) {
    return box ? Math.max(0, box.east - box.west) * Math.max(0, box.north - box.south) : 0;
  }

  function containsBbox(outer, inner) {
    return outer && inner
      && outer.west <= inner.west
      && outer.east >= inner.east
      && outer.south <= inner.south
      && outer.north >= inner.north;
  }

  function intersectBbox(left, right) {
    if (!left || !right) return null;
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
    if (source.west < overlap.west) pieces.push({ west: source.west, south: source.south, east: overlap.west, north: source.north });
    if (overlap.east < source.east) pieces.push({ west: overlap.east, south: source.south, east: source.east, north: source.north });
    if (source.south < overlap.south) pieces.push({ west: overlap.west, south: source.south, east: overlap.east, north: overlap.south });
    if (overlap.north < source.north) pieces.push({ west: overlap.west, south: overlap.north, east: overlap.east, north: source.north });
    return pieces.filter((piece) => bboxArea(piece) > 0);
  }

  function bboxString(box) {
    return FrameIdentity.bboxSignature(box);
  }

  function compatibleMeta(meta, request) {
    const normalized = FrameIdentity.normalizeRequest(request);
    return meta
      && meta.datasetId === normalized.datasetId
      && meta.cacheNamespace === normalized.cacheNamespace
      && meta.date === normalized.date
      && String(meta.limit) === String(normalized.limit)
      && String(meta.columns) === String(normalized.columns)
      && String(meta.requestedResolution ?? "auto") === String(normalized.resolution ?? "auto")
      && (normalized.resolution != null
        || (String(meta.zoom ?? "auto") === String(normalized.zoom ?? "auto")
          && String(meta.latitude ?? "auto") === String(normalized.latitude ?? "auto")))
      && meta.box;
  }

  function compatibleEntries(request) {
    return [...cache.entries()]
      .map(([frameKey, packet]) => ({ frameKey, packet, meta: metadata.get(frameKey) }))
      .filter((entry) => compatibleMeta(entry.meta, request))
      .sort((left, right) => bboxArea(left.meta.box) - bboxArea(right.meta.box));
  }

  function canSatisfy(sourceRequest, targetRequest) {
    const source = FrameIdentity.normalizeRequest(sourceRequest);
    const target = FrameIdentity.normalizeRequest(targetRequest);
    const sourceBox = boxFromRequest(source);
    const targetBox = boxFromRequest(target);
    if (!sourceBox || !targetBox) return false;
    return compatibleMeta({
      ...source,
      requestedResolution: source.resolution,
      box: sourceBox,
    }, target) && containsBbox(sourceBox, targetBox);
  }

  function clonePacketForFrame(sourcePacket, request, frame, timingPatch = {}) {
    const box = boxFromRequest(request);
    return Object.freeze({
      ...sourcePacket,
      frame,
      row_count: frame.rowCount,
      bounds: box ? { min_lon: box.west, min_lat: box.south, max_lon: box.east, max_lat: box.north } : sourcePacket?.bounds,
      timing: {
        ...(sourcePacket?.timing || {}),
        cache_hit: true,
        ...timingPatch,
      },
    });
  }

  function scopePacketToRequest(packet, request) {
    const requestBox = boxFromRequest(request);
    const frame = packet?.frame;
    if (!requestBox || !CanonicalGridFrame.isFrame(frame)) return packet;
    const scopedFrame = frame.filterBbox(requestBox, BBOX_EPSILON);
    if (scopedFrame.rowCount === frame.rowCount) return packet;
    return Object.freeze({
      ...packet,
      frame: scopedFrame,
      row_count: scopedFrame.rowCount,
      bounds: {
        min_lon: requestBox.west,
        min_lat: requestBox.south,
        max_lon: requestBox.east,
        max_lat: requestBox.north,
      },
      timing: {
        ...(packet.timing || {}),
        canonical_bbox_clipped: true,
        canonical_bbox_dropped_rows: frame.rowCount - scopedFrame.rowCount,
      },
    });
  }

  function exactFrameKey(request) {
    const intentKey = FrameIdentity.intentKey(request);
    return aliases.get(intentKey) || "";
  }

  function completeReusable(request) {
    const requestBox = boxFromRequest(request);
    if (!requestBox) return null;
    const best = compatibleEntries(request).find((entry) => containsBbox(entry.meta.box, requestBox));
    if (!best) return null;
    const frame = best.packet.frame.filterBbox(requestBox, BBOX_EPSILON);
    return {
      packet: clonePacketForFrame(best.packet, request, frame, {
        browser_cache_reuse: "covered_bbox",
        browser_cache_source: best.frameKey,
      }),
      sourceFrameKey: best.frameKey,
    };
  }

  function missingRegions(request) {
    const requestBox = boxFromRequest(request);
    if (!requestBox) return [];
    let missing = [requestBox];
    for (const entry of compatibleEntries(request)) {
      if (!intersectBbox(entry.meta.box, requestBox)) continue;
      missing = missing.flatMap((piece) => subtractBbox(piece, entry.meta.box));
      if (!missing.length || missing.length > 8) break;
    }
    return missing.map(bboxString).filter(Boolean);
  }

  function materialize(request) {
    const normalized = FrameIdentity.normalizeRequest(request);
    const exact = exactFrameKey(normalized);
    if (exact && cache.has(exact)) return inspect(normalized);
    const covered = completeReusable(normalized);
    if (covered) {
      const stored = put(normalized, covered.packet, { reason: "covered_bbox" });
      return { ...stored, cacheHit: true, reusedFrom: covered.sourceFrameKey };
    }
    const missing = missingRegions(normalized);
    if (missing.length) return null;
    const requestBox = boxFromRequest(normalized);
    const entries = compatibleEntries(normalized).filter((entry) => intersectBbox(entry.meta.box, requestBox));
    if (!entries.length) return null;
    const frame = CanonicalGridFrame.merge(entries.map((entry) => entry.packet.frame)).filterBbox(
      requestBox,
      BBOX_EPSILON,
    );
    const packet = clonePacketForFrame(entries[0].packet, normalized, frame, {
      browser_cache_reuse: "composed_bbox",
      browser_cache_sources: entries.length,
    });
    const stored = put(normalized, packet, { reason: "composed_bbox" });
    return { ...stored, cacheHit: true, composedFrom: entries.map((entry) => entry.frameKey) };
  }

  function inspect(request) {
    const normalized = FrameIdentity.normalizeRequest(request);
    const intentKey = FrameIdentity.intentKey(normalized);
    const frameKey = aliases.get(intentKey);
    if (frameKey && cache.has(frameKey)) {
      incrementStat("hits");
      return { status: "ready", packet: touch(frameKey), cacheHit: true, intentKey, frameKey };
    }
    const failure = failures.get(intentKey);
    if (failure) return { status: "failed", cacheHit: false, intentKey, frameKey: "", failure };
    const covered = completeReusable(normalized);
    if (covered) {
      incrementStat("coveredReuses");
      touch(covered.sourceFrameKey);
      return {
        status: "ready",
        packet: covered.packet,
        cacheHit: true,
        intentKey,
        frameKey: covered.sourceFrameKey,
        reusedFrom: covered.sourceFrameKey,
      };
    }
    incrementStat("misses");
    return { status: "missing", packet: null, cacheHit: false, intentKey, frameKey: "" };
  }

  function put(request, packet, { reason = "query", lane = "", scopeId = "" } = {}) {
    const normalized = FrameIdentity.normalizeRequest(request);
    const intentKey = FrameIdentity.intentKey(normalized);
    if (!CanonicalGridFrame.isFrame(packet?.frame)) {
      throw new TypeError("DataFrameStore accepts only canonical grid frame packets");
    }
    const storedPacket = scopePacketToRequest(packet, normalized);
    const frameKey = FrameIdentity.frameKey(normalized, storedPacket);
    const actualResolution = FrameIdentity.actualResolutionFrom(storedPacket, normalized);
    const actualIntentKey = actualResolution == null
      ? intentKey
      : FrameIdentity.intentKey({ ...normalized, resolution: actualResolution });
    const size = estimatePacketBytes(storedPacket);
    const { maxBytes } = options();
    if (maxBytes > 0 && size > maxBytes) {
      incrementStat("skippedOversize");
      syncStats({ skippedOversizeBytes: size });
      return { status: "oversize", packet: storedPacket, cacheHit: false, intentKey, frameKey };
    }
    removeFrame(frameKey, { force: true, reason: "replace" });
    const immutablePacket = Object.freeze({
      ...storedPacket,
      timing: Object.freeze({ ...(storedPacket.timing || {}) }),
      grid: Object.freeze({ ...(storedPacket.grid || {}) }),
    });
    cache.set(frameKey, immutablePacket);
    packetSizes.set(frameKey, size);
    cacheBytes += size;
    aliases.set(intentKey, frameKey);
    aliases.set(actualIntentKey, frameKey);
    failures.delete(intentKey);
    failures.delete(actualIntentKey);
    metadata.set(frameKey, {
      ...normalized,
      box: boxFromRequest(normalized),
      datasetId: normalized.datasetId,
      cacheNamespace: normalized.cacheNamespace,
      requestedResolution: normalized.resolution,
      effectiveQueryResolution: FrameIdentity.queryResolution(normalized),
      actualResolution,
      intentKey,
      intentKeys: [...new Set([intentKey, actualIntentKey])],
      frameKey,
    });
    enforceBudget();
    const change = {
      type: "committed",
      reason,
      intentKey,
      frameKey,
      datasetId: normalized.datasetId,
      layerId: normalized.layerId || "",
      date: normalized.date,
      bbox: normalized.bbox,
      requestedResolution: normalized.resolution,
      actualResolution,
      bytes: size,
    };
    LifecycleEventLog?.record?.("CACHE_READY", {
      intent_key: intentKey,
      frame_key: frameKey,
      scope_key: FrameIdentity.scopeKey(normalized),
      scope_id: String(scopeId || ""),
      lane: String(lane || ""),
      dataset: normalized.datasetId,
      date: normalized.date,
      bbox: normalized.bbox,
      bytes: size,
      requested_resolution_km: normalized.resolution,
      effective_query_resolution_km: FrameIdentity.queryResolution(normalized),
      actual_resolution_km: change.actualResolution,
    });
    notify(change);
    return { status: "ready", packet: immutablePacket, cacheHit: false, intentKey, frameKey };
  }

  function markFailed(request, error) {
    const normalized = FrameIdentity.normalizeRequest(request);
    const intentKey = FrameIdentity.intentKey(normalized);
    const failure = Object.freeze({
      message: error?.message || String(error || "request failed"),
      name: error?.name || "Error",
      monotonic_ms: clock.now(),
    });
    failures.set(intentKey, failure);
    notify({ type: "failed", intentKey, datasetId: normalized.datasetId, date: normalized.date, failure });
    return failure;
  }

  function clearFailure(request) {
    failures.delete(FrameIdentity.intentKey(FrameIdentity.normalizeRequest(request)));
  }

  function pin(requestOrKey, owner = "anonymous") {
    const candidate = typeof requestOrKey === "string"
      ? requestOrKey
      : exactFrameKey(FrameIdentity.normalizeRequest(requestOrKey));
    const frameKey = aliases.get(candidate) || candidate;
    if (!frameKey || !cache.has(frameKey)) return false;
    const owners = pins.get(frameKey) || new Set();
    owners.add(String(owner));
    pins.set(frameKey, owners);
    syncStats();
    return true;
  }

  function release(requestOrKey, owner = "anonymous") {
    const candidate = typeof requestOrKey === "string"
      ? requestOrKey
      : exactFrameKey(FrameIdentity.normalizeRequest(requestOrKey));
    const frameKey = aliases.get(candidate) || candidate;
    const owners = pins.get(frameKey);
    if (!owners) return false;
    owners.delete(String(owner));
    if (!owners.size) pins.delete(frameKey);
    enforceBudget();
    return true;
  }

  function list(filter = {}) {
    return [...cache.entries()].map(([frameKey, packet]) => ({ frameKey, packet, meta: metadata.get(frameKey) }))
      .filter((entry) => !filter.datasetId || entry.meta?.datasetId === String(filter.datasetId))
      .filter((entry) => !filter.date || entry.meta?.date === String(filter.date))
      .filter((entry) => !filter.layerId || entry.meta?.layerId === String(filter.layerId));
  }

  function snapshot(filter = {}) {
    const {
      maxBytes,
      maxEntries,
      configuredMaxBytes,
      heapLimitBytes,
      heapSafeMaxBytes,
      heapBudgetFraction,
      heapSafetyApplied,
    } = options();
    return Object.freeze({
      entries: cache.size,
      aliases: aliases.size,
      bytes: cacheBytes,
      ...frameSizeStats(filter),
      maxBytes,
      configuredMaxBytes,
      heapLimitBytes,
      heapSafeMaxBytes,
      heapBudgetFraction,
      heapSafetyApplied,
      maxEntries,
      pinned: [...pins.values()].reduce((total, owners) => total + owners.size, 0),
      failures: failures.size,
    });
  }

  function evictAll({ force = true } = {}) {
    for (const frameKey of [...cache.keys()]) removeFrame(frameKey, { force, reason: "manual_clear" });
    if (force) {
      aliases.clear();
      failures.clear();
      pins.clear();
    }
    syncStats();
    notify({ type: "cleared" });
  }

  function dispose() {
    listeners.clear();
    cache.clear();
    metadata.clear();
    aliases.clear();
    packetSizes.clear();
    pins.clear();
    failures.clear();
    cacheBytes = 0;
    syncStats();
  }

  Object.assign(this, {
    canSatisfy,
    clearFailure,
    dispose,
    enforceBudget,
    evictAll,
    has: (request) => inspect(request).status === "ready",
    inspect,
    keyFor: (request) => FrameIdentity.intentKey(FrameIdentity.normalizeRequest(request)),
    list,
    markFailed,
    materialize,
    missingRegions,
    pin,
    put,
    release,
    snapshot,
    subscribe,
  });
  Object.freeze(this);
  }
}

if (typeof globalThis !== "undefined") globalThis.DataFrameStoreCore = DataFrameStoreCore;
