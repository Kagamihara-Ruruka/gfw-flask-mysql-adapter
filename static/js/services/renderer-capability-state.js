class RendererCapabilityStateCore {
  constructor({ targetState, eventTarget, clock } = {}) {
    if (!targetState || !eventTarget || !clock || typeof clock.now !== "function") {
      throw new TypeError("RendererCapabilityState requires state, events and a monotonic clock");
    }
    this.state = targetState;
    this.eventTarget = eventTarget;
    this.clock = clock;
    this.server = Object.freeze({ status: "pending", policy: Object.freeze({}) });
    this.browser = Object.freeze({
      webgl: Object.freeze({ available: false, context: null, vendor: "", renderer: "" }),
      webgpu: Object.freeze({ available: false }),
    });
    this.policy = {};
    this.contexts = new Map();
    this.listeners = new Set();
    this.loadedMonotonicMs = 0;
    this.boundContextChanged = (event) => this.handleContextChanged(event?.detail || {});
    this.mounted = false;
    this.sync("created");
  }

  mount() {
    if (this.mounted) return this;
    this.mounted = true;
    this.eventTarget.addEventListener("rrkal:sampled-grid-webgl-context-changed", this.boundContextChanged);
    return this;
  }

  install({ server, browser } = {}) {
    const installedServer = server && typeof server === "object" ? server : {};
    const installedBrowser = browser && typeof browser === "object" ? browser : {};
    this.server = Object.freeze({
      ...installedServer,
      policy: Object.freeze({ ...(installedServer.policy || {}) }),
    });
    this.browser = Object.freeze({
      ...installedBrowser,
      webgl: Object.freeze({ ...(installedBrowser.webgl || { available: false }) }),
      webgpu: Object.freeze({ ...(installedBrowser.webgpu || { available: false }) }),
    });
    this.policy = { ...(installedServer.policy || {}) };
    this.loadedMonotonicMs = this.clock.now();
    return this.sync("probe_installed");
  }

  setHardwareMode(mode) {
    const normalized = ["auto", "webgl", "off"].includes(mode) ? mode : "auto";
    if (normalized === "off") {
      this.policy = { ...this.policy, hardware_acceleration: "off", force_cpu: true, allow_webgl: false };
    } else if (normalized === "webgl") {
      this.policy = { ...this.policy, hardware_acceleration: "webgl", force_cpu: false, allow_webgl: true };
    } else {
      this.policy = { ...this.policy, hardware_acceleration: "auto", force_cpu: false, allow_webgl: true };
    }
    return this.sync("hardware_mode_changed");
  }

  handleContextChanged(detail = {}) {
    const rendererId = String(detail.rendererId || "").trim();
    const status = String(detail.status || "").trim().toLowerCase();
    if (!rendererId || !["lost", "restored", "disposed"].includes(status)) return this.snapshot();
    if (status === "disposed") {
      this.contexts.delete(rendererId);
    } else {
      this.contexts.set(rendererId, Object.freeze({
        rendererId,
        layerId: String(detail.layerId || ""),
        active: Boolean(detail.active),
        status,
        monotonicMs: this.clock.now(),
      }));
    }
    return this.sync(`context_${status}`, detail);
  }

  runtimeWebgl() {
    const contexts = [...this.contexts.values()];
    const lost = contexts.filter((context) => context.status === "lost");
    const available = Boolean(this.browser.webgl?.available);
    return Object.freeze({
      status: !available ? "unavailable" : lost.length ? "lost" : "available",
      available: available && lost.length === 0,
      contextCount: contexts.length,
      lostContextCount: lost.length,
      contexts: Object.freeze(contexts.map((context) => Object.freeze({ ...context }))),
    });
  }

  snapshot() {
    return this.currentSnapshot;
  }

  subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    if (emitCurrent) listener(this.snapshot(), { reason: "snapshot" });
    return () => this.listeners.delete(listener);
  }

  sync(reason, detail = {}) {
    this.currentSnapshot = Object.freeze({
      server: this.server,
      policy: Object.freeze({ ...this.policy }),
      browser: this.browser,
      runtime: Object.freeze({ webgl: this.runtimeWebgl() }),
      loadedMonotonicMs: this.loadedMonotonicMs,
    });
    this.state.renderCapability = this.currentSnapshot;
    for (const listener of this.listeners) listener(this.currentSnapshot, { reason, detail });
    this.eventTarget.dispatchEvent(new CustomEvent("rrkal:renderer-capability-state-changed", {
      detail: { reason, runtime: this.currentSnapshot.runtime },
    }));
    return this.currentSnapshot;
  }

  dispose() {
    if (this.mounted) {
      this.eventTarget.removeEventListener("rrkal:sampled-grid-webgl-context-changed", this.boundContextChanged);
      this.mounted = false;
    }
    this.listeners.clear();
    this.contexts.clear();
  }
}

globalThis.RendererCapabilityStateCore = RendererCapabilityStateCore;
