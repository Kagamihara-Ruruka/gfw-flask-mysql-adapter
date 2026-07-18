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
    inspectFrame,
    bufferGate = null,
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
        canRender: true,
      };
    }
    if (typeof inspectFrame !== "function") {
      throw new TypeError("PlaybackFrameBuffer requires the PlaybackEngine frame inspector");
    }

    let renderIndex = -1;
    for (let index = targetIndex; index > currentIndex; index -= 1) {
      if (inspectFrame(index)?.status === "ready") {
        renderIndex = index;
        break;
      }
    }
    if (renderIndex >= 0) {
      if (bufferGate?.active && !bufferGate.ready) {
        return {
          ...emptyDecision(targetIndex),
          state: FRAME_STATES.waiting,
          targetDate,
          readyCount: Math.max(0, Number(bufferGate.readyCount || 0)),
          requiredCount: Math.max(1, Number(bufferGate.required || 1)),
        };
      }
      return {
        ...emptyDecision(targetIndex),
        state: FRAME_STATES.ready,
        targetDate,
        renderIndex,
        renderDate: allDates[renderIndex] || "",
        readyCount: countReadyPrefix(allDates, targetIndex, inspectFrame) || 1,
        requiredCount: 1,
        canRender: true,
        isFallback: renderIndex < targetIndex,
      };
    }

    const target = inspectFrame(targetIndex) || {};
    if (target.status === "failed") {
      return {
        ...emptyDecision(targetIndex),
        state: FRAME_STATES.failed,
        targetDate,
        readyCount: countReadyPrefix(allDates, targetIndex, inspectFrame),
        requiredCount: 1,
        errorMessage: target.failure?.message || "request failed",
      };
    }

    return {
      ...emptyDecision(targetIndex),
      state: FRAME_STATES.fetching,
      targetDate,
      readyCount: bufferGate?.active
        ? Math.max(0, Number(bufferGate.readyCount || 0))
        : countReadyPrefix(allDates, targetIndex, inspectFrame),
      requiredCount: bufferGate?.active ? Math.max(1, Number(bufferGate.required || 1)) : 1,
    };
  }

  function countReadyPrefix(dates, startIndex, inspectFrame) {
    let ready = 0;
    for (let index = startIndex; index < dates.length; index += 1) {
      if (inspectFrame(index)?.status !== "ready") break;
      ready += 1;
    }
    return ready;
  }

  function waitingState({
    decision,
    dates,
    targetIndex,
    attempts = 0,
  }) {
    const packet = decision || emptyDecision(targetIndex);
    return {
      buffering: true,
      status: "waiting",
      ready: packet.readyCount || 0,
      required: packet.requiredCount || 1,
      currentDate: packet.targetDate || dates[targetIndex] || "",
      targetIndex,
      attempts,
      stateName: packet.state,
      errorMessage: packet.errorMessage || "",
    };
  }

  function failedState({
    decision,
    dates,
    targetIndex,
    attempts = 0,
    errorMessage = "",
  }) {
    const packet = decision || emptyDecision(targetIndex);
    return {
      buffering: false,
      status: "failed",
      ready: packet.readyCount || 0,
      required: packet.requiredCount || 1,
      currentDate: packet.targetDate || dates[targetIndex] || "",
      targetIndex,
      attempts,
      stateName: packet.state || FRAME_STATES.failed,
      errorMessage: errorMessage || packet.errorMessage || "",
    };
  }

  return {
    FRAME_STATES,
    frameStateLabel,
    inspectTarget,
    failedState,
    waitingState,
  };
})();

if (typeof globalThis !== "undefined") globalThis.PlaybackFrameBuffer = PlaybackFrameBuffer;
