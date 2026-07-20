class PlaybackRendererController {
  constructor({ eventTarget } = {}) {
    if (!eventTarget?.dispatchEvent) throw new TypeError("PlaybackRenderer requires an event target");
    this.eventTarget = eventTarget;
    this.activeDate = "";
  }

  publishActiveDate(date, { source = "date_navigation" } = {}) {
    const nextDate = String(date || "").trim();
    if (!nextDate || nextDate === this.activeDate) return false;
    const previousDate = this.activeDate || null;
    this.activeDate = nextDate;
    this.eventTarget.dispatchEvent(new CustomEvent("rrkal:active-date-changed", {
      detail: { date: nextDate, previousDate, source },
    }));
    return true;
  }

  async showDate({
    date,
    dateInput,
    updateControls,
    reloadActiveLayer,
    afterRender = null,
    source = "date_navigation",
  }) {
    if (!date || !dateInput) return false;
    dateInput.value = date;
    updateControls?.();
    this.publishActiveDate(date, { source });
    const renderResult = await reloadActiveLayer?.();
    afterRender?.({ date });
    return renderResult === undefined ? true : renderResult;
  }

  async showDateIndex({
    dates,
    targetIndex,
    dateInput,
    updateControls,
    reloadActiveLayer,
    afterRender = null,
    source = "date_navigation",
  }) {
    return this.showDate({
      date: dates?.[targetIndex] || "",
      dateInput,
      updateControls,
      reloadActiveLayer,
      afterRender,
      source,
    });
  }

  snapshot() {
    return Object.freeze({ activeDate: this.activeDate });
  }

  dispose() {
    this.activeDate = "";
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.PlaybackRendererController = PlaybackRendererController;
}
