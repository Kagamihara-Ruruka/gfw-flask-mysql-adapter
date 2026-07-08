const PlaybackWorkerPolicy = (() => {
  const DEFAULT_CORES = 4;
  const MIN_WORKERS = 1;
  const MAX_WORKERS = 12;

  function logicalCoreCount() {
    const cores = Number(navigator.hardwareConcurrency || DEFAULT_CORES);
    if (!Number.isFinite(cores) || cores < 1) return DEFAULT_CORES;
    return Math.max(1, Math.floor(cores));
  }

  function clampWorkerCount(value, total = MAX_WORKERS) {
    const maxForWork = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Number(total || MAX_WORKERS)));
    const count = Math.max(MIN_WORKERS, Math.floor(Number(value || MIN_WORKERS)));
    return Math.min(maxForWork, count);
  }

  function autoWorkerCount({ task = "prefetch", total = MAX_WORKERS } = {}) {
    const cores = logicalCoreCount();
    const reserve = cores >= 8 ? 2 : 1;
    const base = Math.max(MIN_WORKERS, cores - reserve);
    const taskCap = task === "snapshot_split" ? MAX_WORKERS : Math.min(8, MAX_WORKERS);
    return clampWorkerCount(Math.min(base, taskCap), total);
  }

  function resolve(value, { task = "prefetch", total = MAX_WORKERS } = {}) {
    if (value === "auto" || value == null || value === "") {
      return autoWorkerCount({ task, total });
    }
    return clampWorkerCount(value, total);
  }

  function label(value, context = {}) {
    if (value === "auto" || value == null || value === "") {
      return `auto (${resolve(value, context)})`;
    }
    return String(resolve(value, context));
  }

  return {
    autoWorkerCount,
    label,
    logicalCoreCount,
    resolve,
  };
})();
