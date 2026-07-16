const PlaybackInterpolationController = (() => {
  const MODES = new Set(["off", "layer_crossfade"]);

  function normalizeMode(value) {
    return MODES.has(value) ? value : "layer_crossfade";
  }

  function ensureState(targetState) {
    targetState.playbackInterpolation = targetState.playbackInterpolation || {};
    targetState.playbackInterpolation.mode = normalizeMode(targetState.playbackInterpolation.mode);
    return targetState.playbackInterpolation;
  }

  function options(targetState) {
    const interpolation = ensureState(targetState);
    return {
      mode: normalizeMode(interpolation.mode),
    };
  }

  function setMode(targetState, mode) {
    const interpolation = ensureState(targetState);
    interpolation.mode = normalizeMode(mode);
    return options(targetState);
  }

  function playbackTransitionMs(targetState, baseMs, { playbackActive = false } = {}) {
    const ms = Math.max(0, Number(baseMs || 0));
    if (!playbackActive) return ms;
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
  };
})();

window.PlaybackInterpolationController = PlaybackInterpolationController;
