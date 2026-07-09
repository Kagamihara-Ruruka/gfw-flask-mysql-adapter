const PlaybackRenderer = (() => {
  async function showDate({
    date,
    dateInput,
    updateControls,
    reloadActiveLayer,
    afterRender = null,
  }) {
    if (!date || !dateInput) return false;
    dateInput.value = date;
    updateControls?.();
    await reloadActiveLayer?.();
    afterRender?.({ date });
    return true;
  }

  async function showDateIndex({
    dates,
    targetIndex,
    dateInput,
    updateControls,
    reloadActiveLayer,
    afterRender = null,
  }) {
    return showDate({
      date: dates?.[targetIndex] || "",
      dateInput,
      updateControls,
      reloadActiveLayer,
      afterRender,
    });
  }

  return {
    showDate,
    showDateIndex,
  };
})();

window.PlaybackRenderer = PlaybackRenderer;
