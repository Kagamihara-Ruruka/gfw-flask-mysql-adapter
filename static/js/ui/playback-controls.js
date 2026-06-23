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
  const hasDates = dates.length > 0 && state.dataLayer === "gfw";
  const current = $("date").value;
  const index = dates.indexOf(current);
  $("single-date-label").textContent = state.dataLayer === "gfw"
    ? "GFW Date"
    : state.dataLayer === "ais"
      ? "AIS Live"
      : "No primary layer";
  $("date").disabled = state.dataLayer !== "gfw" || state.availableDates.length === 0;
  $("start-date").disabled = state.dataLayer !== "gfw" || state.availableDates.length === 0;
  $("end-date").disabled = state.dataLayer !== "gfw" || state.availableDates.length === 0;
  $("prev-day").disabled = !hasDates || index <= 0;
  $("next-day").disabled = !hasDates || index < 0 || index >= dates.length - 1;
  $("replay").disabled = !hasDates;
  $("play-toggle").disabled = !hasDates || dates.length <= 1;
  $("play-toggle").textContent = state.isPlaying ? "Pause" : "Play";
  $("play-toggle").title = state.isPlaying ? "Pause" : "Play";
}

function stopPlayback() {
  state.isPlaying = false;
  clearInterval(state.playTimer);
  state.playTimer = null;
  updatePlaybackControls();
}

function stepDay(delta) {
  const dates = datesInSelectedRange();
  const index = dates.indexOf($("date").value);
  if (index < 0) {
    const next = clampDateToSelectedRange($("date").value);
    if (!next) return false;
    $("date").value = next;
    updatePlaybackControls();
    reloadActiveLayer();
    return true;
  }
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= dates.length) {
    return false;
  }
  $("date").value = dates[nextIndex];
  updatePlaybackControls();
  reloadActiveLayer();
  return true;
}

function setPlayback(active) {
  if (!active) {
    stopPlayback();
    return;
  }
  state.isPlaying = true;
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
  updatePlaybackControls();
  clearInterval(state.playTimer);
  state.playTimer = setInterval(() => {
    if (!stepDay(1)) {
      stopPlayback();
    }
  }, state.playIntervalMs);
}

function normalizeDateInputs({ reload = true } = {}) {
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
    reloadActiveLayer();
  }
}

function updatePlaybackSpeed() {
  state.playIntervalMs = Number($("play-speed").value || state.playIntervalMs);
  if (state.isPlaying) {
    setPlayback(true);
  }
}

function replayFromStart() {
  const dates = datesInSelectedRange();
  if (!dates.length) return;
  stopPlayback();
  $("date").value = dates[0];
  updatePlaybackControls();
  reloadActiveLayer();
}
