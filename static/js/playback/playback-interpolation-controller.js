const PlaybackInterpolationController = (() => {
  const MODES = new Set(["off", "layer_crossfade"]);

  function normalizeMode(value) {
    return MODES.has(value) ? value : "layer_crossfade";
  }

  function normalizeTargetFps(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 24;
    return Math.min(60, Math.max(12, Math.round(parsed)));
  }

  function ensureState(targetState) {
    targetState.playbackInterpolation = targetState.playbackInterpolation || {};
    targetState.playbackInterpolation.mode = normalizeMode(targetState.playbackInterpolation.mode);
    targetState.playbackInterpolation.targetFps = normalizeTargetFps(targetState.playbackInterpolation.targetFps);
    return targetState.playbackInterpolation;
  }

  function options(targetState) {
    const interpolation = ensureState(targetState);
    return {
      mode: normalizeMode(interpolation.mode),
      targetFps: normalizeTargetFps(interpolation.targetFps),
      dataBlendAvailable: false,
    };
  }

  function setMode(targetState, mode) {
    const interpolation = ensureState(targetState);
    interpolation.mode = normalizeMode(mode);
    return options(targetState);
  }

  function setTargetFps(targetState, targetFps) {
    const interpolation = ensureState(targetState);
    interpolation.targetFps = normalizeTargetFps(targetFps);
    return options(targetState);
  }

  function playbackTransitionMs(targetState, baseMs) {
    const ms = Math.max(0, Number(baseMs || 0));
    if (!targetState?.isPlaying) return ms;
    return options(targetState).mode === "off" ? 0 : ms;
  }

  function modeLabel(mode) {
    return normalizeMode(mode) === "off" ? "直接切換" : "Layer crossfade";
  }

  return {
    modeLabel,
    options,
    playbackTransitionMs,
    setMode,
    setTargetFps,
  };
})();

window.PlaybackInterpolationController = PlaybackInterpolationController;
