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

  function recordBuffering({ date, state = "fetching", ready = 0, required = 1, attempts = 1 }) {
    record({
      label: "Frame buffer",
      text: `buffering ${date || "snapshot"} · ${state} · ${ready} / ${required} · #${attempts}`,
      status: "pending",
      source: "buffer",
    });
  }

  function recordBufferResumed({ date, waitMs = null, ready = 1, required = 1 }) {
    const waited = Number.isFinite(Number(waitMs)) ? ` · 等待 ${Math.round(Number(waitMs))} ms` : "";
    record({
      label: "Frame buffer",
      text: `resumed ${date || "snapshot"} · ${ready} / ${required}${waited}`,
      status: "ok",
      source: "resume",
    });
  }

  function recordBufferFailed({ date, state = "failed" }) {
    record({
      label: "Frame buffer",
      text: `failed ${date || "snapshot"} · ${state}`,
      status: "error",
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
    recordBufferFailed,
    recordBufferResumed,
    recordBuffering,
    recordFrameFallback,
    recordFrameShown,
    recordStop,
    recordTimelineStart,
  };
})();

window.PlaybackTelemetry = PlaybackTelemetry;
