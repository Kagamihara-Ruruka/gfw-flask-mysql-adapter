const PlaybackTimePolicy = Object.freeze({
  BUFFER_TIMEOUT_MS: 30_000,

  bufferTimedOut(waitMs, timeoutMs = 30_000) {
    const elapsed = Math.max(0, Number(waitMs || 0));
    const threshold = Math.max(1, Number(timeoutMs || 30_000));
    return elapsed >= threshold;
  },
});

if (typeof globalThis !== "undefined") {
  globalThis.PlaybackTimePolicy = PlaybackTimePolicy;
}
