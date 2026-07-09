const PlaybackScheduler = (() => {
  function start({
    generation,
    nowMs,
    intervalMs,
    rate,
    stepMode,
    baseDateIndex,
    firstDelayMs = 0,
  }) {
    const normalizedInterval = Math.max(1, Number(intervalMs || 1));
    return {
      generation,
      intervalMs: normalizedInterval,
      rate: Math.max(0.25, Number(rate || 1)),
      stepMode: stepMode === "fluid" ? "fluid" : "sequential",
      baseDateIndex: Math.max(0, Number(baseDateIndex || 0)),
      startedAt: Number(nowMs || 0) + Math.max(0, Number(firstDelayMs || 0)) - normalizedInterval,
      nextFrameNumber: 1,
    };
  }

  function delayUntilNextFrame(timeline, { nowMs, fallbackIntervalMs = 1 } = {}) {
    const intervalMs = Math.max(1, Number(timeline?.intervalMs || fallbackIntervalMs || 1));
    const frameNumber = Number(timeline?.nextFrameNumber || 1);
    const targetMs = Number(timeline?.startedAt || 0) + frameNumber * intervalMs;
    return Math.max(0, targetMs - Number(nowMs || 0));
  }

  function dueFrameNumber(timeline, { nowMs, fallbackIntervalMs = 1 } = {}) {
    const intervalMs = Math.max(1, Number(timeline?.intervalMs || fallbackIntervalMs || 1));
    const elapsedFrames = Math.floor((Number(nowMs || 0) - Number(timeline?.startedAt || 0)) / intervalMs);
    return Math.max(1, Number(timeline?.nextFrameNumber || 1), elapsedFrames);
  }

  function markFrameShown(timeline, { frameNumber = null } = {}) {
    if (!timeline) return null;
    if (timeline.stepMode === "fluid") {
      const shownFrameNumber = Math.max(1, Number(frameNumber || timeline.nextFrameNumber || 1));
      timeline.nextFrameNumber = Math.max(Number(timeline.nextFrameNumber || 1), shownFrameNumber + 1);
      return timeline;
    }
    timeline.nextFrameNumber = Number(timeline.nextFrameNumber || 1) + 1;
    return timeline;
  }

  function shift(timeline, deltaMs) {
    if (!timeline) return null;
    const amount = Math.max(0, Number(deltaMs || 0));
    if (amount > 0) {
      timeline.startedAt = Number(timeline.startedAt || 0) + amount;
    }
    return timeline;
  }

  function targetDateIndex(timeline, { datesLength, currentIndex, frameNumber } = {}) {
    const length = Math.max(0, Number(datesLength || 0));
    if (!length || currentIndex < 0) return -1;
    if (timeline?.stepMode !== "fluid") {
      return Math.min(length - 1, Number(currentIndex || 0) + 1);
    }
    const baseIndex = Math.min(length - 1, Math.max(0, Number(timeline.baseDateIndex ?? currentIndex ?? 0)));
    const rate = Math.max(0.25, Number(timeline.rate || 1));
    const scaledOffset = Math.max(1, Number(frameNumber || 1)) * rate;
    const offset = Math.max(1, rate < 1 ? Math.ceil(scaledOffset) : Math.floor(scaledOffset));
    return Math.min(length - 1, baseIndex + offset);
  }

  return {
    delayUntilNextFrame,
    dueFrameNumber,
    markFrameShown,
    shift,
    start,
    targetDateIndex,
  };
})();

window.PlaybackScheduler = PlaybackScheduler;
