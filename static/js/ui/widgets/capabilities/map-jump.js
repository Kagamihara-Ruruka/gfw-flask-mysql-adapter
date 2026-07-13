(() => {
const { DashboardWidget, bindWidgetActionButton } = window.WidgetCore;
class MapJumpWidget extends DashboardWidget {
  handlePrimaryAction() {}

  viewActions() {
    return [
      { id: "reset", label: "重設" },
      { id: "world", label: "世界" },
      { id: "taiwan", label: "台灣" },
    ];
  }

  runViewAction(action) {
    if (!action?.id) return false;
    window.dispatchEvent(new CustomEvent("rrkal:map-view-action", {
      detail: { id: action.id },
    }));
    return true;
  }

  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-map-jump");
    if (expanded) container.classList.add("is-expanded");
    container.innerHTML = `
      <div class="widget-map-mini" aria-label="地圖窗格預覽">
        <svg class="widget-map-preview-svg widget-map-marker-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <path class="widget-map-marker-ground" d="M18 16.0156C19.2447 16.5445 20 17.2392 20 18C20 19.6568 16.4183 21 12 21C7.58172 21 4 19.6568 4 18C4 17.2392 4.75527 16.5445 6 16.0156" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>
          <path class="widget-map-marker-pin" d="M17 8.44444C17 11.5372 12 17 12 17C12 17 7 11.5372 7 8.44444C7 5.35165 9.23858 3 12 3C14.7614 3 17 5.35165 17 8.44444Z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>
          <circle class="widget-map-marker-dot" cx="12" cy="8" r="1" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></circle>
        </svg>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "widget-map-jump-actions";
    actions.setAttribute("aria-label", "視角跳轉");
    for (const action of this.viewActions()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "widget-map-jump-button";
      button.dataset.mapJumpView = action.id;
      button.textContent = action.label;
      bindWidgetActionButton(button, () => this.runViewAction(action));
      actions.append(button);
    }
    container.append(actions);
  }
}


Object.assign(window.WidgetCapabilities ||= {}, { MapJumpWidget });
})();
