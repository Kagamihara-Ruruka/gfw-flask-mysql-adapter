class ContinuousFieldServiceCore {
  constructor({ reconstruct, maxEntries = 4 } = {}) {
    if (typeof reconstruct !== "function") {
      throw new TypeError("ContinuousFieldService requires a reconstruction kernel");
    }
    this.reconstructKernel = reconstruct;
    this.frameIds = new WeakMap();
    this.nextFrameId = 0;
    this.cache = new BoundedLruMap({ maxEntries });
    this.disposed = false;
  }

  frameId(frame) {
    if (!frame || (typeof frame !== "object" && typeof frame !== "function")) {
      throw new TypeError("ContinuousFieldService requires a frame object");
    }
    let id = this.frameIds.get(frame);
    if (!id) {
      id = ++this.nextFrameId;
      this.frameIds.set(frame, id);
    }
    return id;
  }

  reconstruct(frame, renderContext, validityMask = null) {
    if (this.disposed) throw new Error("ContinuousFieldService is disposed");
    if (!renderContext?.continuousFieldSignature || !renderContext.paintFrame) {
      throw new TypeError("ContinuousFieldService requires an immutable RenderContext");
    }
    const maskIdentity = validityMask?.ready && validityMask.scopeSignature
      ? `${validityMask.maskVersion || "unknown"}|${validityMask.scopeSignature}|${validityMask.revision || 0}`
      : "unmasked";
    const key = `${this.frameId(frame)}|${renderContext.continuousFieldSignature}|${maskIdentity}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const field = this.reconstructKernel(frame, renderContext.paintFrame, validityMask);
    this.cache.set(key, field);
    return field;
  }

  snapshot() {
    return Object.freeze({ entries: this.cache.size, maxEntries: this.cache.maxEntries });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
  }
}

globalThis.ContinuousFieldServiceCore = ContinuousFieldServiceCore;
