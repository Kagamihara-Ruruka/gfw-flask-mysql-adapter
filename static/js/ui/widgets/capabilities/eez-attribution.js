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

class EezAttributionWidget extends DashboardWidget {
  attributionModel() {
    return this.services.dataSource.model();
  }

  primaryHit(model = this.attributionModel()) {
    return model.hit || model.attribution?.[0] || null;
  }

  ratioLabel(hit) {
    const ratio = Number(hit?.overlap_ratio);
    if (!Number.isFinite(ratio)) return "point";
    return `${Math.round(ratio * 100)}%`;
  }

  domainRatioLabel(model) {
    const regions = Array.isArray(model?.domain?.regions) ? model.domain.regions : [];
    const ratio = Number(regions[0]?.overlap_ratio);
    return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "--";
  }

  jurisdictionKindLabel(model) {
    return {
      disputed: "爭議海域",
      joint: "共管海域",
      eez: "EEZ",
      high_seas: "公海",
      land: "陸地",
      mixed: "混合區域",
    }[model?.jurisdictionKind] || "空間域";
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
    if (result?.state === "high-seas") return "公海";
    if (result?.state === "land") return "陸地";
    if (result?.state === "mixed") return "混合區域";
    return result?.title || "判定中";
  }

  renderOtherLocationResults(model) {
    const otherResults = Array.isArray(model?.results) ? model.results.slice(1) : [];
    if (!otherResults.length) return "";
    const rows = otherResults.map((result, index) => {
      const hit = result.hit || result.attribution?.[0] || null;
      const ratio = result.state === "ready"
        ? this.ratioLabel(hit)
        : ["high-seas", "land", "mixed"].includes(result.state)
          ? this.domainRatioLabel(result)
          : "--";
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
    const ratio = isReady
      ? this.ratioLabel(hit)
      : ["high-seas", "land", "mixed"].includes(model.state)
        ? this.domainRatioLabel(model)
        : "--";
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
        <span>${lineChartEscape(this.jurisdictionKindLabel(model))}</span>
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
    const domainRows = (model.domain?.regions || []).map((region) => `
      <tr>
        <td>${lineChartEscape(region.kind === "high_seas" ? "公海" : region.kind === "land" ? "陸地" : region.kind)}</td>
        <td>EEZ 補集合</td>
        <td>${lineChartEscape(this.domainRatioLabel({ domain: { regions: [region] } }))}</td>
      </tr>
    `).join("");
    const resultRows = `${rows}${domainRows}`;
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
            ${resultRows || '<tr><td colspan="3">空間域未解析</td></tr>'}
          </tbody>
        </table>
        ${otherLocations}
      </div>
    `;
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { EezAttributionWidget });
})();
