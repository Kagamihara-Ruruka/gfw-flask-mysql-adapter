function normalizedPolicyInteger(value, { fallback, minimum = 1, maximum = 16 } = {}) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

function normalizedTransportCapacities(value = {}) {
  return Object.freeze(Object.fromEntries(
    Object.entries(value || {})
      .map(([key, capacity]) => [
        String(key || "").trim(),
        normalizedPolicyInteger(capacity, { fallback: 1 }),
      ])
      .filter(([key]) => key),
  ));
}

function resolveQueryPolicy({ requested = {}, serverLimits = {}, sourceCapacities = {} } = {}) {
  const requestedNetwork = normalizedPolicyInteger(requested.network_concurrency, { fallback: 6 });
  const serverNetwork = normalizedPolicyInteger(serverLimits.network_concurrency, { fallback: 6 });
  const networkConcurrency = Math.min(requestedNetwork, serverNetwork);
  const requestedReserved = normalizedPolicyInteger(requested.foreground_reserved_slots, {
    fallback: 1,
    minimum: 0,
  });
  const foregroundReservedSlots = networkConcurrency > 1
    ? Math.min(requestedReserved, networkConcurrency - 1)
    : 0;
  const requestedBackground = normalizedPolicyInteger(
    requested.background_network_concurrency,
    { fallback: 3 },
  );
  const backgroundConcurrency = Math.min(
    requestedBackground,
    Math.max(1, networkConcurrency - foregroundReservedSlots),
  );
  const requestedBatch = normalizedPolicyInteger(
    requested.batch_max_operations,
    { fallback: 3, maximum: 32 },
  );
  const serverBatch = normalizedPolicyInteger(
    serverLimits.batch_max_operations,
    { fallback: 3, maximum: 32 },
  );
  const batchMaxOperations = Math.min(requestedBatch, serverBatch);
  const capacities = normalizedTransportCapacities(sourceCapacities);
  const transports = Object.freeze(Object.fromEntries(
    Object.entries(capacities).map(([sourceKey, sourceCapacity]) => [sourceKey, Object.freeze({
      sourceCapacity,
      requestedBatchSize: requestedBatch,
      serverBatchLimit: serverBatch,
      effectiveBatchSize: Math.min(batchMaxOperations, sourceCapacity),
      overrideReason: sourceCapacity < batchMaxOperations ? "source_capacity" : null,
    })]),
  ));
  const networkOverrideReason = requestedNetwork > serverNetwork ? "server_worker_limit" : null;
  const backgroundOverrideReason = requestedBackground > backgroundConcurrency
    ? "foreground_slot_reservation"
    : null;

  return Object.freeze({
    requested: Object.freeze({
      networkConcurrency: requestedNetwork,
      backgroundConcurrency: requestedBackground,
      batchMaxOperations: requestedBatch,
      foregroundReservedSlots: requestedReserved,
    }),
    effective: Object.freeze({
      networkConcurrency,
      backgroundConcurrency,
      batchMaxOperations,
      foregroundReservedSlots,
    }),
    serverLimits: Object.freeze({
      networkConcurrency: serverNetwork,
      batchMaxOperations: serverBatch,
    }),
    transports,
    controls: Object.freeze({
      networkConcurrency: Object.freeze({
        owner: "QueryScheduler",
        scope: "browser",
        persistence: "session",
        requiresRestart: false,
        serverOwner: "QueryBatchExecutor",
        serverRequiresRestart: true,
        overrideReason: networkOverrideReason,
      }),
      backgroundConcurrency: Object.freeze({
        owner: "QueryScheduler",
        scope: "browser",
        persistence: "session",
        requiresRestart: false,
        overrideReason: backgroundOverrideReason,
      }),
      batchMaxOperations: Object.freeze({
        owner: "QueryBroker",
        scope: "query_transport",
        persistence: "session",
        requiresRestart: false,
        serverOwner: "DatasetRoutes",
        serverRequiresRestart: true,
        overrideReason: requestedBatch > serverBatch ? "server_batch_limit" : null,
      }),
    }),
  });
}

class QueryPolicyControllerCore {
  constructor({ targetState, scheduler, broker } = {}) {
    if (!targetState || !scheduler || typeof scheduler.drain !== "function") {
      throw new TypeError("QueryPolicyController requires state and scheduler");
    }
    if (!broker || typeof broker.reconcilePolicy !== "function") {
      throw new TypeError("QueryPolicyController requires QueryBroker");
    }
    this.state = targetState;
    this.scheduler = scheduler;
    this.broker = broker;
    this.hydrated = false;
  }

  policyTarget() {
    this.state.queryPolicy ||= {};
    return this.state.queryPolicy;
  }

  snapshot() {
    return resolveQueryPolicy({
      requested: this.policyTarget(),
      serverLimits: this.state.queryPolicyServerLimits || this.policyTarget(),
      sourceCapacities: this.state.queryTransportCapacities || {},
    });
  }

  notifyExecutors() {
    this.scheduler.drain();
    this.broker.reconcilePolicy();
  }

  hydrate({ policy = {}, sourceCapacities = {} } = {}) {
    const adjustable = this.hydrated ? {
      network_concurrency: this.policyTarget().network_concurrency,
      background_network_concurrency: this.policyTarget().background_network_concurrency,
      batch_max_operations: this.policyTarget().batch_max_operations,
      foreground_reserved_slots: this.policyTarget().foreground_reserved_slots,
    } : {};
    this.state.queryPolicyServerLimits = { ...policy };
    this.state.queryPolicy = { ...policy, ...adjustable };
    this.state.queryTransportCapacities = { ...normalizedTransportCapacities(sourceCapacities) };
    this.hydrated = true;
    this.notifyExecutors();
    return this.snapshot();
  }

  configure({
    networkConcurrency = null,
    backgroundConcurrency = null,
    batchMaxOperations = null,
  } = {}) {
    const current = this.snapshot().requested;
    Object.assign(this.policyTarget(), {
      network_concurrency: networkConcurrency == null
        ? current.networkConcurrency
        : normalizedPolicyInteger(networkConcurrency, { fallback: current.networkConcurrency }),
      background_network_concurrency: backgroundConcurrency == null
        ? current.backgroundConcurrency
        : normalizedPolicyInteger(backgroundConcurrency, { fallback: current.backgroundConcurrency }),
      batch_max_operations: batchMaxOperations == null
        ? current.batchMaxOperations
        : normalizedPolicyInteger(batchMaxOperations, {
          fallback: current.batchMaxOperations,
          maximum: 32,
        }),
    });
    this.notifyExecutors();
    return this.snapshot();
  }

  networkConcurrency() {
    return this.snapshot().effective.networkConcurrency;
  }

  backgroundConcurrency() {
    return this.snapshot().effective.backgroundConcurrency;
  }

  sourceCapacity(sourceKey) {
    const key = String(sourceKey || "");
    return this.snapshot().transports[key]?.sourceCapacity || 1;
  }

  effectiveBatchSize(sourceKey) {
    const snapshot = this.snapshot();
    return snapshot.transports[String(sourceKey || "")]?.effectiveBatchSize
      || Math.min(snapshot.effective.batchMaxOperations, 1);
  }

  setNetworkConcurrency(value) {
    return this.configure({ networkConcurrency: value });
  }

  setBackgroundConcurrency(value) {
    return this.configure({ backgroundConcurrency: value });
  }

  setBatchMaxOperations(value) {
    return this.configure({ batchMaxOperations: value });
  }

  dispose() {}
}

globalThis.resolveQueryPolicy = resolveQueryPolicy;
globalThis.QueryPolicyControllerCore = QueryPolicyControllerCore;
