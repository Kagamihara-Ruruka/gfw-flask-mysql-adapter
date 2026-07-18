class AerialBackdrop {
  constructor({ root } = {}) {
    this.root = root;
    this.images = root ? Array.from(root.querySelectorAll("[data-aerial-backdrop-layer]")) : [];
    this.credit = root?.querySelector("[data-aerial-backdrop-credit]") || null;
    this.config = { enabled: false };
    this.activeIndex = -1;
    this.objectUrls = this.images.map(() => null);
    this.abortController = null;
    this.requestSequence = 0;
    this.currentKey = "";
    this.disposed = false;
    this.timers = new Set();
    this.animationFrames = new Set();
    this.paintResolvers = new Set();
    this.boundSelectionChange = (event) => this.handleSelectionChange(event);
    this.boundPageHide = (event) => {
      if (!event.persisted) this.dispose();
    };
    window.addEventListener("rrkal:tile-selection-changed", this.boundSelectionChange);
    window.addEventListener("pagehide", this.boundPageHide);
  }

  configure(config) {
    if (this.disposed) return;
    this.config = config && typeof config === "object" ? config : { enabled: false };
    if (!this.root) return;
    this.root.style.setProperty("--aerial-backdrop-image-opacity", String(this.config.background_opacity ?? 0));
    this.root.style.setProperty("--aerial-backdrop-scrim-opacity", String(this.config.scrim_opacity ?? 1));
    this.root.dataset.provider = this.config.provider || "";
    this.root.dataset.datePolicy = this.config.date_policy || "";
    if (this.credit) this.credit.textContent = this.config.attribution || "";
    if (!this.config.enabled) {
      this.reset("disabled");
      return;
    }
    this.syncFromState();
  }

  syncFromState() {
    const selected = typeof state !== "undefined" ? state.tileSelection?.selected : null;
    if (selected) {
      this.loadSelection(selected);
    }
  }

  handleSelectionChange(event) {
    if (!this.config.enabled) return;
    const selected = event?.detail?.selected || null;
    if (!selected) {
      this.reset(event?.detail?.reason || "cleared");
      return;
    }
    this.loadSelection(selected);
  }

  selectionRequest(selected) {
    const bbox = Array.isArray(selected?.bbox) ? selected.bbox.map(Number) : [];
    if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) return null;
    const bboxString = bbox.map((value) => value.toFixed(6)).join(",");
    const sourceDate = String(this.config.date_anchor || "").trim();
    const cacheRevision = String(this.config.cache_revision || "").trim();
    const key = `${bboxString}|${sourceDate}|${cacheRevision}`;
    const params = new URLSearchParams({ bbox: bboxString });
    if (cacheRevision) params.set("rev", cacheRevision);
    return {
      key,
      bboxString,
      sourceDate,
      url: `${this.config.route}?${params.toString()}`,
    };
  }

  async loadSelection(selected) {
    if (this.disposed || !this.root || this.images.length !== 2 || !this.config.route) return;
    const request = this.selectionRequest(selected);
    if (!request || (request.key === this.currentKey && this.root.dataset.state === "ready")) return;

    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const sequence = ++this.requestSequence;
    this.root.dataset.state = "loading";
    this.root.dataset.selectionKey = request.key;
    this.emit("loading", request);

    try {
      const response = await fetch(request.url, {
        signal: controller.signal,
        cache: "force-cache",
        headers: { Accept: "image/jpeg,image/png" },
      });
      if (!response.ok) {
        const packet = await response.json().catch(() => ({}));
        throw new Error(packet.error || `background request failed (${response.status})`);
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("background response is not an image");
      const objectUrl = URL.createObjectURL(blob);
      const nextIndex = this.activeIndex === 0 ? 1 : 0;
      const nextImage = this.images[nextIndex];
      const staleUrl = this.objectUrls[nextIndex];
      if (staleUrl) URL.revokeObjectURL(staleUrl);
      this.objectUrls[nextIndex] = objectUrl;
      nextImage.classList.remove("is-visible");
      nextImage.src = objectUrl;
      await nextImage.decode();

      if (sequence !== this.requestSequence) {
        URL.revokeObjectURL(objectUrl);
        if (this.objectUrls[nextIndex] === objectUrl) this.objectUrls[nextIndex] = null;
        return;
      }

      await this.waitForPaint();
      if (sequence !== this.requestSequence) return;

      const previousIndex = this.activeIndex;
      nextImage.classList.add("is-visible");
      if (previousIndex >= 0) this.images[previousIndex].classList.remove("is-visible");
      this.activeIndex = nextIndex;
      this.currentKey = request.key;
      this.root.dataset.state = "ready";
      this.root.dataset.layer = response.headers.get("X-RRKAL-Backdrop-Layer") || "";
      this.root.dataset.cache = response.headers.get("X-RRKAL-Backdrop-Cache") || "";
      this.root.dataset.sourceDate = response.headers.get("X-RRKAL-Backdrop-Date") || "";
      this.root.classList.add("is-ready");
      document.body.classList.add("has-aerial-backdrop");
      this.emit("ready", request);
      this.releaseInactiveLayer(previousIndex, sequence);
    } catch (error) {
      if (error?.name === "AbortError" || sequence !== this.requestSequence) return;
      this.root.dataset.state = "error";
      this.root.dataset.error = error?.message || "background unavailable";
      this.emit("error", request, this.root.dataset.error);
    }
  }

  waitForPaint() {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        this.paintResolvers.delete(finish);
        resolve();
      };
      this.paintResolvers.add(finish);
      const firstFrame = window.requestAnimationFrame(() => {
        this.animationFrames.delete(firstFrame);
        if (this.disposed) {
          finish();
          return;
        }
        const secondFrame = window.requestAnimationFrame(() => {
          this.animationFrames.delete(secondFrame);
          finish();
        });
        this.animationFrames.add(secondFrame);
      });
      this.animationFrames.add(firstFrame);
    });
  }

  schedule(callback, delay) {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  transitionDurationMs() {
    const value = getComputedStyle(this.root).getPropertyValue("--aerial-backdrop-transition").trim();
    if (value.endsWith("ms")) return Number.parseFloat(value) || 0;
    if (value.endsWith("s")) return (Number.parseFloat(value) || 0) * 1000;
    return 0;
  }

  releaseInactiveLayer(index, sequence) {
    if (index < 0) return;
    const delay = this.transitionDurationMs() + 50;
    this.schedule(() => {
      if (sequence !== this.requestSequence || index === this.activeIndex) return;
      const objectUrl = this.objectUrls[index];
      this.images[index].removeAttribute("src");
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      this.objectUrls[index] = null;
    }, delay);
  }

  reset(reason = "cleared") {
    if (!this.root) return;
    this.abortController?.abort();
    this.abortController = null;
    const sequence = ++this.requestSequence;
    this.currentKey = "";
    this.root.dataset.state = "idle";
    this.root.dataset.reason = reason;
    delete this.root.dataset.selectionKey;
    delete this.root.dataset.layer;
    delete this.root.dataset.cache;
    delete this.root.dataset.sourceDate;
    delete this.root.dataset.error;
    this.root.classList.remove("is-ready");
    document.body.classList.remove("has-aerial-backdrop");
    for (const image of this.images) image.classList.remove("is-visible");
    this.schedule(() => {
      if (sequence !== this.requestSequence || this.root.dataset.state !== "idle") return;
      this.images.forEach((image, index) => {
        image.removeAttribute("src");
        if (this.objectUrls[index]) URL.revokeObjectURL(this.objectUrls[index]);
        this.objectUrls[index] = null;
      });
      this.activeIndex = -1;
    }, this.transitionDurationMs() + 50);
    this.emit("idle", null, reason);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.requestSequence += 1;
    window.removeEventListener("rrkal:tile-selection-changed", this.boundSelectionChange);
    window.removeEventListener("pagehide", this.boundPageHide);
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const frame of this.animationFrames) window.cancelAnimationFrame(frame);
    this.animationFrames.clear();
    for (const resolve of this.paintResolvers) resolve();
    this.paintResolvers.clear();
    this.images.forEach((image, index) => {
      image.classList.remove("is-visible");
      image.removeAttribute("src");
      if (this.objectUrls[index]) URL.revokeObjectURL(this.objectUrls[index]);
      this.objectUrls[index] = null;
    });
    this.activeIndex = -1;
    this.currentKey = "";
    this.root?.classList.remove("is-ready");
    document.body.classList.remove("has-aerial-backdrop");
  }

  emit(status, request = null, detail = "") {
    window.dispatchEvent(new CustomEvent("rrkal:aerial-backdrop-changed", {
      detail: {
        status,
        selection_key: request?.key || "",
        bbox: request?.bboxString || "",
        date: request?.sourceDate || "",
        detail,
      },
    }));
  }
}

window.AerialBackdrop = AerialBackdrop;
window.aerialBackdropController = new AerialBackdrop({
  root: document.getElementById("aerial-backdrop"),
});
