const GfwLayerEffects = (() => {
  function transitionMs(targetState) {
    const baseMs = Math.max(0, Number(targetState.gfwTransitionMs || 0));
    if (typeof PlaybackInterpolationController !== "undefined") {
      return PlaybackInterpolationController.playbackTransitionMs(targetState, baseMs);
    }
    return baseMs;
  }

  function blurPx(targetState) {
    return Math.max(0, Number(targetState.gfwZoomBlurPx || 0));
  }

  function layerElement(layer) {
    return layer?._canvas || null;
  }

  function setPaneOpacity(targetMap, opacity) {
    const pane = targetMap.getPane("gfwPane");
    if (!pane) return;
    pane.style.opacity = String(opacity);
  }

  function syncTransitionStyle(targetMap, targetState) {
    const pane = targetMap.getPane("gfwPane");
    if (!pane) return;
    pane.style.opacity = "1";
    pane.style.transition = `filter ${transitionMs(targetState)}ms ease`;
  }

  function setLayerTransition(layer, targetState) {
    const element = layerElement(layer);
    if (!element) return;
    const ms = transitionMs(targetState);
    element.style.transition = `opacity ${ms}ms ease, filter ${ms}ms ease`;
  }

  function setLayerOpacity(layer, opacity) {
    const element = layerElement(layer);
    if (!element) return;
    element.style.opacity = String(opacity);
  }

  function setLayerBlur(layer, targetState, active) {
    const element = layerElement(layer);
    if (!element) return;
    const px = blurPx(targetState);
    element.style.filter = active && px > 0 ? `blur(${px}px)` : "";
  }

  function setPaneBlur(targetMap, targetState, active) {
    const pane = targetMap.getPane("gfwPane");
    if (!pane) return;
    const px = blurPx(targetState);
    pane.style.filter = active && px > 0 ? `blur(${px}px)` : "";
  }

  function fadeOut({ targetMap, targetState }) {
    if (!targetState.gridLayer || !targetMap.hasLayer(targetState.gridLayer)) return;
    syncTransitionStyle(targetMap, targetState);
    setLayerTransition(targetState.gridLayer, targetState);
    setLayerBlur(targetState.gridLayer, targetState, true);
  }

  function waitTransition(targetState) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, transitionMs(targetState));
    });
  }

  function reveal({ targetMap, targetState }) {
    setPaneBlur(targetMap, targetState, false);
    setPaneOpacity(targetMap, 1);
    setLayerBlur(targetState.gridLayer, targetState, false);
    setLayerOpacity(targetState.gridLayer, 1);
  }

  function removeRetiredLayer({ targetMap, targetState, layer }) {
    if (!layer) return;
    if (targetMap.hasLayer(layer)) {
      targetMap.removeLayer(layer);
    }
    if (Array.isArray(targetState.gfwRetiringLayers)) {
      targetState.gfwRetiringLayers = targetState.gfwRetiringLayers.filter((item) => item !== layer);
    }
  }

  function removeRetiredLayers({ targetMap, targetState }) {
    const retiring = Array.isArray(targetState.gfwRetiringLayers) ? [...targetState.gfwRetiringLayers] : [];
    for (const layer of retiring) {
      removeRetiredLayer({ targetMap, targetState, layer });
    }
  }

  function crossfade({ targetMap, targetState, previousLayer, nextLayer }) {
    syncTransitionStyle(targetMap, targetState);
    setPaneBlur(targetMap, targetState, false);
    setPaneOpacity(targetMap, 1);
    setLayerTransition(nextLayer, targetState);
    setLayerBlur(nextLayer, targetState, false);

    if (!previousLayer || previousLayer === nextLayer || !targetMap.hasLayer(previousLayer)) {
      setLayerOpacity(nextLayer, 1);
      return;
    }

    setLayerTransition(previousLayer, targetState);
    setLayerBlur(previousLayer, targetState, false);
    setLayerOpacity(nextLayer, 0);
    targetState.gfwRetiringLayers = targetState.gfwRetiringLayers || [];
    targetState.gfwRetiringLayers.push(previousLayer);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setLayerOpacity(nextLayer, 1);
        setLayerOpacity(previousLayer, 0);
      });
    });

    window.setTimeout(() => {
      if (targetState.gridLayer !== previousLayer) {
        removeRetiredLayer({ targetMap, targetState, layer: previousLayer });
      }
    }, transitionMs(targetState) + 80);
  }

  return {
    crossfade,
    fadeOut,
    layerElement,
    removeRetiredLayer,
    removeRetiredLayers,
    reveal,
    setLayerBlur,
    setLayerOpacity,
    setLayerTransition,
    setPaneBlur,
    setPaneOpacity,
    syncTransitionStyle,
    transitionMs,
    waitTransition,
  };
})();

window.GfwLayerEffects = GfwLayerEffects;
