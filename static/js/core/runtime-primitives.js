class AsyncEpoch {
  constructor({ abortControllerFactory = () => new AbortController() } = {}) {
    if (typeof abortControllerFactory !== "function") {
      throw new TypeError("AsyncEpoch requires an AbortController factory");
    }
    this.abortControllerFactory = abortControllerFactory;
    this.revision = 0;
    this.current = null;
    this.disposed = false;
  }

  begin(reason = "begin") {
    if (this.disposed) throw new Error("AsyncEpoch is disposed");
    this.invalidate("superseded");
    const controller = this.abortControllerFactory();
    const record = {
      id: ++this.revision,
      reason: String(reason || "begin"),
      controller,
    };
    this.current = record;
    return Object.freeze({
      id: record.id,
      reason: record.reason,
      signal: controller.signal,
    });
  }

  isCurrent(token) {
    return Boolean(!this.disposed && token && this.current?.id === token.id);
  }

  invalidate(reason = "invalidated") {
    const record = this.current;
    this.current = null;
    if (!record || record.controller.signal.aborted) return false;
    record.controller.abort(new Error(String(reason || "invalidated")));
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.invalidate("disposed");
    this.disposed = true;
  }
}

class BoundedLruMap {
  constructor({ maxEntries = 128, disposeValue = null } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 128));
    this.disposeValue = typeof disposeValue === "function" ? disposeValue : null;
    this.values = new Map();
  }

  get size() {
    return this.values.size;
  }

  has(key) {
    return this.values.has(key);
  }

  peek(key) {
    return this.values.get(key);
  }

  get(key) {
    if (!this.values.has(key)) return undefined;
    const value = this.values.get(key);
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.values.has(key)) {
      const previous = this.values.get(key);
      this.values.delete(key);
      if (previous !== value) this.disposeValue?.(previous, key);
    }
    this.values.set(key, value);
    while (this.values.size > this.maxEntries) {
      const oldestKey = this.values.keys().next().value;
      this.delete(oldestKey);
    }
    return this;
  }

  delete(key) {
    if (!this.values.has(key)) return false;
    const value = this.values.get(key);
    this.values.delete(key);
    this.disposeValue?.(value, key);
    return true;
  }

  clear() {
    for (const [key, value] of this.values) this.disposeValue?.(value, key);
    this.values.clear();
  }
}

Object.assign(globalThis, { AsyncEpoch, BoundedLruMap });
