function createClockDomain({
  monotonicNow,
  wallNowIso,
  schedule,
  cancelSchedule,
  requestFrame,
  cancelFrame,
} = {}) {
  if (
    typeof monotonicNow !== "function"
    || typeof wallNowIso !== "function"
    || typeof schedule !== "function"
    || typeof cancelSchedule !== "function"
    || typeof requestFrame !== "function"
    || typeof cancelFrame !== "function"
  ) {
    throw new TypeError("ClockDomain requires monotonic, wall, timer and render clock functions");
  }

  const monotonic = Object.freeze({
    now: () => Number(monotonicNow()),
    wallNowIso: () => String(wallNowIso()),
    schedule: (callback, delayMs = 0) => schedule(callback, Math.max(0, Number(delayMs || 0))),
    cancel: (handle) => cancelSchedule(handle),
  });

  const playback = Object.freeze({
    now: monotonic.now,
    schedule: monotonic.schedule,
    cancel: monotonic.cancel,
    cadenceMs({ baseIntervalMs = 1400, speed = 1, stepMode = "sequential" } = {}) {
      const base = Math.max(1, Number(baseIntervalMs || 1400));
      const multiplier = Math.max(0.25, Number(speed || 1));
      return stepMode === "fluid" ? base : Math.max(1, Math.round(base / multiplier));
    },
    consumptionRate({ baseIntervalMs = 1400, speed = 1 } = {}) {
      const base = Math.max(1, Number(baseIntervalMs || 1400));
      const multiplier = Math.max(0.25, Number(speed || 1));
      return (1000 / base) * multiplier;
    },
  });

  const render = Object.freeze({
    now: monotonic.now,
    request: (callback) => requestFrame(callback),
    cancel: (handle) => cancelFrame(handle),
    schedule: monotonic.schedule,
    cancelSchedule: monotonic.cancel,
  });

  return Object.freeze({ monotonic, playback, render });
}

function createSystemClockDomain({ globalTarget = globalThis } = {}) {
  const performanceTarget = globalTarget.performance;
  const monotonicNow = typeof performanceTarget?.now === "function"
    ? performanceTarget.now.bind(performanceTarget)
    : globalTarget.Date.now.bind(globalTarget.Date);
  const requestFrame = typeof globalTarget.requestAnimationFrame === "function"
    ? globalTarget.requestAnimationFrame.bind(globalTarget)
    : (callback) => globalTarget.setTimeout(() => callback(monotonicNow()), 16);
  const cancelFrame = typeof globalTarget.cancelAnimationFrame === "function"
    ? globalTarget.cancelAnimationFrame.bind(globalTarget)
    : globalTarget.clearTimeout.bind(globalTarget);

  return createClockDomain({
    monotonicNow,
    wallNowIso: () => new globalTarget.Date().toISOString(),
    schedule: globalTarget.setTimeout.bind(globalTarget),
    cancelSchedule: globalTarget.clearTimeout.bind(globalTarget),
    requestFrame,
    cancelFrame,
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.createClockDomain = createClockDomain;
  globalThis.createSystemClockDomain = createSystemClockDomain;
}
