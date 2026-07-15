(() => {
class EezAttributionDataSource {
  constructor({ queryContext, queryCoordinator, eventSink } = {}) {
    if (!queryContext || !queryCoordinator) {
      throw new TypeError("EezAttributionDataSource requires query context and coordinator");
    }
    this.queryContext = queryContext;
    this.queryCoordinator = queryCoordinator;
    this.eventSink = eventSink;
    this.cache = new Map();
    this.inflight = new Map();
    this.eventSelections = [];
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
    const plan = this.requestForCurrentState();
    if (plan.blocked) return plan.blocked;
    const results = plan.requests.map((request) => {
      const cached = this.cache.get(request.key);
      if (cached) return { ...cached, selection: request.selected };
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
      readyCount: results.filter((result) => ["ready", "high-seas"].includes(result.state)).length,
    };
  }

  fetch(request) {
    if (this.inflight.has(request.key)) return this.inflight.get(request.key);
    const params = new URLSearchParams({ bbox: request.bboxString, limit: "6" });
    const loader = this.queryCoordinator.fetchEezAttribution(params, { lane: "overlay" })
      .then((packet) => {
        this.cache.set(request.key, this.packetToModel(request, packet));
      })
      .catch((error) => {
        this.cache.set(request.key, this.statusModel("error", "判定失敗", error.message || "EEZ attribution failed", {
          selection: request.selected,
        }));
      })
      .finally(() => {
        this.inflight.delete(request.key);
        this.eventSink?.("rrkal:eez-attribution-data-changed", { key: request.key });
      });
    this.inflight.set(request.key, loader);
    return loader;
  }

  packetToModel(request, packet) {
    const attribution = Array.isArray(packet?.attribution) ? packet.attribution : [];
    const hit = attribution[0] || null;
    if (!hit) {
      return this.statusModel("high-seas", "未命中 EEZ", "公海或 EEZ 資料無匹配", {
        selection: request.selected,
        attribution,
        fallback: packet?.fallback || "high_seas_or_no_eez_match",
        query: packet?.query || null,
        preview: packet?.preview || null,
        timing: packet?.timing || {},
      });
    }
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
      query: packet?.query || null,
      preview: packet?.preview || null,
      timing: packet?.timing || {},
    });
  }

  dispose() {
    this.cache.clear();
    this.inflight.clear();
    this.eventSelections = [];
  }
}

globalThis.EezAttributionDataSource = EezAttributionDataSource;
})();
