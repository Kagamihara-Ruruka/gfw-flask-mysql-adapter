class RuntimeCompositionRoot {
  constructor({
    targetState,
    globalTarget,
    eventTarget,
    targetMap = null,
    frameIdentity,
    fetchJson: fetchJsonFn,
    sampledGridContract = null,
    clockDomain = null,
  } = {}) {
    if (!targetState || !globalTarget || !eventTarget || !frameIdentity || typeof fetchJsonFn !== "function") {
      throw new TypeError("RuntimeCompositionRoot requires state, globals, events, identity and fetchJson");
    }
    this.state = targetState;
    this.globalTarget = globalTarget;
    this.eventTarget = eventTarget;
    this.targetMap = targetMap;
    this.frameIdentity = frameIdentity;
    this.fetchJson = fetchJsonFn;
    this.sampledGridContract = sampledGridContract;
    this.clockDomain = clockDomain || createSystemClockDomain({ globalTarget });
    this.instances = new Map();
    this.exposedNames = new Map();
    this.disposalOrder = [];
    this.composed = false;
  }

  own(name, instance, { expose = true, exposeAs = name } = {}) {
    if (!name || !instance) throw new TypeError("Runtime owner requires a name and instance");
    if (this.instances.has(name)) throw new Error(`Runtime instance already exists: ${name}`);
    this.instances.set(name, instance);
    this.disposalOrder.push(instance);
    if (expose) {
      this.globalTarget[exposeAs] = instance;
      this.exposedNames.set(name, exposeAs);
    }
    return instance;
  }

  dataFrameStatsTarget() {
    this.state.dataFrameStore ||= { maxEntries: 0, maxBytes: 512 * 1024 * 1024, stats: {} };
    this.state.dataFrameStore.stats ||= {};
    return this.state.dataFrameStore.stats;
  }

  syncQueryScheduler(snapshot) {
    this.state.queryScheduler = {
      ...(this.state.queryScheduler || {}),
      ...snapshot,
    };
  }

  syncPreheater(snapshot) {
    this.state.playbackCache ||= {};
    Object.assign(this.state.playbackCache, {
      isBackgroundPreloading: snapshot.status === "FETCHING",
      preheaterStatus: snapshot.status,
      preheaterReadyAhead: Number(snapshot.readyAhead || 0),
      preheaterInflight: Number(snapshot.inflight || 0),
      effectiveLowWatermark: Number(snapshot.lowWatermark || 0),
      effectiveHighWatermark: Number(snapshot.highWatermark || 0),
      effectiveTargetWatermark: Number(snapshot.targetWatermark || 0),
      immediateReplenishment: Boolean(snapshot.immediateReplenishment),
      tailMode: Boolean(snapshot.tailMode),
      effectiveWatermarkStrategy: snapshot.strategy || "fixed",
    });
  }

  composeCore() {
    if (this.composed) return this;
    this.own("FrameIdentity", this.frameIdentity);
    const clockDomain = this.own("ClockDomain", this.clockDomain);
    if (typeof BrowserProfileStoreCore !== "undefined") {
      this.own("BrowserProfileStore", new BrowserProfileStoreCore({
        targetState: this.state,
        storage: BrowserProfileContract.storage(this.globalTarget),
        eventTarget: this.eventTarget,
      }).mount());
    }
    const eventLog = this.own("LifecycleEventLog", new LifecycleEventLogCore({
      maxEntriesProvider: () => this.state.lifecycleEvents?.maxEntries,
      eventTarget: this.eventTarget,
      clock: clockDomain.monotonic,
    }));
    const timingMetrics = this.own("TimingMetrics", new TimingMetricsService({
      monotonicClock: clockDomain.monotonic,
      renderClock: clockDomain.render,
      eventTarget: this.eventTarget,
      documentTarget: this.globalTarget.document,
    }));
    const RendererCapabilityStateClass = this.globalTarget.RendererCapabilityStateCore;
    if (typeof RendererCapabilityStateClass !== "function") {
      throw new Error("RendererCapabilityStateCore must be loaded before RuntimeCompositionRoot");
    }
    const rendererCapabilityState = this.own(
      "RendererCapabilityState",
      new RendererCapabilityStateClass({
        targetState: this.state,
        eventTarget: this.eventTarget,
        clock: clockDomain.monotonic,
      }).mount(),
    );
    if (typeof RenderStateController !== "undefined") {
      this.own("RenderState", new RenderStateController({
        elementById: (id) => document.getElementById(id),
        labelForLayer: (id) => (typeof layerLabel === "function" ? layerLabel(id) : id.toUpperCase()),
        primaryLayerPredicate: (id) => (
          id === "ais" || (typeof isSampledGridLayer === "function" && isSampledGridLayer(id))
        ),
      }));
    }
    if (typeof RenderArtifactCache !== "undefined" && typeof RendererRegistry !== "undefined") {
      this.own("SampledGridRenderArtifactCache", new RenderArtifactCache({
        targetState: this.state,
        rendererRegistry: RendererRegistry,
        clock: clockDomain.monotonic,
      }));
    }
    let spatialLandMaskService = null;
    if (this.targetMap && typeof SpatialLandMaskServiceCore !== "undefined") {
      spatialLandMaskService = this.own("SpatialLandMaskService", new SpatialLandMaskServiceCore({
        targetMap: this.targetMap,
        targetState: this.state,
        capabilityProvider: (layerId, capabilityName) => (
          this.globalTarget.LayerRuntimeContractRegistry?.capability?.(layerId, capabilityName) || null
        ),
        eventTarget: this.eventTarget,
        renderClock: clockDomain.render,
        timeoutClock: clockDomain.monotonic,
        canvasFactory: () => this.globalTarget.document.createElement("canvas"),
        imageLoader: (url, { signal } = {}) => new Promise((resolve, reject) => {
          const image = new this.globalTarget.Image();
          let settled = false;
          const cleanup = () => {
            image.onload = null;
            image.onerror = null;
            signal?.removeEventListener?.("abort", onAbort);
          };
          const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
          };
          const onAbort = () => {
            image.src = "";
            const error = signal?.reason instanceof Error ? signal.reason : new Error("land-mask image aborted");
            if (error.name !== "TimeoutError") error.name = "AbortError";
            settle(reject, error);
          };
          image.onload = () => settle(resolve, image);
          image.onerror = () => settle(reject, new Error(`land-mask tile failed: ${url}`));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener?.("abort", onAbort, { once: true });
          image.src = url;
        }),
      }).bind());
    }
    let continuousFieldService = null;
    if (
      typeof ContinuousFieldServiceCore !== "undefined"
      && typeof reconstructContinuousField === "function"
    ) {
      continuousFieldService = this.own(
        "ContinuousFieldService",
        new ContinuousFieldServiceCore({
          reconstruct: reconstructContinuousField,
          maxEntries: 4,
        }),
      );
    }
    let renderIntentService = null;
    let sampledGridLayerPool = null;
    const renderContextIdentityIsCurrent = (context) => {
      if (!context?.scopeKey || !renderIntentService) return false;
      const currentRequest = renderIntentService.toSampledGridPacketRequest(
        renderIntentService.snapshot({
          layerId: this.state.dataLayer,
          renderProfile: "dashboard.snapshot",
        }),
      );
      return !currentRequest.outsideCoverage
        && context.layerId === String(this.state.dataLayer || "").trim().toLowerCase()
        && context.datasetId === String(this.state.datasetId || "").trim()
        && context.date === currentRequest.date
        && context.scopeKey === this.frameIdentity.scopeKey(currentRequest);
    };
    const renderContextIsCurrent = (context) => {
      if (!renderContextIdentityIsCurrent(context)) return false;
      if (sampledGridLayerPool && !sampledGridLayerPool.isRenderEpochCurrent(context.renderEpoch)) return false;
      const currentMask = spatialLandMaskService?.snapshot?.(context.layerId);
      return sampledGridRenderContextMatchesMask(context, currentMask);
    };
    let sampledGridLayerTransitions = null;
    if (this.targetMap && typeof SampledGridLayerTransitionControllerCore !== "undefined") {
      sampledGridLayerTransitions = this.own(
        "SampledGridLayerTransitions",
        new SampledGridLayerTransitionControllerCore({
          targetMap: this.targetMap,
          targetState: this.state,
          renderClock: clockDomain.render,
        }),
      );
    }
    if (
      this.targetMap
      && typeof SampledGridLayerPoolCore !== "undefined"
      && typeof createSampledGridLayer === "function"
      && sampledGridLayerTransitions
    ) {
      sampledGridLayerPool = this.own("SampledGridLayerPool", new SampledGridLayerPoolCore({
        targetMap: this.targetMap,
        targetState: this.state,
        layerFactory: (LayerClass) => createSampledGridLayer(LayerClass, {
          continuousFieldProvider: continuousFieldService,
          renderContextValidator: renderContextIsCurrent,
        }),
        layerEffects: sampledGridLayerTransitions,
        landMaskProvider: spatialLandMaskService,
        rendererCapabilityState,
        renderClock: clockDomain.render,
        recoverActiveLayer: (layer) => {
          const context = layer?._renderContext;
          if (
            !context
            || context.layerId !== this.state.dataLayer
            || context.datasetId !== this.state.datasetId
            || !renderContextIdentityIsCurrent(context)
            || typeof renderSampledGridMap !== "function"
          ) return false;
          renderSampledGridMap(layer._frame, { requestContext: context.requestContext });
          return true;
        },
        commitPendingRender: (pending) => {
          if (
            !pending?.identity
            || !renderContextIdentityIsCurrent(pending.identity)
            || typeof renderSampledGridMap !== "function"
          ) return null;
          const currentMask = spatialLandMaskService?.snapshot?.(pending.identity.layerId);
          if (!currentMask?.ready) return null;
          const result = renderSampledGridMap(pending.frame, {
            requestContext: pending.requestContext,
          });
          if (result?.deferred) return null;
          this.globalTarget.RenderState?.ready?.(
            pending.identity.layerId,
            `${Number(result.rowCount || 0).toLocaleString()} rows · ${result.detail}`,
          );
          return result;
        },
        maxLayers: 2,
      }));
    }
    let queryPolicyController = null;
    const scheduler = this.own("QuerySchedulerInstance", new QueryScheduler({
      concurrencyProvider: () => queryPolicyController?.networkConcurrency() ?? 6,
      backgroundConcurrencyProvider: () => queryPolicyController?.backgroundConcurrency() ?? 3,
      eventLog,
      snapshotSink: (snapshot) => this.syncQueryScheduler(snapshot),
      clock: clockDomain.monotonic,
    }), { expose: false });
    const queryBroker = this.own("QueryBroker", new QueryBroker({
      fetchFn: this.globalTarget.fetch.bind(this.globalTarget),
      eventLog,
      clock: clockDomain.monotonic,
      priorityForLane: (lane) => scheduler.priorityFor(lane),
      batchSizeProvider: (sourceKey) => queryPolicyController?.effectiveBatchSize(sourceKey) ?? 1,
      sourceCapacityProvider: (sourceKey) => queryPolicyController?.sourceCapacity(sourceKey) ?? 1,
    }));
    queryPolicyController = this.own("QueryPolicyController", new QueryPolicyControllerCore({
      targetState: this.state,
      scheduler,
      broker: queryBroker,
    }));
    const queryCoordinator = this.own("LayerQueryCoordinator", createLayerQueryCoordinator({
      scheduler,
      fetchJson: this.fetchJson,
    }));
    const dataFrameStore = this.own("DataFrameStore", new DataFrameStoreCore({
      frameIdentity: this.frameIdentity,
      eventLog,
      optionsProvider: () => this.state.dataFrameStore || {},
      statsTargetProvider: () => this.dataFrameStatsTarget(),
      heapLimitProvider: () => Number(
        this.globalTarget.performance?.memory?.jsHeapSizeLimit || 0
      ),
      heapBudgetFraction: 0.35,
      retentionPartitionProvider: () => {
        const datasetId = String(this.state.datasetId || "");
        if (!datasetId) return {};
        return {
          datasetId,
          cacheNamespace: this.frameIdentity.normalizeRequest({ datasetId }).cacheNamespace,
        };
      },
      eventTarget: this.eventTarget,
      clock: clockDomain.monotonic,
    }));
    const frameDemandService = this.own("FrameDemandService", decorateFrameDemandService(
      new FrameDemandServiceCore({
        frameIdentity: this.frameIdentity,
        queryBroker,
        dataFrameStore,
        eventLog,
        sampledGridContract: this.sampledGridContract,
        clock: clockDomain.monotonic,
      }),
      { eventLog, clock: clockDomain.monotonic },
    ));
    let adaptiveWatermarkController = null;
    const playbackPreheater = this.own("PlaybackPreheater", new PlaybackPreheaterController({
      store: dataFrameStore,
      demandService: frameDemandService,
      eventLog,
      frameIdentity: this.frameIdentity,
      clock: clockDomain.monotonic,
      optionsProvider: () => this.state.playbackCache || {},
      fixedPolicyNormalizer: normalizedFixedWatermarkPolicy,
      watermarkPolicyProvider: (fixedPolicy, context) => (
        adaptiveWatermarkController?.resolve({ fixedPolicy, ...context }) || fixedPolicy
      ),
      sourcePolicyProvider: (sourceKey) => {
        const transport = queryPolicyController?.snapshot().transports[String(sourceKey || "")];
        return transport ? {
          sourceCapacity: transport.sourceCapacity,
          effectiveBatchSize: transport.effectiveBatchSize,
        } : null;
      },
      stateSink: (snapshot) => this.syncPreheater(snapshot),
    }));
    const playbackEngine = this.own("PlaybackEngine", new PlaybackEngineCore({
      store: dataFrameStore,
      demandService: frameDemandService,
      preheater: playbackPreheater,
      eventLog,
      frameIdentity: this.frameIdentity,
      clock: clockDomain.playback,
      frameBufferPolicy: PlaybackFrameBuffer,
      bufferTimeoutMs: PlaybackTimePolicy.BUFFER_TIMEOUT_MS,
    }));
    const playbackRuntime = this.own("PlaybackRuntime", new PlaybackRuntimeController({
      engine: playbackEngine,
      preheater: playbackPreheater,
      clock: clockDomain.playback,
      scheduler: PlaybackScheduler,
      frameIdentity: this.frameIdentity,
    }));
    const unsubscribePlaybackQueryIsolation = eventLog.subscribe((event) => {
      if (event?.type !== "RUN_STARTED" || event.kind !== "playback") return;
      scheduler.cancelPending({
        lane: "widget-auto",
        includeActive: true,
        reason: "playback_started",
      });
    }, { emitCurrent: false });
    this.own("PlaybackQueryIsolation", {
      dispose: unsubscribePlaybackQueryIsolation,
    }, { expose: false });
    this.own("PlaybackRenderer", new PlaybackRendererController({
      eventTarget: this.eventTarget,
    }));
    const runtimePerformanceMetrics = this.own(
      "RuntimePerformanceMetrics",
      createRuntimePerformanceMetrics({
        eventLog,
        preheater: playbackPreheater,
        playbackEngine,
        clock: clockDomain.monotonic,
      }),
    );
    adaptiveWatermarkController = this.own(
      "AdaptiveWatermarkController",
      new AdaptiveWatermarkControllerCore({
        metricsProvider: (context = {}) => runtimePerformanceMetrics.inputs(context),
        cacheSnapshotProvider: ({ scopeKey = "", cacheNamespace = "", datasetId = "" } = {}) => (
          dataFrameStore.snapshot(
            scopeKey || cacheNamespace || datasetId
              ? { scopeKey, cacheNamespace, datasetId }
              : { datasetId: "unscoped" },
          )
        ),
        configProvider: () => this.state.playbackCache || {},
        eventLog,
        clock: clockDomain.monotonic,
      }),
    );
    if (typeof createPlaybackCacheService !== "undefined") {
      this.own("PlaybackCacheService", createPlaybackCacheService({
        targetState: this.state,
        dataFrameStore,
        preheater: playbackPreheater,
        watermarkController: adaptiveWatermarkController,
        fixedPolicyNormalizer: normalizedFixedWatermarkPolicy,
        frameIdentity: this.frameIdentity,
        sampledGridLayerPredicate: (layerId) => (
          typeof isSampledGridLayer === "function" && isSampledGridLayer(layerId)
        ),
      }));
    }
    let renderGridProfileController = null;
    if (
      typeof RenderGridProfileControllerCore !== "undefined"
      && typeof VirtualGridContract !== "undefined"
      && typeof RendererRegistry !== "undefined"
    ) {
      renderGridProfileController = this.own(
        "RenderGridProfileController",
        new RenderGridProfileControllerCore({
          targetState: this.state,
          baseGridProvider: () => VirtualGridContract.resolveBase(),
          zoomProvider: () => this.targetMap?.getZoom?.() ?? null,
          gpuAggregationAvailableProvider: () => RendererRegistry.gpuAggregationAvailable?.() ?? false,
          datasetProvider: (datasetId) => this.state.datasets?.[datasetId] || null,
          eventTarget: this.eventTarget,
        }),
      );
    }
    if (typeof VirtualGridRuntimeController !== "undefined" && typeof VirtualGridContract !== "undefined") {
      const virtualGridController = this.own("VirtualGridController", new VirtualGridRuntimeController({
        targetState: this.state,
        contract: VirtualGridContract,
        eventTarget: this.eventTarget,
        targetMap: this.targetMap,
        profileController: renderGridProfileController,
      }));
      virtualGridController.bind();
    }
    let viewportController = null;
    if (this.targetMap && typeof DatasetViewportController !== "undefined") {
      viewportController = this.own("LayerViewportController", new DatasetViewportController({
        targetMap: this.targetMap,
        targetState: this.state,
        eventTarget: this.eventTarget,
      }));
    }
    if (
      typeof createRenderIntentService !== "undefined"
      && typeof currentBbox === "function"
      && this.sampledGridContract
    ) {
      renderIntentService = this.own("RenderIntentService", createRenderIntentService({
        targetState: this.state,
        bboxProvider: () => currentBbox(),
        viewportController,
        frameIdentity: this.frameIdentity,
        targetMap: this.targetMap,
        sampledGridContract: this.sampledGridContract,
        selectedDateProvider: () => document.getElementById("date")?.value,
      }));
    }
    if (typeof createWidgetApplicationRuntime !== "undefined" && this.sampledGridContract) {
      const eventSink = (type, detail = {}) => {
        this.eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
      };
      const spotifyPlayerSession = typeof SpotifyPlayerSessionCore !== "undefined"
        ? this.own("SpotifyPlayerSession", new SpotifyPlayerSessionCore(), { expose: false })
        : null;
      this.own("WidgetApplicationRuntime", createWidgetApplicationRuntime({
        stateProvider: () => this.state,
        layerRegistryProvider: () => this.globalTarget.LayerRuntimeContractRegistry || null,
        tileSelectionProvider: () => {
          const layer = this.globalTarget.TileSelectionLayer;
          const items = layer?.selections?.();
          if (Array.isArray(items) && items.length) return items;
          return [layer?.selected?.()].filter(Boolean);
        },
        selectedDateProvider: () => document.getElementById("date")?.value || "",
        selectedRangeProvider: () => (
          typeof this.globalTarget.datesInSelectedRange === "function"
            ? this.globalTarget.datesInSelectedRange()
            : null
        ),
        dateBoundsProvider: () => ({
          start: document.getElementById("start-date")?.value || "",
          end: document.getElementById("end-date")?.value || "",
        }),
        bboxProvider: () => (
          typeof this.globalTarget.currentBbox === "function" ? this.globalTarget.currentBbox() : ""
        ),
        mapSnapshotProvider: () => ({
          zoom: this.targetMap?.getZoom?.() ?? null,
          latitude: this.targetMap?.getCenter?.().lat ?? null,
        }),
        sampledGridContract: this.sampledGridContract,
        renderIntentService,
        dataFrameStore,
        frameDemandService,
        queryCoordinator,
        clock: clockDomain.monotonic,
        eezAttributionVersionProvider: () => JSON.stringify(
          this.globalTarget.LayerRuntimeContractRegistry?.contractForLayer?.("eez") || null,
        ),
        playbackSnapshotProvider: () => playbackEngine.snapshot(),
        eventLog,
        eventSink,
        timingMetricsProvider: () => timingMetrics,
        runtimeMetricsProvider: (runId = "") => runtimePerformanceMetrics.snapshot(runId),
        schedule: clockDomain.monotonic.schedule,
        cancelSchedule: clockDomain.monotonic.cancel,
        widgetPreferenceReader: (widgetType, key) => {
          const value = this.state.widgetPreferences?.[widgetType]?.[key];
          return Array.isArray(value) ? [...value] : value;
        },
        widgetPreferenceWriter: (widgetType, key, value) => {
          const current = this.state.widgetPreferences?.[widgetType] || {};
          this.state.widgetPreferences = {
            ...(this.state.widgetPreferences || {}),
            [widgetType]: {
              ...current,
              [key]: Array.isArray(value) ? [...value] : value,
            },
          };
          this.globalTarget.notifyBrowserProfileChanged?.("widget_preference_changed");
          return true;
        },
        spotifyPlayerSession,
        mapViewActions: this.globalTarget.MapViewActionCatalog || [],
      }));
    }
    this.composed = true;
    return this;
  }

  install(name, factory, { exposeAs = name, expose = true } = {}) {
    if (typeof factory !== "function") throw new TypeError(`Runtime installer requires a factory: ${name}`);
    if (this.instances.has(name)) return this.instances.get(name);
    const instance = factory({
      runtime: this,
      services: this.services(),
      state: this.state,
      eventTarget: this.eventTarget,
    });
    return this.own(name, instance, { expose, exposeAs });
  }

  services() {
    return Object.freeze(Object.fromEntries(this.instances));
  }

  snapshot() {
    return Object.freeze({
      composed: this.composed,
      serviceNames: Object.freeze([...this.instances.keys()]),
      exposedNames: Object.freeze(Object.fromEntries(this.exposedNames)),
      disposalCount: this.disposalOrder.length,
    });
  }

  dispose() {
    for (const instance of [...this.disposalOrder].reverse()) {
      try {
        if (typeof instance?.dispose === "function") {
          instance.dispose();
        } else {
          instance?.destroy?.();
        }
      } catch (error) {
        console.warn("Runtime disposal failed", error);
      }
    }
    for (const name of this.instances.keys()) {
      const exposedName = this.exposedNames.get(name);
      if (exposedName && this.globalTarget[exposedName] === this.instances.get(name)) {
        delete this.globalTarget[exposedName];
      }
    }
    this.instances.clear();
    this.exposedNames.clear();
    this.disposalOrder.length = 0;
    this.composed = false;
  }
}

const runtimeFrameIdentity = createFrameIdentity({
  datasetResolver: (datasetId) => state.datasets?.[datasetId] || {},
});

const AppRuntime = new RuntimeCompositionRoot({
  targetState: state,
  globalTarget: globalThis,
  eventTarget: window,
  targetMap: typeof map === "undefined" ? null : map,
  frameIdentity: runtimeFrameIdentity,
  fetchJson,
  sampledGridContract: typeof SampledGridContract === "undefined" ? null : SampledGridContract,
}).composeCore();

globalThis.RuntimeCompositionRoot = RuntimeCompositionRoot;
globalThis.AppRuntime = AppRuntime;
