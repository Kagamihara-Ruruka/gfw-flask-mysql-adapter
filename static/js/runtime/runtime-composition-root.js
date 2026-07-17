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
    const scheduler = this.own("QuerySchedulerInstance", new QueryScheduler({
      concurrencyProvider: () => this.state.queryPolicy?.network_concurrency ?? 6,
      backgroundConcurrencyProvider: () => (
        this.state.queryPolicy?.background_network_concurrency ?? 3
      ),
      eventLog,
      snapshotSink: (snapshot) => this.syncQueryScheduler(snapshot),
      clock: clockDomain.monotonic,
    }), { expose: false });
    this.own("QueryPolicyController", new QueryPolicyControllerCore({
      targetState: this.state,
      scheduler,
    }));
    const queryCoordinator = this.own("LayerQueryCoordinator", createLayerQueryCoordinator({
      scheduler,
      fetchJson: this.fetchJson,
    }));
    const queryBroker = this.own("QueryBroker", new QueryBroker({
      fetchFn: this.globalTarget.fetch.bind(this.globalTarget),
      eventLog,
      clock: clockDomain.monotonic,
      priorityForLane: (lane) => scheduler.priorityFor(lane),
      maxBatchSizeProvider: () => this.state.queryPolicy?.batch_max_operations ?? 3,
    }));
    const dataFrameStore = this.own("DataFrameStore", new DataFrameStoreCore({
      frameIdentity: this.frameIdentity,
      eventLog,
      optionsProvider: () => this.state.dataFrameStore || {},
      statsTargetProvider: () => this.dataFrameStatsTarget(),
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
      stateSink: (snapshot) => this.syncPreheater(snapshot),
    }));
    const playbackEngine = this.own("PlaybackEngine", new PlaybackEngineCore({
      store: dataFrameStore,
      demandService: frameDemandService,
      preheater: playbackPreheater,
      eventLog,
      frameIdentity: this.frameIdentity,
      clock: clockDomain.playback,
    }));
    const playbackRuntime = this.own("PlaybackRuntime", new PlaybackRuntimeController({
      engine: playbackEngine,
      preheater: playbackPreheater,
      clock: clockDomain.playback,
      scheduler: PlaybackScheduler,
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
        cacheSnapshotProvider: ({ cacheNamespace = "", datasetId = "" } = {}) => dataFrameStore.snapshot(
          cacheNamespace
            ? { cacheNamespace }
            : datasetId
              ? { datasetId }
              : { datasetId: "unscoped" },
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
    if (typeof VirtualGridRuntimeController !== "undefined" && typeof VirtualGridContract !== "undefined") {
      const virtualGridController = this.own("VirtualGridController", new VirtualGridRuntimeController({
        targetState: this.state,
        contract: VirtualGridContract,
        eventTarget: this.eventTarget,
        targetMap: this.targetMap,
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
    let renderIntentService = null;
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
        playbackSnapshotProvider: () => playbackEngine.snapshot(),
        eventLog,
        eventSink,
        timingMetricsProvider: () => timingMetrics,
        runtimeMetricsProvider: (runId = "") => runtimePerformanceMetrics.snapshot(runId),
        schedule: clockDomain.monotonic.schedule,
        cancelSchedule: clockDomain.monotonic.cancel,
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
