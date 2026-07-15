const PlaybackFrameBuffer = (() => {
  const FRAME_STATES = {
    missing: "missing",
    fetching: "fetching",
    ready: "ready",
    waiting: "waiting",
    failed: "failed",
  };

  function emptyDecision(targetIndex = -1) {
    return {
      state: FRAME_STATES.missing,
      targetIndex,
      targetDate: "",
      renderIndex: -1,
      renderDate: "",
      readyCount: 0,
      requiredCount: 0,
      resumeCount: 0,
      canRender: false,
      isFallback: false,
      errorMessage: "",
    };
  }

  function frameStateLabel(state) {
    return {
      missing: "missing",
      fetching: "fetching",
      ready: "ready",
      waiting: "waiting",
      failed: "failed",
    }[state] || "missing";
  }

  function inspectTarget({
    dates,
    currentIndex,
    targetIndex,
    hasCacheLayer,
    requestContext,
    cacheService,
    resumeGate = null,
  }) {
    const allDates = Array.isArray(dates) ? dates : [];
    if (targetIndex < 0 || targetIndex >= allDates.length) {
      return emptyDecision(targetIndex);
    }
    const targetDate = allDates[targetIndex] || "";
    if (!hasCacheLayer) {
      return {
        ...emptyDecision(targetIndex),
        state: FRAME_STATES.ready,
        targetDate,
        renderIndex: targetIndex,
        renderDate: targetDate,
        readyCount: 1,
        requiredCount: 1,
        resumeCount: 1,
        canRender: true,
      };
    }

    let renderIndex = -1;
    for (let index = targetIndex; index > currentIndex; index -= 1) {
      if (cacheService.hasDate(allDates[index], requestContext)) {
        renderIndex = index;
        break;
      }
    }
    if (renderIndex >= 0) {
      if (resumeGate?.active) {
        return {
          ...emptyDecision(targetIndex),
          state: FRAME_STATES.waiting,
          targetDate,
          readyCount: Math.max(0, Number(resumeGate.readyCount || 0)),
          requiredCount: Math.max(1, Number(resumeGate.required || 1)),
          resumeCount: Math.max(1, Number(resumeGate.required || 1)),
        };
      }
      return {
        ...emptyDecision(targetIndex),
        state: FRAME_STATES.ready,
        targetDate,
        renderIndex,
        renderDate: allDates[renderIndex] || "",
        readyCount: cacheService.countReadyPrefix?.(allDates, targetIndex, requestContext) || 1,
        requiredCount: 1,
        resumeCount: 1,
        canRender: true,
        isFallback: renderIndex < targetIndex,
      };
    }

    const failure = cacheService.failureForDate?.(targetDate, requestContext);
    if (failure) {
      return {
        ...emptyDecision(targetIndex),
        state: FRAME_STATES.failed,
        targetDate,
        readyCount: cacheService.countReadyPrefix?.(allDates, targetIndex, requestContext) || 0,
        requiredCount: 1,
        resumeCount: 1,
        errorMessage: failure.message || "request failed",
      };
    }

    return {
      ...emptyDecision(targetIndex),
      state: FRAME_STATES.fetching,
      targetDate,
      readyCount: resumeGate?.active
        ? Math.max(0, Number(resumeGate.readyCount || 0))
        : cacheService.countReadyPrefix?.(allDates, targetIndex, requestContext) || 0,
      requiredCount: resumeGate?.active ? Math.max(1, Number(resumeGate.required || 1)) : 1,
      resumeCount: resumeGate?.active ? Math.max(1, Number(resumeGate.required || 1)) : 1,
    };
  }

  function markWaiting({
    decision,
    dates,
    targetIndex,
    cacheService,
    attempts = 0,
  }) {
    const packet = decision || emptyDecision(targetIndex);
    cacheService.setBufferState({
      buffering: true,
      status: "waiting",
      ready: packet.readyCount || 0,
      required: packet.requiredCount || 1,
      resume: packet.resumeCount || packet.requiredCount || 1,
      currentDate: packet.targetDate || dates[targetIndex] || "",
      targetIndex,
      attempts,
      stateName: packet.state,
      errorMessage: packet.errorMessage || "",
    });
  }

  function markFailed({
    decision,
    dates,
    targetIndex,
    cacheService,
    attempts = 0,
    errorMessage = "",
  }) {
    const packet = decision || emptyDecision(targetIndex);
    cacheService.setBufferState({
      buffering: false,
      status: "failed",
      ready: packet.readyCount || 0,
      required: packet.requiredCount || 1,
      resume: packet.resumeCount || packet.requiredCount || 1,
      currentDate: packet.targetDate || dates[targetIndex] || "",
      targetIndex,
      attempts,
      stateName: packet.state || FRAME_STATES.failed,
      errorMessage: errorMessage || packet.errorMessage || "",
    });
  }

  return {
    FRAME_STATES,
    frameStateLabel,
    inspectTarget,
    markFailed,
    markWaiting,
  };
})();

window.PlaybackFrameBuffer = PlaybackFrameBuffer;
