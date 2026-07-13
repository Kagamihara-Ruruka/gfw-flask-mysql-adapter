const WidgetLaunchpadLayout = Object.freeze({
  columns: 12,
  rows: 3,
  capacity: 36,
  pageAspect: Object.freeze({ width: 4, height: 1 }),
  swipeRatio: 0.12,
  edgePageRatio: 0.06,
  pageCooldownMs: 420,
});

class AbilityAppIcon {
  constructor({ item, panel, launchpad, position }) {
    this.item = item;
    this.panel = panel;
    this.launchpad = launchpad;
    this.position = position;
  }

  displayTitle() {
    return this.item.kind === "size" ? `空白 ${this.item.size}` : this.item.title;
  }

  fallbackText() {
    return this.item.kind === "size" ? this.item.size : this.item.title.slice(0, 1);
  }

  render() {
    const app = document.createElement("article");
    app.className = "widget-launchpad-app";
    app.dataset.launchpadAbilityId = this.item.id;
    app.dataset.launchpadTone = this.item.tone;
    app.dataset.launchpadPage = String(this.position.page);
    app.dataset.launchpadRow = String(this.position.row);
    app.dataset.launchpadColumn = String(this.position.column);
    app.dataset.widgetSize = this.item.size;
    app.title = this.item.description;
    app.style.gridColumnStart = String(this.position.column + 1);
    app.style.gridRowStart = String(this.position.row + 1);

    const iconSurface = document.createElement("div");
    iconSurface.className = "widget-launchpad-app-icon";

    const fallback = document.createElement("span");
    fallback.className = "control-icon-fallback widget-launchpad-app-fallback";
    fallback.setAttribute("aria-hidden", "true");
    fallback.textContent = this.fallbackText();

    const icon = document.createElement("i");
    icon.className = "control-icon widget-launchpad-lucide-icon";
    icon.dataset.lucide = this.item.icon;
    icon.setAttribute("aria-hidden", "true");
    iconSurface.append(fallback, icon);

    const label = document.createElement("span");
    label.className = "widget-launchpad-app-label";
    label.textContent = this.displayTitle();

    app.append(iconSurface, label);
    bindWidgetPointerBehavior(app, {
      onPrimary: () => this.panel.activateCatalogItem(this.item),
    });
    if (this.item.draggable) {
      bindWidgetDragBehavior(app, {
        kind: "catalog",
        onDragStart: () => {
          this.launchpad.beginAppDrag();
          this.panel.beginCatalogDrag(this.item);
        },
        onDragMove: (event) => {
          this.launchpad.updateAppDrag(event);
          this.panel.updateCatalogDragAtPoint(this.item, event.clientX, event.clientY);
        },
        onDrop: (event) => this.panel.dropCatalogItemAtPoint(this.item, event.clientX, event.clientY),
        onDragEnd: () => {
          this.panel.endCatalogDrag();
          this.launchpad.endAppDrag();
        },
      });
    }
    return app;
  }
}

class AbilityPage {
  constructor({ index, items, layout, panel, launchpad }) {
    this.index = index;
    this.items = items;
    this.layout = layout;
    this.panel = panel;
    this.launchpad = launchpad;
  }

  positionFor(localIndex) {
    return {
      page: this.index,
      row: Math.floor(localIndex / this.layout.columns),
      column: localIndex % this.layout.columns,
    };
  }

  render() {
    const page = document.createElement("section");
    page.className = "widget-launchpad-page";
    page.dataset.launchpadPage = String(this.index);
    page.setAttribute("aria-label", `Widgets 啟動台第 ${this.index + 1} 頁`);
    page.append(...this.items.map((item, localIndex) => new AbilityAppIcon({
      item,
      panel: this.panel,
      launchpad: this.launchpad,
      position: this.positionFor(localIndex),
    }).render()));
    return page;
  }
}

class WidgetLaunchpad {
  constructor({ root, panel, items, layout = WidgetLaunchpadLayout }) {
    this.root = root;
    this.panel = panel;
    this.items = items;
    this.layout = layout;
    this.viewport = root?.querySelector("[data-widget-launchpad-viewport]") || null;
    this.track = root?.querySelector("[data-widget-launchpad-track]") || null;
    this.dots = root?.querySelector("[data-widget-launchpad-dots]") || null;
    this.previousButton = root?.querySelector("[data-widget-launchpad-previous]") || null;
    this.nextButton = root?.querySelector("[data-widget-launchpad-next]") || null;
    this.pageIndex = 0;
    this.pageNodes = [];
    this.lastPageGestureAt = 0;
    this.swipeState = null;
  }

  pageItems() {
    const pages = [];
    for (let offset = 0; offset < this.items.length; offset += this.layout.capacity) {
      pages.push(this.items.slice(offset, offset + this.layout.capacity));
    }
    return pages.length ? pages : [[]];
  }

