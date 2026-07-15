(() => {
const { DashboardWidget } = window.WidgetCore;
const { lineChartEscape } = window.WidgetCapabilityShared;
const EezRegionNameAlias = Object.freeze({
  "comores": "KM",
  "democratic republic of the congo": "CD",
  "east timor": "TL",
  "federal republic of somalia": "SO",
  "ivory coast": "CI",
  "north korea": "KP",
  "republic of mauritius": "MU",
  "republic of the congo": "CG",
  "russia": "RU",
  "sao tome and principe": "ST",
  "south korea": "KR",
  "syria": "SY",
  "tanzania": "TZ",
  "turkey": "TR",
  "western sahara": "EH",
});

let eezRegionCodeByNameCache = null;

function normalizeEezRegionName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function eezRegionCodes() {
  if (typeof Intl.supportedValuesOf === "function") {
    try {
      return Intl.supportedValuesOf("region").filter((code) => /^[A-Z]{2}$/.test(code));
    } catch (err) {
      // Older Chromium builds do not support the "region" key here.
    }
  }
  const codes = [];
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      codes.push(String.fromCharCode(first, second));
    }
  }
  return codes;
}

function eezRegionCodeByName() {
  if (eezRegionCodeByNameCache) return eezRegionCodeByNameCache;
  const result = new Map();
  let names = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "region" });
  } catch (err) {
    eezRegionCodeByNameCache = result;
    return result;
  }
  eezRegionCodes().forEach((code) => {
    let name = "";
    try {
      name = names.of(code);
    } catch (err) {
      return;
    }
    const key = normalizeEezRegionName(name);
    if (key && key !== code.toLowerCase()) result.set(key, code);
  });
  Object.entries(EezRegionNameAlias).forEach(([name, code]) => {
    result.set(normalizeEezRegionName(name), code);
  });
  eezRegionCodeByNameCache = result;
  return result;
}

function eezFlagEmojiForHit(hit) {
  const lookup = eezRegionCodeByName();
  const key = normalizeEezRegionName(hit?.sovereign || hit?.territory || "");
  const code = lookup.get(key);
  if (!/^[A-Z]{2}$/.test(code || "")) return "";
  return Array.from(code).map((char) => String.fromCodePoint(127397 + char.charCodeAt(0))).join("");
}

