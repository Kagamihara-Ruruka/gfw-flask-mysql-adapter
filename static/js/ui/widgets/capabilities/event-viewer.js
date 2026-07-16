(() => {
const { DashboardWidget } = window.WidgetCore;
const { lineChartEscape } = window.WidgetCapabilityShared;

class LifecycleEventViewerWidget extends DashboardWidget {
  constructor(options) {
    super(options);
    this.filters = { runId: "", dataset: "", type: "" };
    this.bindings = new Set();
    this.bindingByContainer = new WeakMap();
  }

  eventLog() {
    return this.services.eventLog || null;
  }

  allEvents() {
    return this.eventLog()?.query?.({}) || [];
  }

  runIds(events) {
    return [...new Set(events.map((event) => event.run_id).filter(Boolean))].reverse();
  }

  datasets(events) {
    return [...new Set(events.map((event) => event.dataset || event.dataset_id).filter(Boolean))].sort();
  }

  eventTypes(events) {
    return [...new Set(events.map((event) => event.type).filter(Boolean))].sort();
  }

  activeRunId(events) {
    const runs = this.runIds(events);
    if (this.filters.runId && runs.includes(this.filters.runId)) return this.filters.runId;
    return this.eventLog()?.currentRunId?.() || runs[0] || "";
  }

  model({ expanded = false } = {}) {
    const eventLog = this.eventLog();
    const allEvents = expanded ? this.allEvents() : [];
    const filteredRunEvent = !expanded && this.filters.runId
      ? eventLog?.latest?.({ run_id: this.filters.runId })
      : null;
    const latestEvent = expanded ? allEvents[allEvents.length - 1] : eventLog?.latest?.({});
    const runId = expanded
      ? this.activeRunId(allEvents)
      : String(filteredRunEvent?.run_id || eventLog?.currentRunId?.() || latestEvent?.run_id || "");
    const filter = {
      ...(runId ? { run_id: runId } : {}),
      ...(this.filters.dataset ? { dataset: this.filters.dataset } : {}),
      ...(this.filters.type ? { type: this.filters.type } : {}),
      limit: expanded ? 250 : 8,
    };
    const events = eventLog?.query?.(filter) || [];
    const summary = eventLog?.summary?.(runId) || {};
    const trustedMetrics = this.services.runtimeMetricsProvider?.(runId) || {};
    const runStart = expanded
      ? allEvents.find((event) => !runId || event.run_id === runId)
      : eventLog?.latest?.({ ...(runId ? { run_id: runId } : {}), type: "RUN_STARTED" });
    return {
      allEvents,
      datasets: expanded ? this.datasets(allEvents) : [],
      eventTypes: expanded ? this.eventTypes(allEvents) : [],
      events,
      expanded,
      runId,
      runIds: expanded ? this.runIds(allEvents) : [],
      summary,
      trustedMetrics,
      baseMonotonicMs: Number(runStart?.monotonic_ms || events[0]?.monotonic_ms || 0),
    };
  }

  formatDuration(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return "-";
    return numeric >= 1000 ? `${(numeric / 1000).toFixed(2)} s` : `${numeric.toFixed(1)} ms`;
  }

  formatPercent(value) {
    const numeric = Number(value || 0);
    return `${Math.max(0, numeric * 100).toFixed(1)}%`;
  }

  eventTone(type) {
    if (/FAILED|ERROR/.test(type)) return "error";
    if (/BUFFER_ENTERED|MISS/.test(type)) return "warning";
    if (/READY|VISIBLE|HIT|RESUMED|FINISHED/.test(type)) return "success";
    if (/QUEUED|FETCHING|STARTED|DISPATCHED/.test(type)) return "active";
    return "neutral";
  }

  relativeTime(event, model) {
    const delta = Math.max(0, Number(event.monotonic_ms || 0) - Number(model.baseMonotonicMs || 0));
    if (!delta) return "+0 ms";
    return `+${this.formatDuration(delta)}`;
  }

  eventDetail(event) {
    if (event.type === "WATERMARK_POLICY_CHANGED") {
      return [
        event.strategy || "watermark",
        `低 ${Number(event.low_watermark || 0)} / 高 ${Number(event.high_watermark || 0)}`,
        `啟動 ${Number(event.startup_watermark || 0)} / 恢復 ${Number(event.resume_watermark || 0)}`,
        event.reason || "",
        event.degradation_reason || "",
      ].filter(Boolean).join(" · ");
    }
    if (event.type === "WATERMARK_POLICY_RESET") {
      return `水位策略重設 · ${event.reason || "configuration_changed"}`;
    }
    if (/^PREPARE_/.test(event.type)) {
      return [
        event.dataset || "",
        event.date || "",
        `${Number(event.ready_slices || 0)} / ${Number(event.required_slices || 0)} 張`,
        event.duration_ms ? this.formatDuration(event.duration_ms) : "",
        event.degradation_reason || "",
      ].filter(Boolean).join(" · ");
    }
    if (/^BUFFER_(ENTERED|RESUMED)$/.test(event.type)) {
      return [
        event.dataset || "",
        event.date || "",
        `${Number(event.ready_slices || 0)} / ${Number(event.required_slices || 0)} 張`,
        event.duration_ms ? this.formatDuration(event.duration_ms) : "",
        event.degradation_reason || "",
      ].filter(Boolean).join(" · ");
    }
    if (event.type === "MAP_RELOAD_REQUESTED") {
      return [
        event.dataset || "",
        event.date || "",
        event.reason || "unspecified",
      ].filter(Boolean).join(" · ");
    }
    if (["RUN_FINISHED", "PREHEATER_STOPPED", "QUERY_SCOPE_CANCELLED"].includes(event.type)) {
      return [
        event.dataset || event.dataset_id || "",
        event.date || "",
        event.reason || "unspecified",
      ].filter(Boolean).join(" · ");
    }
    return [
      event.dataset || event.dataset_id || "",
      event.date || "",
      event.lane || "",
      event.duration_ms ? this.formatDuration(event.duration_ms) : "",
    ].filter(Boolean).join(" · ") || "系統事件";
  }

  renderCompact(container, model) {
    const latest = model.events[model.events.length - 1];
    const summary = model.summary;
    const events = model.events.slice(-4).reverse();
    container.innerHTML = `
      <div class="event-viewer-compact-head">
        <span><i data-lucide="activity" aria-hidden="true"></i>${lineChartEscape(latest?.type || "等待事件")}</span>
        <strong>${Number(summary.eventCount || 0).toLocaleString()}</strong>
      </div>
      <div class="event-viewer-compact-metrics">
        <span><b>${Number(summary.stallCount || 0)}</b><em>停頓</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.maxStallMs))}</b><em>最長</em></span>
        <span><b>${lineChartEscape(this.formatPercent(summary.stallRatio))}</b><em>占比</em></span>
      </div>
      <div class="event-viewer-mini-timeline" aria-label="最近生命週期事件">
        ${events.map((event) => `
          <span data-tone="${this.eventTone(event.type)}">
            <i></i><b>${lineChartEscape(event.type)}</b><em>${lineChartEscape(event.date || event.lane || "")}</em>
          </span>
        `).join("") || "<p>尚無播放或查詢事件</p>"}
      </div>
    `;
  }

  optionList(values, selected, emptyLabel) {
    return [
      `<option value="">${lineChartEscape(emptyLabel)}</option>`,
      ...values.map((value) => `<option value="${lineChartEscape(value)}" ${value === selected ? "selected" : ""}>${lineChartEscape(value)}</option>`),
    ].join("");
  }

  renderExpandedContent(container, model) {
    const summary = model.summary;
    const trusted = model.trustedMetrics || {};
    container.innerHTML = `
      <div class="event-viewer-toolbar" data-widget-interactive="1">
        <label><span>Run</span><select data-event-filter="run">${this.optionList(model.runIds, model.runId, "全部")}</select></label>
        <label><span>資料集</span><select data-event-filter="dataset">${this.optionList(model.datasets, this.filters.dataset, "全部")}</select></label>
        <label><span>事件</span><select data-event-filter="type">${this.optionList(model.eventTypes, this.filters.type, "全部")}</select></label>
        <button type="button" class="event-viewer-export" data-event-export title="匯出目前 Run 的 JSON" aria-label="匯出目前 Run 的 JSON">
          <i data-lucide="download" aria-hidden="true"></i>
        </button>
      </div>
      <div class="event-viewer-summary-grid">
        <span><b>${Number(summary.frameCount || 0)}</b><em>可見影格</em></span>
        <span><b>${Number(summary.stallCount || 0)}</b><em>停頓次數</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.totalStallMs))}</b><em>累積停頓</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.maxStallMs))}</b><em>最長停頓</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.cadenceP95Ms))}</b><em>Cadence P95</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.clickToFirstFrameMs))}</b><em>首張體感</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.phases?.queue?.p95Ms))}</b><em>Queue P95</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.phases?.network?.p95Ms))}</b><em>HTTP P95</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.phases?.cacheCommit?.p95Ms))}</b><em>Cache P95</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.phases?.render?.p95Ms))}</b><em>Render P95</em></span>
        <span><b>${Number(summary.maxQueueDepth || 0)}</b><em>最大 Queue</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.targetToVisibleP95Ms))}</b><em>目標至可見 P95</em></span>
        <span><b>${lineChartEscape(this.formatDuration(summary.phases?.preparation?.p95Ms))}</b><em>啟動準備 P95</em></span>
        <span><b>${Number(trusted.consumption_rate || 0).toFixed(2)} /s</b><em>消耗率</em></span>
        <span><b>${Number(trusted.supply_rate || 0).toFixed(2)} /s</b><em>補給率</em></span>
        <span><b>${lineChartEscape(this.formatDuration(trusted.cache_ready_latency_p95))}</b><em>Cache Ready P95</em></span>
        <span><b>${Number(trusted.ready_ahead_slices || 0)}</b><em>前方影格</em></span>
        <span><b>${Number(trusted.ready_ahead_seconds || 0).toFixed(1)} s</b><em>前方秒數</em></span>
        <span><b>${Number(trusted.watermark_policy?.low_watermark || 0)} / ${Number(trusted.watermark_policy?.high_watermark || 0)}</b><em>有效水位</em></span>
        <span><b>${Number(trusted.watermark_policy?.startup_watermark || 0)} / ${Number(trusted.watermark_policy?.resume_watermark || 0)}</b><em>啟動 / 恢復</em></span>
        <span><b>${lineChartEscape(trusted.watermark_policy?.status || "-")}</b><em>水位策略</em></span>
        <span><b>${lineChartEscape(trusted.watermark_policy?.degradation_reason || "-")}</b><em>降級原因</em></span>
      </div>
      <div class="event-viewer-table-wrap" data-widget-interactive="1">
        <table class="event-viewer-table">
          <thead><tr><th>相對時間</th><th>事件</th><th>內容</th><th>Queue</th></tr></thead>
          <tbody>
            ${model.events.slice().reverse().map((event) => `
              <tr data-tone="${this.eventTone(event.type)}">
                <td>${lineChartEscape(this.relativeTime(event, model))}</td>
                <td><i></i><strong>${lineChartEscape(event.type)}</strong></td>
                <td title="${lineChartEscape(this.eventDetail(event))}">${lineChartEscape(this.eventDetail(event))}</td>
                <td>${Number.isFinite(Number(event.queue_depth)) ? Number(event.queue_depth) : "-"}</td>
              </tr>
            `).join("") || "<tr><td colspan=\"4\" class=\"event-viewer-empty\">目前篩選沒有事件</td></tr>"}
          </tbody>
        </table>
      </div>
    `;
    this.bindControls(container, model);
  }

  bindControls(container, model) {
    container.querySelectorAll("[data-event-filter]").forEach((select) => {
      select.addEventListener("change", (event) => {
        event.stopPropagation();
        const kind = select.dataset.eventFilter;
        if (kind === "run") this.filters.runId = select.value;
        if (kind === "dataset") this.filters.dataset = select.value;
        if (kind === "type") this.filters.type = select.value;
        this.renderInto(container, { expanded: true });
      });
    });
    container.querySelector("[data-event-export]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.exportRun(model.runId);
    });
  }

  exportRun(runId) {
    const content = this.eventLog()?.exportRun?.(runId);
    if (!content || typeof Blob === "undefined" || typeof URL === "undefined") return;
    const href = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = `lifecycle-${runId || "all"}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }

  renderInto(container, { expanded = false } = {}) {
    if (!container) return;
    container.classList.add("widget-template", "widget-template-event-viewer");
    container.classList.toggle("is-expanded", expanded);
    const model = this.model({ expanded });
    if (expanded) this.renderExpandedContent(container, model);
    else this.renderCompact(container, model);
    window.lucide?.createIcons?.({
      attrs: { "stroke-width": 1.8 },
      nodes: container.querySelectorAll("[data-lucide]"),
    });
  }

  removeBinding(binding) {
    if (!binding) return;
    this.services.cancelSchedule?.(binding.timer);
    binding.timer = 0;
    binding.unsubscribe?.();
    this.bindings.delete(binding);
    this.bindingByContainer.delete(binding.container);
  }

  scheduleBindingRender(binding) {
    if (!binding || binding.timer) return;
    const delay = binding.expanded ? 500 : 750;
    binding.timer = this.services.schedule?.(() => {
      binding.timer = 0;
      const { container } = binding;
      if (!container.isConnected) {
        if (binding.connectedOnce) this.removeBinding(binding);
        return;
      }
      binding.connectedOnce = true;
      this.renderInto(container, { expanded: binding.expanded });
    }, delay) || 0;
  }

  bindLog(container, expanded) {
    const existing = this.bindingByContainer.get(container);
    if (existing) {
      existing.expanded = expanded;
      return;
    }
    const binding = { container, expanded, connectedOnce: false, unsubscribe: null, timer: 0 };
    binding.unsubscribe = this.eventLog()?.subscribe?.(() => {
      if (container.isConnected) binding.connectedOnce = true;
      if (!container.isConnected && binding.connectedOnce) {
        this.removeBinding(binding);
        return;
      }
      if (container.isConnected) this.scheduleBindingRender(binding);
    }, { emitCurrent: false });
    this.bindings.add(binding);
    this.bindingByContainer.set(container, binding);
  }

  renderTemplate(container, { expanded = false } = {}) {
    this.renderInto(container, { expanded });
    this.bindLog(container, expanded);
  }

  renderCapabilitySettings({ pane }) {
    const section = document.createElement("section");
    section.className = "widget-query-settings event-viewer-settings";
    const heading = document.createElement("h4");
    heading.textContent = "事件篩選";
    const note = document.createElement("p");
    note.textContent = "展開 Widget 後可依 Run、資料集與事件類型檢閱；此工具只讀取 LifecycleEventLog。";
    section.append(heading, note);
    pane.append(section);
  }
}

Object.assign(window.WidgetCapabilities ||= {}, { LifecycleEventViewerWidget });
})();
