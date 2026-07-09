const PlaybackDeliveryPolicy = (() => {
  const MODES = {
    analysis: {
      implemented: true,
      label: "分析模式",
      stepMode: "sequential",
      statusText: "已啟用：分析模式。每張真實 snapshot 都會顯示；frame 不 ready 時以緩衝等待，不跳過日期。",
    },
    smooth: {
      implemented: false,
      label: "流暢模式",
      stepMode: "fluid",
      statusText: "流暢模式端口已保留，但尚未實作；目前自動回落到分析模式，不會控制播放時間軸。",
    },
    strict: {
      implemented: false,
      label: "嚴格模式",
      stepMode: "sequential",
      statusText: "嚴格模式端口已保留，但尚未實作；目前自動回落到分析模式，不會控制播放時間軸。",
    },
  };

  function normalizeMode(value) {
    return Object.prototype.hasOwnProperty.call(MODES, value) ? value : "analysis";
  }

  function effectiveModeFor(requestedMode) {
    const normalized = normalizeMode(requestedMode);
    return MODES[normalized].implemented ? normalized : "analysis";
  }

  function ensureState(targetState) {
    targetState.playbackDelivery = targetState.playbackDelivery || {};
    const requestedMode = normalizeMode(
      targetState.playbackDelivery.requestedMode || targetState.playbackDelivery.mode
    );
    const effectiveMode = effectiveModeFor(requestedMode);
    targetState.playbackDelivery.requestedMode = requestedMode;
    targetState.playbackDelivery.mode = effectiveMode;
    return targetState.playbackDelivery;
  }

  function options(targetState) {
    const delivery = ensureState(targetState);
    const requestedMode = normalizeMode(delivery.requestedMode);
    const effectiveMode = effectiveModeFor(requestedMode);
    const requested = MODES[requestedMode];
    const effective = MODES[effectiveMode];
    return {
      requestedMode,
      effectiveMode,
      implemented: requested.implemented,
      requestedLabel: requested.label,
      effectiveLabel: effective.label,
      stepMode: effective.stepMode,
      statusText: requested.implemented ? effective.statusText : requested.statusText,
    };
  }

  function apply(targetState) {
    const result = options(targetState);
    targetState.playbackCache = targetState.playbackCache || {};
    targetState.playbackCache.stepMode = result.stepMode;
    return result;
  }

  function setMode(targetState, mode) {
    targetState.playbackDelivery = targetState.playbackDelivery || {};
    targetState.playbackDelivery.requestedMode = normalizeMode(mode);
    return apply(targetState);
  }

  function stepMode(targetState) {
    return apply(targetState).stepMode;
  }

  function telemetryLabel(optionPacket) {
    const packet = optionPacket || {};
    if (packet.requestedMode && packet.requestedMode !== packet.effectiveMode) {
      return `${packet.requestedLabel}未實作 -> ${packet.effectiveLabel}`;
    }
    return packet.effectiveLabel || "分析模式";
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
