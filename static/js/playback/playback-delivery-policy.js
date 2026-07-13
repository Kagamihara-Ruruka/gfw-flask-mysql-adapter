const PlaybackDeliveryPolicy = (() => {
  const MODE = "analysis";
  const STEP_MODE = "sequential";

  function ensureState(targetState) {
    targetState.playbackDelivery = targetState.playbackDelivery || {};
    targetState.playbackDelivery.requestedMode = MODE;
    targetState.playbackDelivery.mode = MODE;
    return targetState.playbackDelivery;
  }

  function options(targetState) {
    ensureState(targetState);
    return {
      requestedMode: MODE,
      effectiveMode: MODE,
      implemented: true,
      requestedLabel: "分析模式",
      effectiveLabel: "分析模式",
      stepMode: STEP_MODE,
      statusText: "逐張呈現每個 snapshot；資料不足時緩衝，不跳過日期。",
    };
  }

  function apply(targetState) {
    const result = options(targetState);
    targetState.playbackCache = targetState.playbackCache || {};
    targetState.playbackCache.stepMode = STEP_MODE;
    return result;
  }

  function setMode(targetState) {
    return apply(targetState);
  }

  function stepMode(targetState) {
    apply(targetState);
    return STEP_MODE;
  }

  function telemetryLabel() {
    return "分析模式";
  }

  return {
    apply,
    options,
    setMode,
    stepMode,
    telemetryLabel,
  };
})();

window.PlaybackDeliveryPolicy = PlaybackDeliveryPolicy;
