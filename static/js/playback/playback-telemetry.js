const PlaybackTelemetry = (() => {
  function record(event) {
    if (typeof TimingMetrics === "undefined") return;
    TimingMetrics.recordPlaybackEvent?.(event);
  }

  function stepModeLabel(mode) {
    return mode === "fluid" ? "流暢" : "逐張";
  }

  function recordTimelineStart({ rate, stepMode, intervalMs, deliveryPolicy = "", interpolationMode = "" }) {
    const delivery = deliveryPolicy ? `${deliveryPolicy} / ` : "";
    const interpolation = interpolationMode ? ` / ${interpolationMode}` : "";
    record({
      label: "播放時間軸",
      text: `${delivery}${stepModeLabel(stepMode)} / ${rate}x / ${Math.round(intervalMs)} ms${interpolation}`,
      status: "ok",
      source: "start",
      reset: true,
    });
  }

  function recordBuffering({ date }) {
    record({
      label: "Frame buffer",
      text: `等待 ${date || "snapshot"}`,
      status: "pending",
      source: "buffer",
    });
  }

  function recordFrameFallback({ targetDate, renderDate }) {
    record({
      label: "Frame buffer",
      text: `${renderDate || "-"} <= ${targetDate || "-"}`,
      status: "text",
      source: "nearest-ready",
    });
  }

  function recordFrameShown({ date }) {
    record({
      label: "顯示 snapshot",
      text: date || "-",
      status: "ok",
      source: "renderer",
    });
  }

  function recordStop({ date }) {
    record({
      label: "播放停止",
      text: date || "-",
      status: "idle",
      source: "timeline",
    });
  }

  return {
    record,
    recordBuffering,
    recordFrameFallback,
    recordFrameShown,
    recordStop,
    recordTimelineStart,
  };
})();

window.PlaybackTelemetry = PlaybackTelemetry;
