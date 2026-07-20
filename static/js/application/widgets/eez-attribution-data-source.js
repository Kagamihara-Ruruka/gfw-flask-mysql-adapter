(() => {
class EezAttributionDataSource {
  constructor({
    queryContext,
    queryCoordinator,
    eventSink,
    clock,
    cacheVersionProvider = () => "",
    cacheMaxEntries = 128,
    retryDelayMs = 3000,
  } = {}) {
    if (!queryContext || !queryCoordinator || !clock || typeof clock.now !== "function") {
      throw new TypeError("EezAttributionDataSource requires query context, coordinator and clock");
    }
    this.queryContext = queryContext;
    this.queryCoordinator = queryCoordinator;
    this.eventSink = eventSink;
    this.clock = clock;
    this.cacheVersionProvider = cacheVersionProvider;
    this.retryDelayMs = Math.max(250, Number(retryDelayMs) || 3000);
    this.cache = new BoundedLruMap({ maxEntries: cacheMaxEntries });
    this.failures = new BoundedLruMap({ maxEntries: cacheMaxEntries });
    this.inflight = new Map();
    this.eventSelections = [];
    this.disposed = false;
    this.cacheEpoch = new AsyncEpoch({ label: "eez-attribution" });
    this.cacheVersion = String(this.cacheVersionProvider?.() || "");
    this.cacheToken = this.cacheEpoch.begin(this.cacheVersion || "initial");
  }

  syncCacheVersion() {
    const nextVersion = String(this.cacheVersionProvider?.() || "");
    if (nextVersion === this.cacheVersion) return;
    this.cacheVersion = nextVersion;
    this.cache.clear();
    this.failures.clear();
    this.inflight.clear();
    this.cacheToken = this.cacheEpoch.begin(nextVersion || "updated");
  }

  selectedCells() {
    const selected = this.queryContext.selections();
    return selected.length ? selected : this.eventSelections;
  }

  rememberTileSelection(event) {
    const reason = event?.detail?.reason;
    const items = Array.isArray(event?.detail?.items) ? event.detail.items : [];
    const selected = event?.detail?.selected || null;
    if (["disabled", "cleared"].includes(reason) || (!items.length && !selected)) {
      this.eventSelections = [];
      return;
    }
    this.eventSelections = items.length ? [...items] : [selected];
  }

  selectedBbox(selected) {
    return this.queryContext.bbox(selected);
  }

  selectedBboxString(selected) {
    const bbox = this.selectedBbox(selected);
    if (!bbox) return "";
    return selected.bbox_string || bbox.map((value) => Number(value).toFixed(6)).join(",");
  }

  statusModel(stateName, title, detail, extra = {}) {
    return {
      state: stateName,
      title,
      detail,
      selection: extra.selection || null,
      hit: extra.hit || null,
      attribution: extra.attribution || [],
      domain: extra.domain || null,
      jurisdictionKind: extra.jurisdictionKind || null,
      fallback: extra.fallback || null,
      query: extra.query || null,
      preview: extra.preview || null,
      timing: extra.timing || {},
      results: extra.results || [],
      selectionCount: Number(extra.selectionCount || 0),
      readyCount: Number(extra.readyCount || 0),
    };
  }

  requestForCurrentState() {
    const selectedCells = this.selectedCells();
    if (!selectedCells.length) {
      return { blocked: this.statusModel("waiting", "等待網格選取", "啟用網格選取後點選一格") };
    }
    const requests = selectedCells.map((selected, index) => ({
      key: this.selectedBboxString(selected),
      selected,
      index,
      bboxString: this.selectedBboxString(selected),
    })).filter((request) => request.bboxString);
    if (!requests.length) {
      return {
        blocked: this.statusModel("waiting", "等待 bbox", "目前選取沒有可判定的網格範圍", {
          selection: selectedCells[0] || null,
          selectionCount: selectedCells.length,
        }),
      };
    }
    return { requests };
  }

  model() {
    if (this.disposed) return this.statusModel("unavailable", "EEZ unavailable", "data source disposed");
    this.syncCacheVersion();
    const plan = this.requestForCurrentState();
    if (plan.blocked) return plan.blocked;
    const results = plan.requests.map((request) => {
      const cached = this.cache.get(request.key);
      if (cached) return { ...cached, selection: request.selected };
      const failed = this.failures.get(request.key);
      if (failed && failed.retryAt > this.clock.now()) {
        return { ...failed.model, selection: request.selected };
      }
      if (failed) this.failures.delete(request.key);
      this.fetch(request);
      return this.statusModel("loading", "判定中", request.selected.tile_key || request.bboxString, {
        selection: request.selected,
      });
    });
    const primary = results[0] || this.statusModel("waiting", "等待網格選取", "");
    return {
      ...primary,
      results,
      selectionCount: results.length,
      readyCount: results.filter((result) => ["ready", "high-seas", "land", "mixed"].includes(result.state)).length,
    };
  }

  fetch(request) {
    if (this.disposed) return Promise.resolve(null);
    if (this.inflight.has(request.key)) return this.inflight.get(request.key);
    const token = this.cacheToken;
    const params = new URLSearchParams({ bbox: request.bboxString, limit: "6" });
    let loader = null;
    loader = this.queryCoordinator.fetchEezAttribution(params, {
      lane: "overlay",
      scopeId: "widget:eez-attribution",
      signal: token.signal,
    })
      .then((packet) => {
        if (this.disposed || !this.cacheEpoch.isCurrent(token)) return;
        this.failures.delete(request.key);
        this.cache.set(request.key, this.packetToModel(request, packet));
      })
      .catch((error) => {
        if (this.disposed || !this.cacheEpoch.isCurrent(token) || error?.name === "AbortError") return;
        this.failures.set(request.key, {
          retryAt: this.clock.now() + this.retryDelayMs,
          model: this.statusModel("error", "判定失敗", error.message || "EEZ attribution failed", {
            selection: request.selected,
          }),
        });
      })
      .finally(() => {
        if (this.inflight.get(request.key) === loader) this.inflight.delete(request.key);
        if (!this.disposed && this.cacheEpoch.isCurrent(token)) {
          this.eventSink?.("rrkal:eez-attribution-data-changed", { key: request.key });
        }
      });
    this.inflight.set(request.key, loader);
    return loader;
  }

  packetToModel(request, packet) {
    const attribution = Array.isArray(packet?.attribution) ? packet.attribution : [];
    const hit = attribution[0] || null;
    const domain = packet?.domain && typeof packet.domain === "object" ? packet.domain : null;
    if (!hit) {
      const kind = ["high_seas", "land", "mixed"].includes(domain?.kind)
        ? domain.kind
        : "unresolved";
      const modelByKind = {
        high_seas: ["high-seas", "公海", "位於 EEZ 管轄範圍之外"],
        land: ["land", "陸地", "不屬於海域管轄範圍"],
        mixed: ["mixed", "混合區域", "選取格跨越不同空間域"],
        unresolved: ["unresolved", "無法判定", "EEZ 空間域資料未能解析"],
      };
      const [stateName, title, detail] = modelByKind[kind];
      return this.statusModel(stateName, title, detail, {
        selection: request.selected,
        attribution,
        domain,
        jurisdictionKind: kind,
        fallback: packet?.fallback || (kind === "unresolved" ? "domain_unresolved" : null),
        query: packet?.query || null,
        preview: packet?.preview || null,
        timing: packet?.timing || {},
      });
    }
    const polType = String(hit.pol_type || "").trim().toLowerCase();
    const jurisdictionKind = polType === "overlapping claim"
      ? "disputed"
      : polType === "joint regime" ? "joint" : "eez";
    const label = hit.sovereign || hit.territory || hit.name || "EEZ";
    const ratio = Number(hit.overlap_ratio);
    const detailParts = [
      hit.territory,
      Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "",
    ].filter(Boolean);
    return this.statusModel("ready", label, detailParts.join(" / ") || hit.name || "EEZ", {
      selection: request.selected,
      hit,
      attribution,
      domain,
      jurisdictionKind,
      query: packet?.query || null,
      preview: packet?.preview || null,
      timing: packet?.timing || {},
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cacheEpoch.dispose("disposed");
    this.cache.clear();
    this.failures.clear();
    this.inflight.clear();
    this.eventSelections = [];
  }
}

globalThis.EezAttributionDataSource = EezAttributionDataSource;
})();
