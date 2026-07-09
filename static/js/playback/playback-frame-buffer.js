const PlaybackFrameBuffer = (() => {
  function readyTargetIndex({
    dates,
    currentIndex,
    targetIndex,
    mode,
    hasCacheLayer,
    requestContext,
    cacheService,
  }) {
    if (mode !== "progressive" || !hasCacheLayer) {
      return targetIndex;
    }
    for (let index = targetIndex; index > currentIndex; index -= 1) {
      if (cacheService.hasDate(dates[index], requestContext)) {
        return index;
      }
    }
    return -1;
  }

  function markWaiting({ dates, targetIndex, cacheService }) {
    cacheService.setBufferState({
      buffering: true,
      status: "waiting",
      ready: 0,
      required: 1,
      resume: 1,
      currentDate: dates[targetIndex] || "",
    });
  }

  return {
    markWaiting,
    readyTargetIndex,
  };
})();

window.PlaybackFrameBuffer = PlaybackFrameBuffer;
