const FULLSCREEN_PLAYBACK_CONTROL_IDS = [
  "fs-replay",
  "fs-prev-day",
  "fs-play-toggle",
  "fs-next-day",
];

function syncFullscreenPlayToggleIcon() {
  if (state.isPlaying) {
    ControlButtons.setIcon("fs-play-toggle", "pause", "II", "暫停");
    return;
  }
  ControlButtons.setIcon("fs-play-toggle", "play", ">", "播放");
}

function syncFullscreenStaticIcons() {
  ControlButtons.setIcon("fs-replay", "rotate-ccw", "↺", "回到開始日期");
  ControlButtons.setIcon("fs-prev-day", "skip-back", "‹", "往前一日");
  ControlButtons.setIcon("fs-next-day", "skip-forward", "›", "往後一日");
  syncFullscreenPlayToggleIcon();
}

function syncFullscreenPlaybackControls() {
  const valuePairs = [
    ["date", "fs-date"],
    ["start-date", "fs-start-date"],
    ["end-date", "fs-end-date"],
    ["play-speed", "fs-play-speed"],
  ];
  for (const [sourceId, targetId] of valuePairs) {
    const source = $(sourceId);
    const target = $(targetId);
    if (!source || !target) continue;
    target.value = source.value;
    target.disabled = source.disabled;
    if ("min" in source) target.min = source.min;
    if ("max" in source) target.max = source.max;
  }

  const disabledPairs = [
    ["replay", "fs-replay"],
    ["prev-day", "fs-prev-day"],
    ["play-toggle", "fs-play-toggle"],
    ["next-day", "fs-next-day"],
  ];
  for (const [sourceId, targetId] of disabledPairs) {
    const source = $(sourceId);
    const target = $(targetId);
    if (!source || !target) continue;
    target.disabled = source.disabled;
  }
}

function syncFullscreenPlaybackHud() {
  const hud = $("fullscreen-playback-hud");
  if (!hud) return;
  const hasTimeControlLayer = hasSelectedTimeControlLayer();
  if (hasTimeControlLayer) {
    hud.textContent = `快照：${$("date").value || "--"}`;
    hud.classList.toggle("is-live", false);
    return;
  }
  if (state.dataLayer === "ais") {
    hud.textContent = "AIS 即時模式";
    hud.classList.toggle("is-live", true);
    return;
  }
  hud.textContent = "未選擇時間資料";
  hud.classList.toggle("is-live", false);
}

function bindFullscreenPlaybackControls() {
  syncFullscreenStaticIcons();
  ControlButtons.bindFeedback(FULLSCREEN_PLAYBACK_CONTROL_IDS);
  $("fs-date")?.addEventListener("change", () => {
    $("date").value = $("fs-date").value;
    normalizeDateInputs().catch((err) => setStatus(err.message, true));
  });
  $("fs-start-date")?.addEventListener("change", () => {
    $("start-date").value = $("fs-start-date").value;
    normalizeDateInputs().catch((err) => setStatus(err.message, true));
  });
  $("fs-end-date")?.addEventListener("change", () => {
    $("end-date").value = $("fs-end-date").value;
    normalizeDateInputs().catch((err) => setStatus(err.message, true));
  });
  $("fs-replay")?.addEventListener("click", () => replayFromStart().catch((err) => setStatus(err.message, true)));
  $("fs-prev-day")?.addEventListener("click", () => {
    stopPlayback();
    stepDay(-1, "全螢幕往前一日").catch((err) => setStatus(err.message, true));
  });
  $("fs-next-day")?.addEventListener("click", () => {
    stopPlayback();
    stepDay(1, "全螢幕往後一日").catch((err) => setStatus(err.message, true));
  });
  $("fs-play-toggle")?.addEventListener("click", () => setPlayback(!state.isPlaying).catch((err) => setStatus(err.message, true)));
  $("fs-play-speed")?.addEventListener("change", () => updatePlaybackSpeed("fs-play-speed"));
  syncFullscreenPlaybackControls();
  syncFullscreenPlaybackHud();
}

window.bindFullscreenPlaybackControls = bindFullscreenPlaybackControls;
window.syncFullscreenPlaybackControls = syncFullscreenPlaybackControls;
window.syncFullscreenPlaybackHud = syncFullscreenPlaybackHud;
window.syncFullscreenPlayToggleIcon = syncFullscreenPlayToggleIcon;
window.syncFullscreenStaticIcons = syncFullscreenStaticIcons;
