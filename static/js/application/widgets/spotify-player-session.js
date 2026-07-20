(() => {
class SpotifyPlayerSession {
  constructor() {
    this.catalog = new Map();
    this.order = [];
    this.activeItemId = "";
    this.listeners = new Set();
    this.configured = false;
  }

  configure(items, { order = [], activeItemId = "" } = {}) {
    if (this.configured) return this.snapshot();
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item?.id || "").trim();
      if (!id || this.catalog.has(id)) continue;
      this.catalog.set(id, item);
    }
    const pending = new Set(this.catalog.keys());
    this.order = [];
    for (const id of Array.isArray(order) ? order : []) {
      const normalized = String(id || "").trim();
      if (!pending.delete(normalized)) continue;
      this.order.push(normalized);
    }
    this.order.push(...pending);
    const requested = String(activeItemId || "").trim();
    this.activeItemId = this.catalog.has(requested) ? requested : (this.order[0] || "");
    this.configured = true;
    this.notify("configured");
    return this.snapshot();
  }

  items() {
    return this.order.map((id) => this.catalog.get(id)).filter(Boolean);
  }

  activeItem() {
    return this.catalog.get(this.activeItemId) || this.items()[0] || null;
  }

  select(itemId) {
    const normalized = String(itemId || "").trim();
    if (!this.catalog.has(normalized) || normalized === this.activeItemId) return false;
    this.activeItemId = normalized;
    this.notify("selection_changed");
    return true;
  }

  move(itemId, targetId, { after = false } = {}) {
    const source = String(itemId || "").trim();
    const target = String(targetId || "").trim();
    if (!source || !target || source === target || !this.catalog.has(source) || !this.catalog.has(target)) {
      return false;
    }
    const next = this.order.filter((id) => id !== source);
    const targetIndex = next.indexOf(target);
    if (targetIndex < 0) return false;
    next.splice(targetIndex + (after ? 1 : 0), 0, source);
    this.order = next;
    this.notify("order_changed");
    return true;
  }

  snapshot(reason = "snapshot") {
    return Object.freeze({
      reason,
      activeItemId: this.activeItemId,
      items: Object.freeze(this.items()),
      order: Object.freeze([...this.order]),
    });
  }

  subscribe(listener, { emitCurrent = true } = {}) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    if (emitCurrent) listener(this.snapshot("subscribed"));
    return () => this.listeners.delete(listener);
  }

  notify(reason) {
    const snapshot = this.snapshot(reason);
    for (const listener of [...this.listeners]) listener(snapshot);
  }

  dispose() {
    this.listeners.clear();
    this.catalog.clear();
    this.order = [];
    this.activeItemId = "";
    this.configured = false;
  }
}

globalThis.SpotifyPlayerSessionCore = SpotifyPlayerSession;
})();
