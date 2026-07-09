const PlaybackPrefetchController = (() => {
  function targetIndex({ dates, startIndex = null, currentDate = "" } = {}) {
    if (!Array.isArray(dates) || !dates.length) return -1;
    const index = startIndex ?? dates.indexOf(currentDate);
    if (index < 0 || index >= dates.length) return -1;
    return index;
  }

  function anchorDate({ dates, startIndex = null, currentDate = "" } = {}) {
    if (startIndex == null) return currentDate || "";
    return dates?.[startIndex] || "";
  }

  function shouldQueue({
    options,
    isBackgroundPreloading = false,
    dates,
    startIndex = null,
    currentDate = "",
    requestContext,
    cacheService,
    intervalMs,
    rate,
  } = {}) {
    if (options?.mode !== "progressive" || isBackgroundPreloading) {
      return { shouldQueue: false, index: -1, anchorDate: "" };
    }
    const index = targetIndex({ dates, startIndex, currentDate });
    if (index < 0) {
      return { shouldQueue: false, index, anchorDate: "" };
    }
    const remainingDates = Math.max(1, dates.length - index);
    const policy = cacheService.bufferPolicy({
      intervalMs,
      rate,
      remainingDates,
    });
    const ready = cacheService.countReadyPrefix(dates, index, requestContext);
    return {
      shouldQueue: ready <= policy.resume,
      index,
      anchorDate: anchorDate({ dates, startIndex, currentDate }),
      policy,
      ready,
      remainingDates,
    };
  }

  return {
    anchorDate,
    shouldQueue,
    targetIndex,
  };
})();

window.PlaybackPrefetchController = PlaybackPrefetchController;
