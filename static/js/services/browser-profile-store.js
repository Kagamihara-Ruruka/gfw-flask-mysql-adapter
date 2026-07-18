const BROWSER_PROFILE_SCHEMA = "rrkal.browser_profile.v1";
const BROWSER_PROFILE_STORAGE_KEY = "rrkal.browser-profile.v1";

function browserProfileClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function browserProfileNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalizeBrowserProfile(value = {}) {
  const mapSettings = value.mapSettings && typeof value.mapSettings === "object"
    ? value.mapSettings
    : {};
  const layerAlpha = Object.fromEntries(
    Object.entries(value.layerAlpha || {})
      .filter(([key]) => Boolean(String(key).trim()))
      .map(([key, alpha]) => [key, browserProfileNumber(alpha, 1, 0, 1)]),
  );
  const paintProfiles = Object.fromEntries(
    Object.entries(value.sampledGridPaintProfiles || {}).map(([key, profile]) => [key, {
      layerId: String(profile?.layerId || key),
      datasetId: String(profile?.datasetId || ""),
      mode: profile?.mode === "nonzero_extent" ? "nonzero_extent" : "contract",
      colorStops: Array.isArray(profile?.colorStops)
        ? profile.colorStops.map((stop) => ({
          position: browserProfileNumber(stop?.position, 0, 0, 1),
          color: String(stop?.color || "#2d8296"),
        }))
        : [],
      maxValue: Number.isFinite(Number(profile?.maxValue)) ? Number(profile.maxValue) : null,
    }]),
  );
  return {
    schema: BROWSER_PROFILE_SCHEMA,
    mapSettings: {
      basemapId: String(mapSettings.basemapId || "carto_light"),
      scaleVisible: mapSettings.scaleVisible !== false,
      zoomControlVisible: mapSettings.zoomControlVisible !== false,
      scrollWheelZoom: mapSettings.scrollWheelZoom !== false,
      doubleClickZoom: mapSettings.doubleClickZoom !== false,
      dragging: mapSettings.dragging !== false,
      keyboard: mapSettings.keyboard !== false,
      vignetteVisible: Boolean(mapSettings.vignetteVisible),
      vignetteInsetPct: browserProfileNumber(mapSettings.vignetteInsetPct, 1, 0, 5),
      vignetteStrength: browserProfileNumber(mapSettings.vignetteStrength, 55, 0, 100),
      graticuleVisible: Boolean(mapSettings.graticuleVisible),
      graticuleLabels: mapSettings.graticuleLabels !== false,
      graticuleAlpha: browserProfileNumber(mapSettings.graticuleAlpha, 0.45, 0, 1),
      graticuleColor: String(mapSettings.graticuleColor || "#e2ecf6"),
      graticuleLineStyle: ["solid", "dashed", "dotted"].includes(mapSettings.graticuleLineStyle)
        ? mapSettings.graticuleLineStyle
        : "dashed",
      graticuleLineWidth: browserProfileNumber(mapSettings.graticuleLineWidth, 1, 0.5, 4),
    },
    layerAlpha,
    eezPaint: browserProfileClone(value.eezPaint || {}),
    sampledGridPaintProfiles: paintProfiles,
    hardwareMode: ["auto", "webgl", "off"].includes(value.hardwareMode) ? value.hardwareMode : "auto",
    aisRenderStrategy: value.aisRenderStrategy === "point_dots" ? "point_dots" : "density_grid",
  };
}

function readBrowserProfile(storage, key = BROWSER_PROFILE_STORAGE_KEY) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== BROWSER_PROFILE_SCHEMA) return null;
    return normalizeBrowserProfile(parsed);
  } catch (_error) {
    return null;
  }
}

function browserProfileStorage(globalTarget) {
  try {
    return globalTarget?.localStorage || null;
  } catch (_error) {
    return null;
  }
}