class EezAttributionDataSource {
  static shared() {
    if (!EezAttributionDataSource.instance) {
      EezAttributionDataSource.instance = new EezAttributionDataSource();
    }
    return EezAttributionDataSource.instance;
  }

  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
    this.eventSelections = [];
  }

  selectedCells() {
    const sources = [
      this.selectedFromState(),
      this.selectedFromLayer(),
      this.eventSelections,
    ];
    const selected = sources.find((items) => Array.isArray(items) && items.length);
    return selected || [];
  }

  selectedFromState() {
    try {
      if (typeof state === "undefined") return [];
      const items = state?.tileSelection?.items;
      if (Array.isArray(items) && items.length) return items;
      return state?.tileSelection?.selected ? [state.tileSelection.selected] : [];
    } catch (err) {
      return [];
    }
  }

  selectedFromLayer() {
    try {
      const items = window.TileSelectionLayer?.selections?.();
      if (Array.isArray(items) && items.length) return items;
      const selected = window.TileSelectionLayer?.selected?.();
      return selected ? [selected] : [];
    } catch (err) {
      return [];
    }
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
    return Array.isArray(selected?.bbox) && selected.bbox.length === 4 ? selected.bbox.map(Number) : null;
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
      return {
        blocked: this.statusModel("waiting", "等待網格選取", "啟用網格選取後點選一格"),
      };
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
    const params = new URLSearchParams({
      bbox: request.bboxString,
      limit: "6",
    });
    const loader = LayerQueryCoordinator.fetchEezAttribution(params, { lane: "overlay" })
      .then((packet) => {
        this.cache.set(request.key, this.packetToModel(request, packet));
      })
      .catch((err) => {
        this.cache.set(request.key, this.statusModel("error", "判定失敗", err.message || "EEZ attribution failed", {
          selection: request.selected,
        }));
      })
      .finally(() => {
        this.inflight.delete(request.key);
        window.dispatchEvent(new CustomEvent("rrkal:eez-attribution-data-changed", {
          detail: { key: request.key },
        }));
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
}

class EezAttributionWidget extends DashboardWidget {
  attributionModel() {
    return EezAttributionDataSource.shared().model();
  }

  primaryHit(model = this.attributionModel()) {
    return model.hit || model.attribution?.[0] || null;
  }

  ratioLabel(hit) {
    const ratio = Number(hit?.overlap_ratio);
    if (!Number.isFinite(ratio)) return "point";
    return `${Math.round(ratio * 100)}%`;
  }

  resultTimeLabel(result) {
    const binding = result?.selection?.time_binding;
    if (binding?.kind !== "locked_axis") return "跟隨播放器";
    const axis = binding.axis || result?.selection?.time_axis || {};
    const range = [axis.start, axis.end].filter(Boolean).join(" - ");
    if (range && axis.cursor) return `${range} / ${axis.cursor}`;
    return axis.cursor || range || "已鎖定時間軸";
  }

  resultJurisdictionLabel(result) {
    if (result?.state === "ready") {
      const hit = result.hit || result.attribution?.[0] || null;
      return hit?.sovereign || hit?.territory || hit?.name || "EEZ";
    }
    if (result?.state === "high-seas") return "未命中 EEZ";
    return result?.title || "判定中";
  }

  renderOtherLocationResults(model) {
    const otherResults = Array.isArray(model?.results) ? model.results.slice(1) : [];
    if (!otherResults.length) return "";
    const rows = otherResults.map((result, index) => {
      const hit = result.hit || result.attribution?.[0] || null;
      const ratio = result.state === "ready"
        ? this.ratioLabel(hit)
        : result.state === "high-seas" ? "0%" : "--";
      const tileLabel = result.selection?.tile_key || result.selection?.bbox_string || `Tile ${index + 2}`;
      return `
        <tr data-eez-result-index="${index + 1}">
          <td title="${lineChartEscape(tileLabel)}">${lineChartEscape(`Tile ${index + 2}`)}</td>
          <td title="${lineChartEscape(this.resultTimeLabel(result))}">${lineChartEscape(this.resultTimeLabel(result))}</td>
          <td title="${lineChartEscape(this.resultJurisdictionLabel(result))}">${lineChartEscape(this.resultJurisdictionLabel(result))}</td>
          <td>${lineChartEscape(ratio)}</td>
        </tr>
      `;
    }).join("");
    return `
      <section class="widget-eez-other-results" aria-label="其他異地判定">
        <header>
          <strong>其他異地</strong>
          <span>${otherResults.length} Tile</span>
        </header>
        <table class="widget-eez-table widget-eez-other-table">
          <thead>
            <tr><th>Tile</th><th>時間</th><th>管轄判定</th><th>比例</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    `;
  }

  isBoundaryModel(model) {
    return model?.state === "ready" && Array.isArray(model.attribution) && model.attribution.length > 1;
  }

  boundaryColor(index) {
    return [
      "rgba(56, 189, 248, 0.82)",
      "rgba(34, 197, 94, 0.78)",
      "rgba(250, 204, 21, 0.76)",
      "rgba(248, 113, 113, 0.76)",
      "rgba(168, 85, 247, 0.72)",
      "rgba(226, 232, 240, 0.56)",
    ][index % 6];
  }

  boundaryName(hit) {
    return hit?.sovereign || hit?.territory || hit?.iso3 || "EEZ";
  }

  previewBbox(model) {
    const bbox = model?.preview?.bbox || model?.query?.bbox || model?.selection?.bbox || null;
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const values = bbox.map(Number);
    const [west, south, east, north] = values;
    return values.every(Number.isFinite) && west < east && south < north ? values : null;
  }

  previewFeatures(model) {
    const features = Array.isArray(model?.preview?.features) ? model.preview.features : [];
    return features.filter((feature) => feature?.geometry).slice(0, 6);
  }

  clampPreviewCoord(value) {
    return Math.max(0, Math.min(100, value));
  }

  svgPointForCoord(coord, bbox) {
    if (!Array.isArray(coord) || coord.length < 2) return null;
    const lon = Number(coord[0]);
    const lat = Number(coord[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const [west, south, east, north] = bbox;
    return {
      x: this.clampPreviewCoord(((lon - west) / (east - west)) * 100),
      y: this.clampPreviewCoord(((north - lat) / (north - south)) * 100),
    };
  }

  geometryRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates || [];
    if (geometry.type === "MultiPolygon") {
      return (geometry.coordinates || []).flatMap((polygon) => polygon || []);
    }
    if (geometry.type === "GeometryCollection") {
      return (geometry.geometries || []).flatMap((item) => this.geometryRings(item));
    }
    return [];
  }

  ringToPath(ring, bbox) {
    const points = (ring || []).map((coord) => this.svgPointForCoord(coord, bbox)).filter(Boolean);
    if (points.length < 3) return "";
    const [first, ...rest] = points;
    const commands = [`M${first.x.toFixed(2)} ${first.y.toFixed(2)}`];
    rest.forEach((point) => commands.push(`L${point.x.toFixed(2)} ${point.y.toFixed(2)}`));
    commands.push("Z");
    return commands.join(" ");
  }

  featurePath(feature, bbox) {
    return this.geometryRings(feature?.geometry)
      .map((ring) => this.ringToPath(ring, bbox))
      .filter(Boolean)
      .join(" ");
  }

  featureLabelPosition(feature, bbox) {
    const point = feature?.label_point;
    if (point) {
      const projected = this.svgPointForCoord([point.lon, point.lat], bbox);
      if (projected) return projected;
    }
    const ring = this.geometryRings(feature?.geometry)[0] || [];
    const points = ring.map((coord) => this.svgPointForCoord(coord, bbox)).filter(Boolean);
    if (!points.length) return null;
    const sum = points.reduce((acc, current) => ({
      x: acc.x + current.x,
      y: acc.y + current.y,
    }), { x: 0, y: 0 });
    return {
      x: sum.x / points.length,
      y: sum.y / points.length,
    };
  }

  renderGeometryTileThumbnail(model) {
    const bbox = this.previewBbox(model);
    const features = this.previewFeatures(model);
    if (!bbox || !features.length) return "";
    const shapes = features.map((feature, index) => {
      const path = this.featurePath(feature, bbox);
      if (!path) return "";
      const labelPoint = this.featureLabelPosition(feature, bbox);
      const ratio = Number(feature.overlap_ratio);
      const percent = Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "";
      const label = lineChartEscape(feature.label || feature.sovereign || feature.territory || feature.iso3 || "EEZ");
      const shouldLabel = Boolean(labelPoint) && (features.length <= 3 || (Number.isFinite(ratio) && ratio >= 0.08));
      return `
        <g>
          <path class="widget-eez-preview-shape" d="${path}" fill="${this.boundaryColor(index)}"></path>
          ${shouldLabel ? `
            <text x="${labelPoint.x.toFixed(2)}" y="${Math.max(12, labelPoint.y - 2).toFixed(2)}" text-anchor="middle">${label}</text>
            ${percent ? `<text x="${labelPoint.x.toFixed(2)}" y="${Math.min(96, labelPoint.y + 10).toFixed(2)}" text-anchor="middle">${lineChartEscape(percent)}</text>` : ""}
          ` : ""}
        </g>
      `;
    }).join("");
    if (!shapes.trim()) return "";
    return `
      <svg class="widget-eez-boundary-svg widget-eez-boundary-svg--tile" viewBox="0 0 100 100" role="img" aria-label="EEZ tile attribution preview">
        <rect class="widget-eez-boundary-bg" x="0" y="0" width="100" height="100"></rect>
        ${shapes}
        <path class="widget-eez-boundary-grid" d="M0 0H100V100H0Z M0 50H100 M50 0V100"></path>
      </svg>
    `;
  }

  renderBoundaryThumbnail(model) {
    const geometryPreview = this.renderGeometryTileThumbnail(model);
    if (geometryPreview) return geometryPreview;
    const hits = (model.attribution || []).slice(0, 6);
    const finiteTotal = hits.reduce((total, hit) => {
      const ratio = Number(hit?.overlap_ratio);
      return total + (Number.isFinite(ratio) && ratio > 0 ? ratio : 0);
    }, 0);
    let cursor = 0;
    const segments = hits.map((hit, index) => {
      const rawRatio = Number(hit?.overlap_ratio);
      const ratio = Number.isFinite(rawRatio) && rawRatio > 0
        ? rawRatio / (finiteTotal || 1)
        : 1 / Math.max(1, hits.length);
      const width = index === hits.length - 1 ? Math.max(0, 100 - cursor) : Math.max(4, ratio * 100);
      const x = cursor;
      cursor = Math.min(100, cursor + width);
      const label = lineChartEscape(this.boundaryName(hit));
      const percent = lineChartEscape(this.ratioLabel(hit));
      const showText = width >= 22;
      return `
        <g>
          <rect x="${x.toFixed(3)}" y="0" width="${width.toFixed(3)}" height="100" fill="${this.boundaryColor(index)}"></rect>
          ${showText ? `<text x="${(x + width / 2).toFixed(3)}" y="42" text-anchor="middle">${label}</text>` : ""}
          ${showText ? `<text x="${(x + width / 2).toFixed(3)}" y="61" text-anchor="middle">${percent}</text>` : ""}
        </g>
      `;
    }).join("");
    return `
      <svg class="widget-eez-boundary-svg" viewBox="0 0 100 100" role="img" aria-label="EEZ boundary attribution preview">
        <rect class="widget-eez-boundary-bg" x="0" y="0" width="100" height="100"></rect>
        ${segments}
        <path class="widget-eez-boundary-grid" d="M0 0H100V100H0Z M0 50H100 M50 0V100"></path>
      </svg>
    `;
  }

  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-eez-attribution");
    if (expanded) container.classList.add("is-expanded");
    const model = this.attributionModel();
    if (expanded) {
      this.renderExpandedAttribution(container, model);
      return;
    }
    this.renderCompactAttribution(container, model);
  }

  renderCompactAttribution(container, model) {
    const hit = this.primaryHit(model);
    const isReady = model.state === "ready" && hit;
    const isBoundary = this.isBoundaryModel(model);
    const title = isReady ? (hit.sovereign || hit.territory || "EEZ") : model.title;
    const detail = isReady ? (hit.territory || hit.name || model.detail) : model.detail;
    const ratio = isReady ? this.ratioLabel(hit) : model.state === "high-seas" ? "0%" : "--";
    const flag = isReady ? eezFlagEmojiForHit(hit) : "";
    container.dataset.attributionState = model.state;
    container.dataset.boundary = isBoundary ? "1" : "0";
    if (isBoundary) {
      container.innerHTML = `
        <div class="widget-eez-card widget-eez-card--boundary">
          <span>EEZ boundary</span>
          <div class="widget-eez-boundary-thumb">${this.renderBoundaryThumbnail(model)}</div>
          <em>${lineChartEscape((model.attribution || []).map((item) => this.boundaryName(item)).join(" / "))}</em>
        </div>
      `;
      return;
    }
    container.innerHTML = `
      <div class="widget-eez-card">
        <span>EEZ</span>
        <strong>${lineChartEscape(title)}${flag ? ` <span class="widget-eez-flag" aria-hidden="true">${flag}</span>` : ""}</strong>
        <em>${lineChartEscape(detail || "")}</em>
        <b>${lineChartEscape(ratio)}</b>
      </div>
    `;
  }

  renderExpandedAttribution(container, model) {
    const boundaryPreview = this.isBoundaryModel(model)
      ? `<div class="widget-eez-expanded-preview">${this.renderBoundaryThumbnail(model)}</div>`
      : "";
    const rows = (model.attribution || []).slice(0, 6).map((hit) => `
      <tr>
        <td>${lineChartEscape(hit.sovereign || "-")}</td>
        <td>${lineChartEscape(hit.territory || hit.name || "-")}</td>
        <td>${lineChartEscape(this.ratioLabel(hit))}</td>
      </tr>
    `).join("");
    const otherLocations = this.renderOtherLocationResults(model);
    container.dataset.attributionState = model.state;
    container.dataset.boundary = this.isBoundaryModel(model) ? "1" : "0";
    container.innerHTML = `
      <div class="widget-eez-expanded">
        <div class="widget-chart-header">
          <span>海域管轄判定</span>
          <strong>${lineChartEscape(model.title)}</strong>
          <em>${lineChartEscape(model.detail || "")}</em>
        </div>
        ${boundaryPreview}
        <table class="widget-eez-table">
          <thead>
            <tr><th>管轄參照</th><th>海域</th><th>比例</th></tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="3">未命中 EEZ</td></tr>'}
          </tbody>
        </table>
        ${otherLocations}
      </div>
    `;
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { EezAttributionDataSource, EezAttributionWidget });
})();
