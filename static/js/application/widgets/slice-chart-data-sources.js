(() => {
class PieChartDataSource {
  constructor({ queryContext, eventSink } = {}) {
    if (!queryContext) throw new TypeError("PieChartDataSource requires WidgetQueryContext");
    this.queryContext = queryContext;
    this.eventSink = eventSink;
    this.cache = new Map();
    this.inflight = new Map();
    this.generation = 0;
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
    this.inflight.clear();
  }

  dispose() {
    this.clear();
  }

  statusModel(stateName, title, detail, extra = {}) {
    return {
      state: stateName,
      title,
      detail,
      date: extra.date || "",
      metric: "value",
      totalLabel: extra.totalLabel || "Y 總量",
      valueRole: "y",
      total: 0,
      slices: [],
      selection: extra.selection || null,
      rowCount: 0,
    };
  }

  requestForCurrentState({ excludedLayerIds = [] } = {}) {
    const selected = this.queryContext.selectedCell();
    if (!selected) {
      return { blocked: this.statusModel("waiting", "等待網格選取", "尚未點選取樣網格") };
    }
    if (!this.queryContext.bbox(selected)) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 canonical bbox", { selection: selected }) };
    }
    const date = this.queryContext.currentDate(selected);
    if (!date) {
      return { blocked: this.statusModel("waiting", "等待時間切片", "尚未取得單日模式日期", { selection: selected }) };
    }
    const layers = this.queryContext.sampledGridLayers({ excludedLayerIds });
    if (!layers.length) {
      return { blocked: this.statusModel("waiting", "等待資料合約", "沒有啟用的 sampled-grid 圖層", { date, selection: selected }) };
    }
    const key = [
      selected.selection_id || selected.bbox_string,
      date,
      layers.map((layer) => layer.layerId).sort().join(","),
      selected.selection_grid?.revision || 0,
    ].join("|");
    return { key, selected, date, layers };
  }

  async loadModel(request, generation) {
    const results = await Promise.all(request.layers.map((layer) => (
      this.queryContext.fetchValue(layer, request.selected)
    )));
    const available = results.filter((result) => ["observed", "zero"].includes(result.status));
    const slices = available.map((result) => ({
      label: result.layer.label,
      datasetId: result.layer.datasetId,
      layerId: result.layer.layerId,
      datasetLabel: result.layer.dataset?.label || result.layer.label,
      yKey: "value",
      aggregation: "sum",
      value: Math.max(0, Number(result.value || 0)),
      color: this.queryContext.colorFor(result.layer.layerId, 0.96),
      className: "legend-a",
      status: result.status,
    }));
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    const unavailableCount = results.filter((result) => result.status === "unavailable").length;
    const model = {
      state: available.length ? (total > 0 ? "ready" : "zero") : (unavailableCount ? "error" : "zero"),
      title: total > 0 ? "網格切片比例" : available.length ? "切片總量為 0" : "沒有可用切片",
      detail: `${request.date} / ${request.selected.tile_key || request.selected.label || ""}`,
      date: request.date,
      metric: "value",
      totalLabel: "Y 總量",
      valueRole: "y",
      total,
      slices,
      selection: request.selected,
      rowCount: results.reduce((sum, result) => sum + Number(result.rowCount || 0), 0),
      sourceCount: request.layers.length,
      unavailableCount,
    };
    if (generation === this.generation) {
      this.cache.set(request.key, model);
      this.eventSink?.("rrkal:pie-chart-data-changed", { key: request.key, state: model.state });
    }
    return model;
  }

  model(options = {}) {
    const request = this.requestForCurrentState(options);
    if (request.blocked) return request.blocked;
    if (this.cache.has(request.key)) return this.cache.get(request.key);
    if (!this.inflight.has(request.key)) {
      const generation = this.generation;
      const loader = this.loadModel(request, generation).finally(() => {
        if (this.inflight.get(request.key) === loader) this.inflight.delete(request.key);
      });
      this.inflight.set(request.key, loader);
    }
    return this.statusModel("loading", "載入切片比例", `${request.date} / ${request.layers.length} 個圖層`, {
      date: request.date,
      selection: request.selected,
    });
  }
}

class HorizontalBarChartDataSource {
  constructor({ queryContext, eventSink } = {}) {
    if (!queryContext) throw new TypeError("HorizontalBarChartDataSource requires WidgetQueryContext");
    this.queryContext = queryContext;
    this.eventSink = eventSink;
    this.cache = new Map();
    this.inflight = new Map();
    this.generation = 0;
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
    this.inflight.clear();
  }

  dispose() {
    this.clear();
  }

  statusModel(stateName, title, detail) {
    return {
      state: stateName,
      title,
      detail,
      xLabel: "canonical value",
      yLabel: "儲存標籤",
      categories: [],
      values: [],
      colors: [],
      series: [],
    };
  }

  requestForCurrentState({ excludedLayerIds = [], excludedSelectionIds = [], aliases = {}, sort = "selection" } = {}) {
    const excludedSelections = new Set(excludedSelectionIds);
    const selections = this.queryContext.selections()
      .filter((selection) => !excludedSelections.has(selection.selection_id));
    if (!selections.length) {
      return { blocked: this.statusModel("waiting", "等待儲存標籤", "請使用連續網格選取建立比較標籤") };
    }
    const layers = this.queryContext.sampledGridLayers({ excludedLayerIds });
    if (!layers.length) {
      return { blocked: this.statusModel("waiting", "等待資料圖層", "沒有啟用的 sampled-grid 圖層") };
    }
    const key = JSON.stringify({
      selections: selections.map((selection) => [
        selection.selection_id,
        this.queryContext.currentDate(selection),
        selection.bbox_string,
      ]),
      layers: layers.map((layer) => layer.layerId),
      aliases,
      sort,
    });
    return { key, selections, layers, aliases, sort };
  }

  defaultSelectionLabel(selection, index) {
    const date = this.queryContext.currentDate(selection);
    const prefix = selection?.time_binding?.kind === "locked_axis" ? "異時" : "同時";
    return `${prefix} ${index + 1}${date ? ` · ${date}` : ""}`;
  }

  sortSelections(selections, totals, sort) {
    const indexed = selections.map((selection, index) => ({ selection, index, total: totals[index] }));
    const compareMissingLast = (left, right, direction) => {
      const leftAvailable = Number.isFinite(left.total);
      const rightAvailable = Number.isFinite(right.total);
      if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
      if (!leftAvailable) return left.index - right.index;
      return direction * (left.total - right.total) || left.index - right.index;
    };
    if (sort === "value_desc") indexed.sort((left, right) => compareMissingLast(left, right, -1));
    if (sort === "value_asc") indexed.sort((left, right) => compareMissingLast(left, right, 1));
    return indexed;
  }

  comparableValue(result) {
    if (!["observed", "zero"].includes(result?.status)) return null;
    const value = Number(result.value);
    return Number.isFinite(value) ? value : null;
  }

  async loadModel(request, generation) {
    const matrix = await Promise.all(request.layers.map(async (layer) => ({
      layer,
      results: await Promise.all(request.selections.map((selection) => (
        this.queryContext.fetchValue(layer, selection)
      ))),
    })));
    const totals = request.selections.map((_, selectionIndex) => {
      const values = matrix
        .map((row) => this.comparableValue(row.results[selectionIndex]))
        .filter((value) => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    });
    const ordered = this.sortSelections(request.selections, totals, request.sort);
    const categories = ordered.map(({ selection, index }) => (
      request.aliases[selection.selection_id] || this.defaultSelectionLabel(selection, index)
    ));
    const series = matrix.map(({ layer, results }) => ({
      layerId: layer.layerId,
      datasetId: layer.datasetId,
      label: layer.label,
      color: this.queryContext.colorFor(layer.layerId, 0.88),
      values: ordered.map(({ index }) => this.comparableValue(results[index])),
      statuses: ordered.map(({ index }) => results[index]?.status || "missing"),
    }));
    const values = ordered.map(({ total }) => total);
    const observed = matrix.flatMap((row) => row.results)
      .filter((result) => ["observed", "zero"].includes(result.status));
    const total = values.reduce((sum, value) => (
      sum + (Number.isFinite(value) ? Math.max(0, value) : 0)
    ), 0);
    const model = {
      state: observed.length ? (total > 0 ? "ready" : "zero") : "error",
      title: observed.length ? (total > 0 ? "網格標籤比較" : "比較值皆為 0") : "沒有可比較資料",
      detail: `${request.selections.length} 個標籤 / ${request.layers.length} 個圖層`,
      xLabel: "canonical value",
      yLabel: "儲存標籤",
      categories,
      values,
      colors: categories.map((_, index) => this.queryContext.colorFor(`selection-${index}`, 0.82)),
      series,
      rowCount: matrix.flatMap((row) => row.results).reduce((sum, result) => sum + Number(result.rowCount || 0), 0),
    };
    if (generation === this.generation) {
      this.cache.set(request.key, model);
      this.eventSink?.("rrkal:horizontal-bar-data-changed", { key: request.key, state: model.state });
    }
    return model;
  }

  model(options = {}) {
    const request = this.requestForCurrentState(options);
    if (request.blocked) return request.blocked;
    if (this.cache.has(request.key)) return this.cache.get(request.key);
    if (!this.inflight.has(request.key)) {
      const generation = this.generation;
      const loader = this.loadModel(request, generation).finally(() => {
        if (this.inflight.get(request.key) === loader) this.inflight.delete(request.key);
      });
      this.inflight.set(request.key, loader);
    }
    return this.statusModel("loading", "載入標籤比較", `${request.selections.length} 個標籤 / ${request.layers.length} 個圖層`);
  }
}

globalThis.PieChartDataSource = PieChartDataSource;
globalThis.HorizontalBarChartDataSource = HorizontalBarChartDataSource;
})();
