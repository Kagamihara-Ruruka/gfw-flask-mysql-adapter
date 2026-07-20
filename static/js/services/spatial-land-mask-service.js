class SpatialLandMaskServiceCore {
  constructor({
    targetMap,
    targetState,
    capabilityProvider,
    eventTarget,
    renderClock,
    timeoutClock,
    canvasFactory,
    imageLoader,
    tileSize = 256,
    imageTimeoutMs = 10000,
    imageCacheMaxEntries = 96,
    tileRequestConcurrency = 2,
    abortControllerFactory = () => new AbortController(),
  } = {}) {
    if (
      !targetMap
      || !targetState
      || typeof capabilityProvider !== "function"
      || !eventTarget
      || !renderClock
      || !timeoutClock
      || typeof timeoutClock.schedule !== "function"
      || typeof timeoutClock.cancel !== "function"
      || typeof canvasFactory !== "function"
      || typeof imageLoader !== "function"
    ) {
      throw new TypeError("SpatialLandMaskService requires map, state, capabilities, events, clock and browser factories");
    }
    this.map = targetMap;
    this.state = targetState;
    this.capability = capabilityProvider;
    this.eventTarget = eventTarget;
    this.renderClock = renderClock;
    this.timeoutClock = timeoutClock;
    this.canvasFactory = canvasFactory;
    this.imageLoader = imageLoader;
    this.tileSize = Math.max(16, Number(tileSize) || 256);
    this.imageTimeoutMs = Math.max(250, Number(imageTimeoutMs) || 10000);
    this.tileRequestConcurrency = Math.max(1, Math.floor(Number(tileRequestConcurrency) || 2));
    this.activeTileLoads = 0;
    this.tileLoadQueue = [];
    this.abortControllerFactory = abortControllerFactory;
    this.canvas = null;
    this.context = null;
    this.refreshEpoch = new AsyncEpoch({ abortControllerFactory });
    this.imageCache = new BoundedLruMap({
      maxEntries: imageCacheMaxEntries,
      disposeValue: (entry) => entry?.controller?.abort?.(new Error("land-mask image evicted")),
    });
    this.listeners = new Set();
    this.revision = 0;
    this.generation = 0;
    this.scheduledFrame = null;
    this.status = "IDLE";
    this.scopeSignature = "";
    this.validityMask = null;
    this.boundViewportChange = () => this.schedule("viewport_changed");
    this.boundLayerChange = () => this.schedule("layer_changed");
    this.boundDatasetsLoaded = () => this.schedule("datasets_loaded");
    this.bound = false;
  }

  bind() {
    if (this.bound) return this;
    this.bound = true;
    this.map.on("moveend zoomend resize", this.boundViewportChange, this);
    this.eventTarget.addEventListener("rrkal:layer-activation-changed", this.boundLayerChange);
    this.eventTarget.addEventListener("rrkal:datasets-loaded", this.boundDatasetsLoaded);
    this.schedule("bind");
    return this;
  }

  providerFor(layerId = this.state.dataLayer) {
    const consumer = this.capability(layerId, "land_mask_consumer") || {};
    if (consumer.status !== "supported") return null;
    const providerLayerId = String(consumer.provider_layer_id || "").trim().toLowerCase();
    const providerCapability = String(consumer.provider_capability || "").trim();
    if (!providerLayerId || !providerCapability) return null;
    const provider = this.capability(providerLayerId, providerCapability) || {};
    if (provider.status !== "supported" || !provider.tile_template) return null;
    return { consumer, provider, providerLayerId };
  }

  snapshot(layerId = this.state.dataLayer) {
    const resolved = this.providerFor(layerId);
    const validityMask = resolved && this.status === "READY" ? this.validityMask : null;
    return Object.freeze({
      schema: "rrkal.spatial_validity_mask.v1",
      enabled: Boolean(resolved),
      ready: Boolean(validityMask && this.scopeSignature),
      status: resolved ? this.status : "DISABLED",
      revision: this.revision,
      scopeSignature: this.scopeSignature,
      maskId: validityMask?.maskId || "",
      maskVersion: validityMask?.maskVersion || "",
      gridSignature: validityMask?.gridSignature || "",
      bbox: validityMask?.bbox || null,
      worldToMaskTransform: validityMask?.worldToMaskTransform || null,
      canvas: validityMask?.canvas || null,
      sampleLand: validityMask?.sampleLand || null,
      sampleOcean: validityMask?.sampleOcean || null,
      sampleSegmentLand: validityMask?.sampleSegmentLand || null,
      sourceVersion: resolved?.provider?.source_version || "",
      capabilityVersion: resolved?.provider?.capability_version || "",
    });
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(reason) {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    const { canvas, sampleLand, sampleOcean, sampleSegmentLand, ...detail } = snapshot;
    this.eventTarget.dispatchEvent(new CustomEvent("rrkal:spatial-land-mask-changed", {
      detail: { ...detail, reason },
    }));
  }

  schedule(reason = "refresh") {
    this.pendingReason = reason;
    if (this.scheduledFrame !== null) return;
    this.scheduledFrame = this.renderClock.request(() => {
      this.scheduledFrame = null;
      const nextReason = this.pendingReason || reason;
      this.pendingReason = null;
      this.refresh(nextReason).catch((error) => {
        if (error?.name !== "AbortError") console.warn("Spatial land mask refresh failed", error);
      });
    });
  }

  tileCoordinates(zoom, pixelBounds) {
    const scale = 2 ** zoom;
    const minimum = pixelBounds.min.divideBy(this.tileSize).floor();
    const maximum = {
      x: Math.floor(Math.max(pixelBounds.min.x, pixelBounds.max.x - 1e-7) / this.tileSize),
      y: Math.floor(Math.max(pixelBounds.min.y, pixelBounds.max.y - 1e-7) / this.tileSize),
    };
    const coordinates = [];
    for (let y = minimum.y; y <= maximum.y; y += 1) {
      if (y < 0 || y >= scale) continue;
      for (let x = minimum.x; x <= maximum.x; x += 1) {
        const wrappedX = ((x % scale) + scale) % scale;
        coordinates.push({ x, y, wrappedX, zoom });
      }
    }
    return coordinates;
  }

  tileUrl(template, coordinate, sourceVersion, capabilityVersion) {
    const path = String(template)
      .replace("{z}", String(coordinate.zoom))
      .replace("{x}", String(coordinate.wrappedX))
      .replace("{y}", String(coordinate.y));
    const separator = path.includes("?") ? "&" : "?";
    const version = [sourceVersion || "unknown", capabilityVersion || "unknown"].join(":");
    return `${path}${separator}v=${encodeURIComponent(version)}`;
  }

  loadImage(url) {
    let entry = this.imageCache.get(url);
    if (entry?.status === "ready") return Promise.resolve(entry.image);
    if (entry?.status === "pending" && !entry.controller.signal.aborted) {
      return entry.promise;
    }
    if (entry) this.imageCache.delete(url);

    const controller = this.abortControllerFactory();
    const timeout = this.timeoutClock.schedule(() => {
      const error = new Error(`land-mask image timed out after ${this.imageTimeoutMs} ms: ${url}`);
      error.name = "TimeoutError";
      controller.abort(error);
    }, this.imageTimeoutMs);
    const aborted = new Promise((resolve, reject) => {
      const rejectAbort = () => {
        const error = controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("land-mask image aborted");
        if (error.name !== "TimeoutError") error.name = "AbortError";
        reject(error);
      };
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    entry = { status: "pending", controller, image: null, promise: null };
    entry.promise = Promise.race([
      Promise.resolve().then(() => this.imageLoader(url, { signal: controller.signal })),
      aborted,
    ]).then((image) => {
      if (this.imageCache.peek(url) === entry) {
        entry.status = "ready";
        entry.image = image;
        entry.controller = null;
      }
      return image;
    }).catch((error) => {
      if (this.imageCache.peek(url) === entry) this.imageCache.delete(url);
      throw error;
    }).finally(() => {
      this.timeoutClock.cancel(timeout);
    });
    this.imageCache.set(url, entry);
    return entry.promise;
  }

  abortError(message = "land-mask tile load superseded") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }

  pruneTileLoadQueue() {
    const retained = [];
    for (const task of this.tileLoadQueue) {
      if (task.isCurrent()) retained.push(task);
      else task.reject(this.abortError());
    }
    this.tileLoadQueue = retained;
  }

  pumpTileLoadQueue() {
    while (this.activeTileLoads < this.tileRequestConcurrency && this.tileLoadQueue.length) {
      const task = this.tileLoadQueue.shift();
      if (!task.isCurrent()) {
        task.reject(this.abortError());
        continue;
      }
      this.activeTileLoads += 1;
      Promise.resolve()
        .then(() => this.loadImage(task.url))
        .then(task.resolve, task.reject)
        .finally(() => {
          this.activeTileLoads = Math.max(0, this.activeTileLoads - 1);
          this.pumpTileLoadQueue();
        });
    }
  }

  queueTileImage(url, isCurrent) {
    const cached = this.imageCache.peek(url);
    if (cached?.status === "ready" || cached?.status === "pending") {
      return this.loadImage(url);
    }
    return new Promise((resolve, reject) => {
      this.tileLoadQueue.push({ url, isCurrent, resolve, reject });
      this.pumpTileLoadQueue();
    });
  }

  captureValidityMask({ resolved, zoom, pixelBounds, size, scopeSignature, canvas, context, revision }) {
    if (typeof context?.getImageData !== "function" || typeof this.map.project !== "function") {
      return Object.freeze({
        maskId: resolved.providerLayerId,
        maskVersion: [resolved.provider.source_version, resolved.provider.capability_version].join(":"),
        gridSignature: `${zoom}:${this.tileSize}`,
        bbox: null,
        worldToMaskTransform: null,
        canvas,
        revision,
        sampleLand: null,
        sampleOcean: null,
        sampleSegmentLand: null,
      });
    }
    let pixels;
    try {
      pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (error) {
      console.warn("Spatial validity mask pixels are unavailable", error);
      return null;
    }
    const worldSize = this.tileSize * (2 ** zoom);
    const originX = Number(pixelBounds.min.x);
    const originY = Number(pixelBounds.min.y);
    const width = canvas.width;
    const height = canvas.height;
    const centerX = originX + width / 2;
    const transform = Object.freeze({ zoom, originX, originY, width, height, worldSize });
    const mapBounds = this.map.getBounds?.();
    const bbox = mapBounds ? Object.freeze({
      west: Number(mapBounds.getWest?.()),
      south: Number(mapBounds.getSouth?.()),
      east: Number(mapBounds.getEast?.()),
      north: Number(mapBounds.getNorth?.()),
    }) : null;
    const projectToMask = (longitude, latitude) => {
      const projected = this.map.project([Number(latitude), Number(longitude)], zoom);
      if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
      const wrappedX = projected.x + Math.round((centerX - projected.x) / worldSize) * worldSize;
      const x = Math.floor(wrappedX - originX);
      const y = Math.floor(projected.y - originY);
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      return { x, y };
    };
    const sampleMaskPixel = (x, y) => pixels[(Math.floor(y) * width + Math.floor(x)) * 4] > 127;
    const sampleLand = (longitude, latitude) => {
      const point = projectToMask(longitude, latitude);
      return point ? sampleMaskPixel(point.x, point.y) : null;
    };
    const sampleSegmentLand = (startLongitude, startLatitude, endLongitude, endLatitude) => {
      const start = projectToMask(startLongitude, startLatitude);
      const end = projectToMask(endLongitude, endLatitude);
      if (!start || !end) return null;
      const steps = Math.max(1, Math.min(4096, Math.ceil(
        Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) * 2,
      )));
      for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps;
        const x = start.x + (end.x - start.x) * ratio;
        const y = start.y + (end.y - start.y) * ratio;
        if (sampleMaskPixel(x, y)) return true;
      }
      return false;
    };
    return Object.freeze({
      maskId: resolved.providerLayerId,
      maskVersion: [resolved.provider.source_version, resolved.provider.capability_version].join(":"),
      gridSignature: `${scopeSignature}:${zoom}:${this.tileSize}`,
      bbox,
      worldToMaskTransform: transform,
      canvas,
      revision,
      sampleLand,
      sampleSegmentLand,
      sampleOcean: (longitude, latitude) => {
        const land = sampleLand(longitude, latitude);
        return land === null ? null : !land;
      },
    });
  }

  async refresh(reason = "refresh") {
    const epoch = this.refreshEpoch.begin(reason);
    this.pruneTileLoadQueue();
    const resolved = this.providerFor();
    const generation = ++this.generation;
    if (!resolved) {
      this.status = "DISABLED";
      this.scopeSignature = "";
      this.validityMask = null;
      this.notify(reason);
      return;
    }
    this.tileRequestConcurrency = Math.max(
      1,
      Math.floor(Number(resolved.provider.tile_request_concurrency) || this.tileRequestConcurrency),
    );
    this.pumpTileLoadQueue();
    const size = this.map.getSize();
    const zoom = Math.max(0, Math.floor(Number(this.map.getZoom()) || 0));
    const pixelBounds = this.map.getPixelBounds();
    const coordinates = this.tileCoordinates(zoom, pixelBounds);
    const signature = [
      resolved.provider.source_version || "unknown",
      resolved.provider.capability_version || "unknown",
      zoom,
      pixelBounds.min.x,
      pixelBounds.min.y,
      size.x,
      size.y,
    ].join(":");
    if (this.status === "READY" && this.scopeSignature === signature) return;
    this.status = "FETCHING";
    this.scopeSignature = "";
    this.validityMask = null;
    let tiles;
    try {
      tiles = await Promise.all(coordinates.map(async (coordinate) => ({
        coordinate,
        image: await this.queueTileImage(this.tileUrl(
          resolved.provider.tile_template,
          coordinate,
          resolved.provider.source_version,
          resolved.provider.capability_version,
        ), () => this.refreshEpoch.isCurrent(epoch)),
      })));
    } catch (error) {
      if (!this.refreshEpoch.isCurrent(epoch)) return;
      this.status = "FAILED";
      this.scopeSignature = "";
      this.validityMask = null;
      this.notify("refresh_failed");
      throw error;
    }
    if (generation !== this.generation || !this.refreshEpoch.isCurrent(epoch)) return;
    const canvas = this.canvasFactory();
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("land-mask canvas context is unavailable");
    canvas.width = Math.max(1, Number(size.x) || 1);
    canvas.height = Math.max(1, Number(size.y) || 1);
    // Resizing a canvas resets the complete 2D context state, including this flag.
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const { coordinate, image } of tiles) {
      const left = Math.round(coordinate.x * this.tileSize - pixelBounds.min.x);
      const top = Math.round(coordinate.y * this.tileSize - pixelBounds.min.y);
      const sourceWidth = Number(image?.naturalWidth || image?.width || this.tileSize);
      const sourceHeight = Number(image?.naturalHeight || image?.height || this.tileSize);
      const bleedX = Math.max(0, (sourceWidth - this.tileSize) / 2);
      const bleedY = Math.max(0, (sourceHeight - this.tileSize) / 2);
      if (bleedX > 0 || bleedY > 0) {
        context.drawImage(
          image,
          bleedX,
          bleedY,
          sourceWidth - (bleedX * 2),
          sourceHeight - (bleedY * 2),
          left,
          top,
          this.tileSize,
          this.tileSize,
        );
      } else {
        context.drawImage(image, left, top, this.tileSize, this.tileSize);
      }
    }
    this.revision += 1;
    const validityMask = this.captureValidityMask({
      resolved,
      zoom,
      pixelBounds,
      size,
      scopeSignature: signature,
      canvas,
      context,
      revision: this.revision,
    });
    this.canvas = validityMask ? canvas : null;
    this.context = validityMask ? context : null;
    this.validityMask = validityMask;
    this.status = this.validityMask ? "READY" : "FAILED";
    this.scopeSignature = this.validityMask ? signature : "";
    this.notify(reason);
  }

  dispose() {
    this.generation += 1;
    this.refreshEpoch.dispose();
    if (this.scheduledFrame !== null) {
      this.renderClock.cancel(this.scheduledFrame);
      this.scheduledFrame = null;
    }
    if (this.bound) {
      this.map.off("moveend zoomend resize", this.boundViewportChange, this);
      this.eventTarget.removeEventListener("rrkal:layer-activation-changed", this.boundLayerChange);
      this.eventTarget.removeEventListener("rrkal:datasets-loaded", this.boundDatasetsLoaded);
      this.bound = false;
    }
    this.listeners.clear();
    for (const task of this.tileLoadQueue.splice(0)) {
      task.reject(this.abortError("land-mask service disposed"));
    }
    this.imageCache.clear();
    this.status = "DISPOSED";
    this.scopeSignature = "";
    this.validityMask = null;
    this.canvas = null;
    this.context = null;
  }
}

globalThis.SpatialLandMaskServiceCore = SpatialLandMaskServiceCore;
