const TIME_CONTROL_LAYER_IDS = new Set(["gfw"]);
const PLAYBACK_CONTROL_IDS = ["latest-date", "replay", "prev-day", "play-toggle", "next-day"];

function syncPlayToggleIcon() {
  if (state.isPlaying) {
    ControlButtons.setIcon("play-toggle", "pause", "II", "Pause");
    return;
  }
  ControlButtons.setIcon("play-toggle", "play", ">", "Play");
}

function bindPlaybackControlFeedback() {
  ControlButtons.bindFeedback(PLAYBACK_CONTROL_IDS);
}

function selectedLayerIds() {
  const ids = [];
  if (state.dataLayer) {
    ids.push(state.dataLayer);
  }
  if ($("eez-toggle")?.checked) {
    ids.push("eez");
  }
  return ids;
}

function hasSelectedTimeControlLayer() {
  return selectedLayerIds().some((layerId) => TIME_CONTROL_LAYER_IDS.has(layerId));
}

function setAvailableDates(dates) {
  state.availableDates = [...dates].sort();
  const first = state.availableDates[0] || "";
  const last = state.availableDates[state.availableDates.length - 1] || "";
  for (const id of ["start-date", "end-date", "date"]) {
    $(id).min = first;
    $(id).max = last;
    $(id).disabled = state.availableDates.length === 0;
  }
  $("start-date").value = first;
  $("end-date").value = last;
  $("date").value = first;
  updatePlaybackControls();
}

function datesInSelectedRange() {
  if (!state.availableDates.length) return [];
  let start = $("start-date").value || state.availableDates[0];
  let end = $("end-date").value || state.availableDates[state.availableDates.length - 1];
  if (start > end) {
    [start, end] = [end, start];
  }
  return state.availableDates.filter((date) => date >= start && date <= end);
}

function clampDateToSelectedRange(value) {
  const dates = datesInSelectedRange();
  if (!dates.length) return "";
  if (!value || value <= dates[0]) return dates[0];
  if (value >= dates[dates.length - 1]) return dates[dates.length - 1];
  if (dates.includes(value)) return value;
  return dates.find((date) => date >= value) || dates[dates.length - 1];
}

function updatePlaybackControls() {
  const dates = datesInSelectedRange();
  const hasTimeControlLayer = hasSelectedTimeControlLayer();
  const singleDateEnabled = hasTimeControlLayer && state.availableDates.length > 0;
  const timeSequenceEnabled = hasTimeControlLayer && dates.length > 0;
  const current = $("date").value;
  const index = dates.indexOf(current);
  const singleDateControl = $("single-date-control");
  const timeSequence = document.querySelector(".time-sequence");
  $("single-date-label").textContent = hasTimeControlLayer
    ? "Date"
    : state.dataLayer === "ais"
      ? "AIS Live"
      : "No dated layer";
  $("date").disabled = !singleDateEnabled;
  $("latest-date").disabled = !singleDateEnabled;
  if (singleDateControl) {
    singleDateControl.classList.toggle("is-disabled", !singleDateEnabled);
    singleDateControl.setAttribute("aria-disabled", String(!singleDateEnabled));
  }
  $("start-date").disabled = !timeSequenceEnabled;
  $("end-date").disabled = !timeSequenceEnabled;
  $("prev-day").disabled = !timeSequenceEnabled || index <= 0;
  $("next-day").disabled = !timeSequenceEnabled || index < 0 || index >= dates.length - 1;
  $("replay").disabled = !timeSequenceEnabled;
  $("play-toggle").disabled = !timeSequenceEnabled || dates.length <= 1;
  $("play-speed").disabled = !timeSequenceEnabled || dates.length <= 1;
  if (timeSequence) {
    timeSequence.classList.toggle("is-disabled", !timeSequenceEnabled);
    timeSequence.setAttribute("aria-disabled", String(!timeSequenceEnabled));
  }
  syncPlayToggleIcon();
}

function stopPlayback() {
  state.isPlaying = false;
  clearTimeout(state.playTimer);
  state.playTimer = null;
  updatePlaybackControls();
}

async function stepDay(delta) {
  const dates = datesInSelectedRange();
  const index = dates.indexOf($("date").value);
  if (index < 0) {
    const next = clampDateToSelectedRange($("date").value);
    if (!next) return false;
    $("date").value = next;
    updatePlaybackControls();
    await reloadActiveLayer();
    return true;
  }
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= dates.length) {
    return false;
  }
  $("date").value = dates[nextIndex];
  updatePlaybackControls();
  await reloadActiveLayer();
  return true;
}

async function preparePlaybackStart() {
  const dates = datesInSelectedRange();
  if (dates.length <= 1) return false;
  const current = $("date").value;
  const index = dates.indexOf(current);
  if (index < 0 || index >= dates.length - 1) {
    $("date").value = dates[0];
    updatePlaybackControls();
    await reloadActiveLayer();
  }
  return true;
}

async function advancePlaybackDay() {
  const dates = datesInSelectedRange();
  const index = dates.indexOf($("date").value);
  if (index < 0 || index >= dates.length - 1) {
    return false;
  }
  $("date").value = dates[index + 1];
  updatePlaybackControls();
  await reloadActiveLayer();
  return true;
}

function schedulePlaybackTick() {
  clearTimeout(state.playTimer);
  state.playTimer = setTimeout(async () => {
    if (!state.isPlaying) return;
    try {
      const advanced = await advancePlaybackDay();
      if (!advanced) {
        stopPlayback();
        return;
      }
      if (state.isPlaying) {
        schedulePlaybackTick();
      }
    } catch (err) {
      stopPlayback();
      setStatus(err.message, true);
    }
  }, state.playIntervalMs);
}

async function setPlayback(active) {
  if (!active) {
    stopPlayback();
    return;
  }
  if (!(await preparePlaybackStart())) {
    stopPlayback();
    return;
  }
  state.isPlaying = true;
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
  updatePlaybackControls();
  schedulePlaybackTick();
}

async function normalizeDateInputs({ reload = true } = {}) {
  const dates = datesInSelectedRange();
  if (!dates.length) {
    stopPlayback();
    return;
  }
  const next = clampDateToSelectedRange($("date").value);
  if (next !== $("date").value) {
    $("date").value = next;
  }
  updatePlaybackControls();
  if (reload) {
    await reloadActiveLayer();
  }
}

function updatePlaybackSpeed() {
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
  if (state.isPlaying) {
    setPlayback(true);
  }
}

async function replayFromStart() {
  const dates = datesInSelectedRange();
  if (!dates.length) return;
  stopPlayback();
  $("date").value = dates[0];
  updatePlaybackControls();
  await reloadActiveLayer();
}

async function jumpToLatestDate() {
  if (!hasSelectedTimeControlLayer() || !state.availableDates.length) return;
  stopPlayback();
  $("date").value = state.availableDates[state.availableDates.length - 1];
  updatePlaybackControls();
  await reloadActiveLayer();
}