function hydrateBrowserProfileState(targetState, profile) {
  if (!targetState || !profile) return targetState;
  targetState.mapSettings = { ...(targetState.mapSettings || {}), ...profile.mapSettings };
  targetState.layerAlpha = { ...(targetState.layerAlpha || {}), ...profile.layerAlpha };
  targetState.eezPaint = {
    ...(targetState.eezPaint || {}),
    ...(profile.eezPaint || {}),
    polTypeColors: {
      ...(targetState.eezPaint?.polTypeColors || {}),
      ...(profile.eezPaint?.polTypeColors || {}),
    },
  };
  targetState.sampledGridPaintProfiles = {
    ...(targetState.sampledGridPaintProfiles || {}),
    ...(profile.sampledGridPaintProfiles || {}),
  };
  targetState.browserProfile = {
    ...(targetState.browserProfile || {}),
    hardwareMode: profile.hardwareMode,
    aisRenderStrategy: profile.aisRenderStrategy,
    scope: "browser_profile",
    persistence: "local_storage",
  };
  return targetState;
}

class BrowserProfileStoreCore {
  constructor({ targetState, storage, eventTarget, key = BROWSER_PROFILE_STORAGE_KEY } = {}) {
    if (!targetState || !eventTarget?.addEventListener) {
      throw new TypeError("BrowserProfileStoreCore requires state and an event target");
    }
    this.targetState = targetState;
    this.storage = storage;
    this.eventTarget = eventTarget;
    this.key = key;
    this.boundChange = () => this.persist();
    this.mounted = false;
    this.lastError = storage?.setItem
      ? null
      : new Error("browser profile storage unavailable");
  }

  mount() {
    if (this.mounted) return this;
    this.mounted = true;
    this.eventTarget.addEventListener("rrkal:browser-profile-changed", this.boundChange);
    return this;
  }

  capture() {
    return normalizeBrowserProfile({
      mapSettings: this.targetState.mapSettings,
      layerAlpha: this.targetState.layerAlpha,
      eezPaint: this.targetState.eezPaint,
      sampledGridPaintProfiles: this.targetState.sampledGridPaintProfiles,
      hardwareMode: this.targetState.browserProfile?.hardwareMode,
      aisRenderStrategy: this.targetState.browserProfile?.aisRenderStrategy,
    });
  }

  persist() {
    const profile = this.capture();
    if (!this.storage?.setItem) {
      this.lastError = new Error("browser profile storage unavailable");
      return false;
    }
    try {
      this.storage.setItem(this.key, JSON.stringify(profile));
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  snapshot() {
    return Object.freeze({
      schema: BROWSER_PROFILE_SCHEMA,
      scope: "browser_profile",
      persistence: this.lastError ? "session_fallback" : "local_storage",
      owner: "BrowserProfileStore",
      lastError: this.lastError?.message || "",
    });
  }

  dispose() {
    if (!this.mounted) return;
    this.mounted = false;
    this.eventTarget.removeEventListener("rrkal:browser-profile-changed", this.boundChange);
  }
}

function notifyBrowserProfileChanged(reason = "visual_preference_changed") {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("rrkal:browser-profile-changed", { detail: { reason } }));
}

if (typeof window !== "undefined" && typeof state !== "undefined") {
  const bootstrapProfile = readBrowserProfile(browserProfileStorage(window));
  hydrateBrowserProfileState(state, bootstrapProfile);
}

globalThis.BrowserProfileStoreCore = BrowserProfileStoreCore;
globalThis.BrowserProfileContract = Object.freeze({
  schema: BROWSER_PROFILE_SCHEMA,
  storageKey: BROWSER_PROFILE_STORAGE_KEY,
  normalize: normalizeBrowserProfile,
  read: readBrowserProfile,
  storage: browserProfileStorage,
  hydrate: hydrateBrowserProfileState,
});
globalThis.notifyBrowserProfileChanged = notifyBrowserProfileChanged;