  mount() {
    if (!this.root || !this.panel || !this.viewport || !this.track || !this.dots) return false;
    const pages = this.pageItems();
    this.root.style.setProperty("--widget-launchpad-columns", String(this.layout.columns));
    this.root.style.setProperty("--widget-launchpad-rows", String(this.layout.rows));
    this.root.style.setProperty("--widget-launchpad-page-aspect", `${this.layout.pageAspect.width} / ${this.layout.pageAspect.height}`);
    this.root.dataset.launchpadColumns = String(this.layout.columns);
    this.root.dataset.launchpadRows = String(this.layout.rows);
    this.root.dataset.launchpadCapacity = String(this.layout.capacity);
    this.root.dataset.launchpadPageCount = String(pages.length);
    this.pageNodes = pages.map((items, index) => new AbilityPage({
      index,
      items,
      layout: this.layout,
      panel: this.panel,
      launchpad: this,
    }).render());
    this.track.replaceChildren(...this.pageNodes);
    this.renderPagination();
    this.bindPagination();
    this.bindGestures();
    this.setPage(0, { animate: false });
    window.ControlButtons?.renderIcons?.();
    return true;
  }

  renderPagination() {
    this.dots.replaceChildren(...this.pageNodes.map((_page, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "widget-launchpad-page-dot";
      dot.dataset.launchpadPageTarget = String(index);
      dot.setAttribute("aria-label", `前往第 ${index + 1} 頁`);
      dot.addEventListener("click", () => this.setPage(index));
      return dot;
    }));
  }

  bindPagination() {
    this.previousButton?.addEventListener("click", () => this.setPage(this.pageIndex - 1));
    this.nextButton?.addEventListener("click", () => this.setPage(this.pageIndex + 1));
  }

  bindGestures() {
    this.viewport.addEventListener("wheel", (event) => {
      if (this.pageNodes.length < 2 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      if (!this.canChangePage()) return;
      this.setPage(this.pageIndex + (event.deltaX > 0 ? 1 : -1));
    }, { passive: false });

    this.viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".widget-launchpad-app")) return;
      this.swipeState = { pointerId: event.pointerId, startX: event.clientX };
    });
    this.viewport.addEventListener("pointerup", (event) => {
      if (!this.swipeState || this.swipeState.pointerId !== event.pointerId) return;
      const width = this.viewport.getBoundingClientRect().width;
      const deltaRatio = width > 0 ? (event.clientX - this.swipeState.startX) / width : 0;
      this.swipeState = null;
      if (Math.abs(deltaRatio) < this.layout.swipeRatio || !this.canChangePage()) return;
      this.setPage(this.pageIndex + (deltaRatio < 0 ? 1 : -1));
    });
    this.viewport.addEventListener("pointercancel", () => {
      this.swipeState = null;
    });
  }

  canChangePage() {
    const now = Date.now();
    if (now - this.lastPageGestureAt < this.layout.pageCooldownMs) return false;
    this.lastPageGestureAt = now;
    return true;
  }

  setPage(index, { animate = true } = {}) {
    const maxIndex = Math.max(0, this.pageNodes.length - 1);
    const nextIndex = Math.min(maxIndex, Math.max(0, Number(index) || 0));
    this.pageIndex = nextIndex;
    this.root.dataset.launchpadPage = String(nextIndex);
    this.track.dataset.launchpadAnimate = animate ? "1" : "0";
    this.track.style.setProperty("--widget-launchpad-page-offset", `${nextIndex * -100}%`);
    this.dots.querySelectorAll("[data-launchpad-page-target]").forEach((dot) => {
      const active = Number(dot.dataset.launchpadPageTarget) === nextIndex;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-current", active ? "page" : "false");
    });
    const hasMultiplePages = this.pageNodes.length > 1;
    if (this.previousButton) {
      this.previousButton.hidden = !hasMultiplePages;
      this.previousButton.disabled = nextIndex === 0;
    }
    if (this.nextButton) {
      this.nextButton.hidden = !hasMultiplePages;
      this.nextButton.disabled = nextIndex === maxIndex;
    }
  }

  beginAppDrag() {
    this.root.classList.add("is-app-dragging");
  }

  updateAppDrag(event) {
    if (this.pageNodes.length < 2 || !this.viewport) return;
    const rect = this.viewport.getBoundingClientRect();
    if (event.clientY < rect.top || event.clientY > rect.bottom || rect.width <= 0) return;
    const positionRatio = (event.clientX - rect.left) / rect.width;
    if (positionRatio <= this.layout.edgePageRatio && this.canChangePage()) {
      this.setPage(this.pageIndex - 1);
    } else if (positionRatio >= 1 - this.layout.edgePageRatio && this.canChangePage()) {
      this.setPage(this.pageIndex + 1);
    }
  }

  endAppDrag() {
    this.root.classList.remove("is-app-dragging");
  }
}

function initWidgetLaunchpad() {
  const root = document.querySelector("[data-widget-launchpad]");
  const panel = window.WidgetsPanelInstance;
  const items = window.WidgetCatalog?.registered?.() || [];
  if (!root || !panel) return null;
  const launchpad = new WidgetLaunchpad({ root, panel, items });
  if (!launchpad.mount()) return null;
  window.WidgetLaunchpadInstance = launchpad;
  return launchpad;
}

window.WidgetLaunchpadLayout = WidgetLaunchpadLayout;
window.AbilityAppIcon = AbilityAppIcon;
window.AbilityPage = AbilityPage;
window.WidgetLaunchpad = WidgetLaunchpad;

initWidgetLaunchpad();
