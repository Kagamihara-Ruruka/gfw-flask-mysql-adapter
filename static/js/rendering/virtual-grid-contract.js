function virtualGridGcd(left, right) {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function virtualGridLcm(left, right) {
  return Math.abs((left / virtualGridGcd(left, right)) * right);
}

function virtualGridReduceFraction(numerator, denominator) {
  const divisor = virtualGridGcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function virtualGridFraction(value, maxDenominator = 1000000) {
  const target = Math.abs(Number(value));
  if (!Number.isFinite(target) || target <= 0) return null;
  let previousNumerator = 0;
  let numerator = 1;
  let previousDenominator = 1;
  let denominator = 0;
  let remainder = target;
  while (Number.isFinite(remainder)) {
    const integer = Math.floor(remainder);
    const nextNumerator = integer * numerator + previousNumerator;
    const nextDenominator = integer * denominator + previousDenominator;
    if (nextDenominator > maxDenominator) break;
    previousNumerator = numerator;
    numerator = nextNumerator;
    previousDenominator = denominator;
    denominator = nextDenominator;
    if (Math.abs((numerator / denominator) - target) <= 1e-10) break;
    const fractional = remainder - integer;
    if (fractional <= Number.EPSILON) break;
    remainder = 1 / fractional;
  }
  return denominator > 0 ? virtualGridReduceFraction(numerator, denominator) : null;
}

function virtualGridFractionLcm(fractions) {
  if (!fractions.length) return null;
  return fractions.reduce((result, fraction) => virtualGridReduceFraction(
    virtualGridLcm(result.numerator, fraction.numerator),
    virtualGridGcd(result.denominator, fraction.denominator),
  ));
}

function virtualGridNearlyInteger(value) {
  return Number.isFinite(value) && Math.abs(value - Math.round(value)) <= 1e-7;
}

function virtualGridCleanNumber(value) {
  return Number(Number(value).toFixed(12));
}

const LayerRuntimeContractRegistry = (() => {
  function layerId(contract) {
    return String(contract?.layer_id || "").trim().toLowerCase();
  }

  function datasetIdForContract(contract) {
    const declared = String(contract?.dataset_id || "").trim();
    if (declared && state.datasets?.[declared]) return declared;
    const id = layerId(contract);
    return Object.entries(state.datasets || {}).find(([, dataset]) => (
      String(dataset?.layer_id || dataset?.runtime?.layer_id || "").trim().toLowerCase() === id
    ))?.[0] || null;
  }

  function enabledLayerIds() {
    const enabled = new Set(
      (Array.isArray(state.enabledLayerIds) ? state.enabledLayerIds : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const primary = String(state.dataLayer || "").trim().toLowerCase();
    if (primary) enabled.add(primary);
    return enabled;
  }

  function sampledGridLayers({ importedOnly = true, enabledOnly = false } = {}) {
    const enabled = enabledOnly ? enabledLayerIds() : null;
    return (state.layerContracts || [])
      .filter((contract) => Boolean(contract?.capabilities?.sampled_grid))
      .filter((contract) => !importedOnly || Boolean(contract?.imported || state.importedLayers?.[layerId(contract)]))
      .filter((contract) => !enabledOnly || enabled.has(layerId(contract)))
      .map((contract) => {
        const datasetId = datasetIdForContract(contract);
        const dataset = state.datasets?.[datasetId] || null;
        if (!datasetId || !dataset?.sampled_grid) return null;
        return {
          contract,
          dataset,
          datasetId,
          layerId: layerId(contract),
          label: contract.label || dataset.label || layerId(contract),
        };
      })
      .filter(Boolean);
  }

  return Object.freeze({ datasetIdForContract, enabledLayerIds, sampledGridLayers });
})();

class ExactCommonGridResolver {
  resolve({ layers = [], zoom = null, latitude = null } = {}) {
    const participants = layers.map((layer) => {
      const model = SampledGridContract.model(layer.datasetId);
      const resolution = SampledGridContract.resolutionState(layer.datasetId);
      const geometry = model.gridGeometry(resolution.effectiveResolutionKm);
      return geometry ? {
        ...layer,
        model,
        requestedResolutionKm: resolution.requestedResolutionKm,
        actualResolutionKm: resolution.actualResolutionKm,
        effectiveResolutionKm: resolution.effectiveResolutionKm,
        degraded: resolution.degraded,
        geometry,
      } : null;
    }).filter(Boolean);
    if (!participants.length) {
      return this.unavailable("目前沒有已導入且具 sampled-grid 合約的圖層");
    }
    if (participants.length === 1) {
      return this.result("single", participants, participants[0].geometry);
    }
    const width = virtualGridFractionLcm(participants.map((item) => (
      virtualGridFraction(item.geometry.cell_width_degrees)
    )).filter(Boolean));
    const height = virtualGridFractionLcm(participants.map((item) => (
      virtualGridFraction(item.geometry.cell_height_degrees)
    )).filter(Boolean));
    if (!width || !height) return this.unavailable("圖層格網尺寸無法轉換為精確共同格距", participants);
    const cellWidth = width.numerator / width.denominator;
    const cellHeight = height.numerator / height.denominator;
    const origin = participants[0].geometry;
    const aligned = participants.every((item) => (
      virtualGridNearlyInteger(
        (origin.origin_lon - item.geometry.origin_lon) / item.geometry.cell_width_degrees,
      )
      && virtualGridNearlyInteger(
        (origin.origin_lat - item.geometry.origin_lat) / item.geometry.cell_height_degrees,
      )
    ));
    if (!aligned) return this.unavailable("圖層格網原點不相容，無法建立共同網格", participants);
    return this.result("common", participants, {
      encoding: "canonical_common_grid",
      origin_lon: origin.origin_lon,
      origin_lat: origin.origin_lat,
      cell_width_degrees: cellWidth,
      cell_height_degrees: cellHeight,
    });
  }

  result(status, participants, geometry) {
    const width = Number(geometry.cell_width_degrees);
    const height = Number(geometry.cell_height_degrees);
    const equivalentResolutions = participants.map((item) => (
      Number(item.effectiveResolutionKm) * Math.max(
        width / Number(item.geometry.cell_width_degrees),
        height / Number(item.geometry.cell_height_degrees),
      )
    )).filter(Number.isFinite);
    const resolutionKm = equivalentResolutions.length ? Math.max(...equivalentResolutions) : null;
    const participantRows = participants.map((item) => ({
      dataset_id: item.datasetId,
      layer_id: item.layerId,
      label: item.label,
      requested_resolution_km: item.requestedResolutionKm,
      actual_resolution_km: item.actualResolutionKm,
      effective_resolution_km: item.effectiveResolutionKm,
      lod_degraded: item.degraded,
      cell_width_degrees: item.geometry.cell_width_degrees,
      cell_height_degrees: item.geometry.cell_height_degrees,
    }));
    return {
      strategy: "least_common_multiple",
      status,
      participants: participantRows,
      geometry: {
        encoding: geometry.encoding,
        origin_lon: virtualGridCleanNumber(geometry.origin_lon),
        origin_lat: virtualGridCleanNumber(geometry.origin_lat),
        cell_width_degrees: Number(geometry.cell_width_degrees),
        cell_height_degrees: Number(geometry.cell_height_degrees),
      },
      resolutionKm: Number.isFinite(resolutionKm) ? resolutionKm : null,
      detail: status === "single"
        ? `${participantRows[0].label} 使用 ${participantRows[0].effective_resolution_km} km 格網`
        : `${participantRows.length} 個圖層使用精確共同格網`,
    };
  }

  unavailable(detail, participants = []) {
    return {
      strategy: "least_common_multiple",
      status: "unavailable",
      participants: participants.map((item) => ({
        dataset_id: item.datasetId,
        layer_id: item.layerId,
        label: item.label,
        requested_resolution_km: item.requestedResolutionKm,
        actual_resolution_km: item.actualResolutionKm,
        effective_resolution_km: item.effectiveResolutionKm,
      })),
      geometry: null,
      resolutionKm: null,
      detail,
    };
  }
}

const VirtualGridContract = (() => {
  const resolver = new ExactCommonGridResolver();

  function resolve({ zoom = map?.getZoom?.(), latitude = map?.getCenter?.().lat } = {}) {
    if (state.virtualGrid?.strategy !== "least_common_multiple") {
      return resolver.unavailable("所選策略尚未實作");
    }
    return resolver.resolve({
      layers: LayerRuntimeContractRegistry.sampledGridLayers({ enabledOnly: true }),
      zoom,
      latitude,
    });
  }

  function cellAt(latValue, lonValue, snapshot = state.virtualGrid) {
    const geometry = snapshot?.geometry;
    const lat = Number(latValue);
    const lon = Number(lonValue);
    if (!geometry || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const width = Number(geometry.cell_width_degrees);
    const height = Number(geometry.cell_height_degrees);
    const originLon = Number(geometry.origin_lon);
    const originLat = Number(geometry.origin_lat);
    if (![width, height, originLon, originLat].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const normalizedLon = normalizeLongitude(lon);
    const west = originLon + Math.floor(((normalizedLon - originLon) / width) + 1e-10) * width;
    const south = originLat + Math.floor(((lat - originLat) / height) + 1e-10) * height;
    const bounds = {
      west: virtualGridCleanNumber(west),
      south: virtualGridCleanNumber(south),
      east: virtualGridCleanNumber(west + width),
      north: virtualGridCleanNumber(south + height),
    };
    return {
      bounds,
      center: {
        lat: virtualGridCleanNumber((bounds.south + bounds.north) / 2),
        lon: virtualGridCleanNumber(normalizeLongitude((bounds.west + bounds.east) / 2)),
      },
      resolution_km: snapshot.resolutionKm,
      grid_contract: {
        strategy: snapshot.strategy,
        revision: snapshot.revision,
        participants: (snapshot.participants || []).map((item) => ({ ...item })),
        geometry: { ...geometry },
      },
    };
  }

  return Object.freeze({ ExactCommonGridResolver, resolve, cellAt });
})();

function virtualGridSignature(snapshot) {
    return JSON.stringify({
      strategy: snapshot.strategy,
      status: snapshot.status,
      participants: snapshot.participants,
      geometry: snapshot.geometry,
    });
  }

class VirtualGridRuntimeController {
  constructor({ targetState, contract, eventTarget, targetMap = null } = {}) {
    if (!targetState || !contract || !eventTarget?.dispatchEvent) {
      throw new TypeError("VirtualGridController requires state, contract and event target");
    }
    this.state = targetState;
    this.contract = contract;
    this.eventTarget = eventTarget;
    this.map = targetMap;
    this.bound = false;
    this.boundDatasetsLoaded = () => this.refresh("datasets_loaded");
    this.boundResolutionChanged = () => this.refresh("resolution_changed");
    this.boundMapChanged = () => this.refresh("map_lod_changed");
  }

  refresh(reason = "refresh") {
    const next = this.contract.resolve();
    const nextSignature = virtualGridSignature(next);
    const changed = nextSignature !== this.state.virtualGrid.signature;
    const revision = changed
      ? Number(this.state.virtualGrid.revision || 0) + 1
      : this.state.virtualGrid.revision;
    this.state.virtualGrid = { ...this.state.virtualGrid, ...next, signature: nextSignature, revision };
    if (changed) {
      this.eventTarget.dispatchEvent(new CustomEvent("rrkal:virtual-grid-changed", {
        detail: { reason, ...this.state.virtualGrid },
      }));
    }
    return this.state.virtualGrid;
  }

  setStrategy(strategy) {
    this.state.virtualGrid.strategy = strategy;
    return this.refresh("strategy_changed");
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.eventTarget.addEventListener?.("rrkal:datasets-loaded", this.boundDatasetsLoaded);
    this.eventTarget.addEventListener?.("rrkal:sampled-grid-resolution-changed", this.boundResolutionChanged);
    this.map?.on?.("zoomend moveend", this.boundMapChanged);
    this.refresh("initialized");
  }

  dispose() {
    if (!this.bound) return;
    this.bound = false;
    this.eventTarget.removeEventListener?.("rrkal:datasets-loaded", this.boundDatasetsLoaded);
    this.eventTarget.removeEventListener?.("rrkal:sampled-grid-resolution-changed", this.boundResolutionChanged);
    this.map?.off?.("zoomend moveend", this.boundMapChanged);
  }
}

window.LayerRuntimeContractRegistry = LayerRuntimeContractRegistry;
window.VirtualGridContract = VirtualGridContract;
window.VirtualGridRuntimeController = VirtualGridRuntimeController;
window.virtualGridSignature = virtualGridSignature;
