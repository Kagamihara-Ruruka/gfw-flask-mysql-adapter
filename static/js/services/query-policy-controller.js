function normalizedQueryConcurrency(value, fallback = 6) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return Math.max(1, Math.min(16, normalized));
}

function normalizedBackgroundConcurrency(value, total, fallback = 3) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return Math.max(1, Math.min(total, normalized));
}

class QueryPolicyControllerCore {
  constructor({ targetState, scheduler } = {}) {
    if (!targetState || !scheduler || typeof scheduler.drain !== "function") {
      throw new TypeError("QueryPolicyController requires state and scheduler");
    }
    this.state = targetState;
    this.scheduler = scheduler;
  }

  policyTarget() {
    this.state.queryPolicy ||= {};
    return this.state.queryPolicy;
  }

  snapshot() {
    const policy = this.policyTarget();
    const networkConcurrency = normalizedQueryConcurrency(policy.network_concurrency);
    const backgroundConcurrency = normalizedBackgroundConcurrency(
      policy.background_network_concurrency,
      networkConcurrency,
    );
    return Object.freeze({ networkConcurrency, backgroundConcurrency });
  }

  configure({ networkConcurrency = null, backgroundConcurrency = null } = {}) {
    const current = this.snapshot();
    const nextNetwork = networkConcurrency == null
      ? current.networkConcurrency
      : normalizedQueryConcurrency(networkConcurrency);
    const nextBackground = backgroundConcurrency == null
      ? Math.min(nextNetwork, current.backgroundConcurrency)
      : normalizedBackgroundConcurrency(backgroundConcurrency, nextNetwork);
    Object.assign(this.policyTarget(), {
      network_concurrency: nextNetwork,
      background_network_concurrency: nextBackground,
    });
    this.scheduler.drain();
    return this.snapshot();
  }

  setNetworkConcurrency(value) {
    return this.configure({ networkConcurrency: value });
  }

  setBackgroundConcurrency(value) {
    return this.configure({ backgroundConcurrency: value });
  }

  dispose() {}
}

globalThis.QueryPolicyControllerCore = QueryPolicyControllerCore;
