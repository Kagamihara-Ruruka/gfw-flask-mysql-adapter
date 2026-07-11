const WidgetSizePresets = Object.freeze({
  "1x1": Object.freeze({ id: "1x1", columns: 1, rows: 1 }),
  "1x2": Object.freeze({ id: "1x2", columns: 2, rows: 1 }),
  "1x3": Object.freeze({ id: "1x3", columns: 3, rows: 1 }),
  "2x2": Object.freeze({ id: "2x2", columns: 2, rows: 2 }),
  "2x3": Object.freeze({ id: "2x3", columns: 3, rows: 2 }),
});

// Size keys follow the existing rows x columns convention: 1x2 is one row, two columns.
const WidgetSizeAbleDict = Object.freeze({
  "line-chart": Object.freeze(["1x1", "1x2", "1x3", "2x2", "2x3"]),
  "pie-chart": Object.freeze(["1x1", "2x2", "2x3"]),
  metrics: Object.freeze(["1x2", "2x2"]),
  table: Object.freeze(["2x2"]),
  "map-jump": Object.freeze(["1x1", "1x2"]),
});

let suppressNativeWidgetContextMenuUntil = 0;

function widgetNow() {
  return window.performance?.now?.() || Date.now();
}

function suppressNativeWidgetContextMenu(durationMs = 700) {
  suppressNativeWidgetContextMenuUntil = Math.max(
    suppressNativeWidgetContextMenuUntil,
    widgetNow() + durationMs
  );
}

function isWidgetContextSurface(target) {
  return target instanceof Element && Boolean(target.closest(
    ".widgets-panel, .widget-popover-layer, .widgets-catalog-popover, .widget-popover, .widget-settings-popover"
  ));
}

function isWidgetInteractiveSurface(target, boundary) {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest([
    "button",
    "a",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[data-widget-interactive]",
    ".js-plotly-plot",
    ".plotly",
    ".modebar",
  ].join(", "));
  return Boolean(interactive && boundary?.contains(interactive));
}

document.addEventListener("contextmenu", (event) => {
  if (widgetNow() > suppressNativeWidgetContextMenuUntil && !isWidgetContextSurface(event.target)) {
    return;
  }
  event.preventDefault();
}, true);

function bindWidgetPointerBehavior(node, { onPrimary, onSettings }) {
  let settingsOpenedAt = 0;

  const openSettings = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    suppressNativeWidgetContextMenu();
    settingsOpenedAt = widgetNow();
    onSettings?.();
  };

  node.addEventListener("click", (event) => {
    if (isWidgetInteractiveSurface(event.target, node)) {
      return;
    }
    if (node.dataset.widgetSuppressClick === "1") {
      event.preventDefault();
      event.stopPropagation();
      node.dataset.widgetSuppressClick = "0";
      return;
    }
    onPrimary();
  });
  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 2) return;
    openSettings(event);
  });
  node.addEventListener("contextmenu", (event) => {
    const now = widgetNow();
    if (now - settingsOpenedAt < 350) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    openSettings(event);
  });
}

function setWidgetSelectionLock(locked) {
  document.body?.classList.toggle("is-widget-pointer-dragging", Boolean(locked));
  if (!locked) {
    document.getSelection?.().removeAllRanges();
  }
}

function forceCloseWidgetPopoverLayers() {
  document.querySelectorAll(".widget-popover-layer").forEach((layer) => {
    layer.hidden = true;
    layer.style.display = "none";
    layer.style.pointerEvents = "none";
    layer.classList.remove("is-marketplace-layer");
    layer.replaceChildren();
  });
}

function bindWidgetActionButton(button, onClick) {
  if (!button) return button;
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  button.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  button.addEventListener("touchstart", (event) => {
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.(event);
  });
  return button;
}

function widgetActionIcon(name) {
  const icons = {
    close: [
      '<path d="M18 6 6 18"></path>',
      '<path d="m6 6 12 12"></path>',
    ],
    delete: [
      '<path d="M3 6h18"></path>',
      '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
      '<path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>',
      '<path d="M10 11v6"></path>',
      '<path d="M14 11v6"></path>',
    ],
  };
  return [
    '<svg class="widget-action-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    icons[name]?.join("") || "",
    "</svg>",
  ].join("");
}

function createWidgetDeleteButton(onDelete) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "widget-delete-button";
  button.title = "刪除 Widget";
  button.setAttribute("aria-label", "刪除 Widget");
  button.innerHTML = widgetActionIcon("delete");
  return bindWidgetActionButton(button, () => onDelete?.());
}

function bindWidgetDragBehavior(node, { kind, onDragStart, onDragMove, onDragEnd, onDrop }) {
  node.addEventListener("dragstart", (event) => event.preventDefault());
  node.addEventListener("selectstart", (event) => event.preventDefault());

  if (kind === "widget") {
    node.draggable = false;
    let dragState = null;
    const resetDrag = (event, shouldDrop = false) => {
      if (!dragState) return;
      const wasDragging = dragState.dragging;
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerCancel);
      if (wasDragging && shouldDrop) {
        onDrop?.(event);
      }
      if (wasDragging) {
        node.classList.remove("is-dragging");
        node.dataset.widgetSuppressClick = "1";
        window.setTimeout(() => {
          delete node.dataset.widgetSuppressClick;
        }, 0);
        onDragEnd?.(event);
      }
      setWidgetSelectionLock(false);
      dragState = null;
    };
    const handlePointerMove = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      if (!dragState.dragging && distance >= 6) {
        dragState.dragging = true;
        node.classList.add("is-dragging");
        onDragStart?.(event);
      }
      if (!dragState.dragging) return;
      onDragMove?.(event);
    };
    const handlePointerUp = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      resetDrag(event, true);
    };
    const handlePointerCancel = (event) => {
      resetDrag(event, false);
    };
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      setWidgetSelectionLock(true);
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
      };
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerCancel);
    });
    return;
  }
  if (kind === "catalog") {
    node.draggable = false;
    let dragState = null;
    const resetDrag = (event, shouldDrop = false) => {
      if (!dragState) return;
      const wasDragging = dragState.dragging;
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerCancel);
      if (wasDragging && shouldDrop) {
        onDrop?.(event);
      }
      if (wasDragging) {
        node.classList.remove("is-dragging");
        onDragEnd?.(event);
      }
      setWidgetSelectionLock(false);
      dragState = null;
    };
    const handlePointerMove = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      if (!dragState.dragging && distance >= 6) {
        dragState.dragging = true;
        node.classList.add("is-dragging");
        onDragStart?.(event);
      }
      if (!dragState.dragging) return;
      onDragMove?.(event);
    };
    const handlePointerUp = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      resetDrag(event, true);
    };
    const handlePointerCancel = (event) => {
      resetDrag(event, false);
    };
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      setWidgetSelectionLock(true);
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
      };
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerCancel);
    });
    return;
  }
  if (kind === "dropzone") {
    node.addEventListener("dragenter", (event) => {
      event.preventDefault();
    });
    node.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      onDrop?.(event);
    });
    node.addEventListener("dragleave", (event) => {
      if (!event.relatedTarget || !node.contains(event.relatedTarget)) {
        onDragEnd?.(event);
      }
    });
    return;
  }
  if (kind === "socket") {
    node.addEventListener("dragover", (event) => {
      event.preventDefault();
      node.classList.add("is-drop-target");
    });
    node.addEventListener("dragleave", () => {
      node.classList.remove("is-drop-target");
    });
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      node.classList.remove("is-drop-target");
      onDrop?.(event);
    });
  }
}

class WidgetSocketLayout {
  constructor({ root, board, socketGrid, widgetGrid }) {
    this.root = root;
    this.board = board;
    this.socketGrid = socketGrid;
    this.widgetGrid = widgetGrid;
    this.columns = this.normalizePositiveInt(root?.dataset.widgetsColumns, 2);
    this.rowsSetting = root?.dataset.widgetsRows || "auto";
    this.aspect = this.parseAspect(root?.dataset.widgetsAspect);
    this.gap = 8;
    this.minSlotSize = 88;
  }

  normalizePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  parseAspect(value) {
    if (!value || !value.includes(":")) return null;
    const [width, height] = value.split(":").map((item) => Number.parseFloat(item));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }

  sync() {
    if (!this.board || !this.socketGrid || !this.widgetGrid) return;
    const boardStyle = window.getComputedStyle(this.board);
    const paddingX = Number.parseFloat(boardStyle.paddingLeft) + Number.parseFloat(boardStyle.paddingRight);
    const paddingY = Number.parseFloat(boardStyle.paddingTop) + Number.parseFloat(boardStyle.paddingBottom);
    const contentWidth = Math.max(0, this.board.clientWidth - paddingX);
    const contentHeight = Math.max(0, this.board.clientHeight - paddingY);
    const widthSlotSize = Math.max(
      this.minSlotSize,
      Math.floor((contentWidth - (this.columns - 1) * this.gap) / this.columns),
    );
    const rows = this.resolveRows(widthSlotSize, paddingY);
    const heightSlotSize = rows > 0 && contentHeight > 0
      ? Math.floor((contentHeight - (rows - 1) * this.gap) / rows)
      : widthSlotSize;
    const slotSize = Math.max(this.minSlotSize, Math.min(widthSlotSize, heightSlotSize));
    if (this.lastSlotSize === slotSize && this.lastRows === rows && this.lastColumns === this.columns) {
      return;
    }
    this.lastSlotSize = slotSize;
    this.lastRows = rows;
    this.lastColumns = this.columns;
    this.applyGridVars(slotSize);
    this.renderSockets(rows);
  }

  resolveRows(slotSize, paddingY) {
    if (this.rowsSetting === "ratio" && this.aspect) {
      return Math.max(1, Math.round(this.columns * (this.aspect.height / this.aspect.width)));
    }
    if (this.rowsSetting !== "auto") {
      return this.normalizePositiveInt(this.rowsSetting, 1);
    }
    const contentHeight = Math.max(0, this.board.clientHeight - paddingY);
    return Math.max(1, Math.floor((contentHeight + this.gap) / (slotSize + this.gap)));
  }

  applyGridVars(slotSize) {
    for (const node of [this.board, this.socketGrid, this.widgetGrid]) {
      node.style.setProperty("--widgets-columns", String(this.columns));
      node.style.setProperty("--widget-slot-size", `${slotSize}px`);
      node.style.setProperty("--widget-slot-gap", `${this.gap}px`);
    }
  }

  renderSockets(rows) {
    const total = this.columns * rows;
    const current = this.socketGrid.children.length;
    if (current === total) return;
    this.socketGrid.replaceChildren(
      ...Array.from({ length: total }, (_, index) => {
        const socket = document.createElement("div");
        socket.className = "widget-socket";
        socket.dataset.widgetSocketIndex = String(index);
        socket.dataset.widgetSocketColumn = String((index % this.columns) + 1);
        socket.dataset.widgetSocketRow = String(Math.floor(index / this.columns) + 1);
        return socket;
      }),
    );
    this.root.dataset.widgetsSlotCount = String(total);
    this.root.dataset.widgetsRowsResolved = String(rows);
  }
}

class WidgetCatalogItem {
  constructor({
    id,
    title,
    size,
    description,
    group = "new",
    kind = "widget",
    supportedSizes = null,
    enabled = false,
    deletable = true,
    draggable = true,
  }) {
    this.id = id;
    this.title = title;
    this.size = size;
    this.description = description;
    this.group = group;
    this.kind = kind;
    this.supportedSizes = Array.isArray(supportedSizes) ? supportedSizes : null;
    this.enabled = enabled;
    this.deletable = deletable !== false;
    this.draggable = draggable !== false;
  }

  supportsSize(size) {
    return this.supportedSizes ? this.supportedSizes.includes(size) : this.size === size;
  }

  dimensions() {
    return WidgetSizePresets[this.size] || WidgetSizePresets["1x1"];
  }

  render() {
    const label = document.createElement("label");
    label.className = "widgets-catalog-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.enabled;
    input.dataset.widgetCatalogId = this.id;

    const name = document.createElement("span");
    name.className = "widgets-catalog-name";
    name.textContent = this.title;

    const detail = document.createElement("small");
    detail.textContent = this.description;
    name.append(detail);

    const size = document.createElement("span");
    size.className = "dashboard-widget-size";
    size.textContent = this.size;

    label.append(input, name, size);
    return label;
  }

  renderMarketplaceCard(panel) {
    const card = document.createElement("article");
    card.className = "widgets-marketplace-card";
    card.dataset.widgetCatalogId = this.id;
    card.dataset.widgetSize = this.size;
    card.dataset.widgetCatalogKind = this.kind;
    card.dataset.widgetCatalogDraggable = this.draggable ? "1" : "0";
    card.tabIndex = 0;
    if (!this.draggable) {
      card.classList.add("is-reference");
    }

    const preview = document.createElement("div");
    preview.className = `widget-product-preview widget-product-preview--${this.kind === "size" ? "blank-size" : this.id}`;
    preview.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "widgets-marketplace-card-body";

    const title = document.createElement("h4");
    title.textContent = this.title;

    const description = document.createElement("p");
    description.textContent = this.description;

    const size = document.createElement("span");
    size.className = "dashboard-widget-size";
    size.textContent = this.size;

    body.append(title, description);
    card.append(preview, body, size);
    if (this.draggable) {
      bindWidgetDragBehavior(card, {
        kind: "catalog",
        onDragStart: () => panel.beginCatalogDrag(this),
        onDragMove: (event) => panel.updateCatalogDragAtPoint(this, event.clientX, event.clientY),
        onDrop: (event) => panel.dropCatalogItemAtPoint(this, event.clientX, event.clientY),
        onDragEnd: () => panel.endCatalogDrag(),
      });
    }
    return card;
  }
}

class WidgetMarketplaceDrawer {
  constructor({ id, title, items = [], expanded = false }) {
    this.id = id;
    this.title = title;
    this.items = items;
    this.expanded = expanded;
  }

  render(panel) {
    const section = document.createElement("details");
    section.className = "widgets-marketplace-drawer";
    section.open = this.expanded;
    section.dataset.widgetsDrawerId = this.id;
    section.dataset.widgetsDrawerExpanded = this.expanded ? "1" : "0";

    const summary = document.createElement("summary");
    summary.className = "widgets-marketplace-drawer-button";
    summary.setAttribute("aria-expanded", this.expanded ? "true" : "false");

    const title = document.createElement("span");
    title.textContent = this.title;

    const count = document.createElement("strong");
    count.textContent = `${this.items.length}`;

    const chevron = document.createElement("i");
    chevron.className = "widgets-marketplace-drawer-chevron";
    chevron.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "widgets-marketplace-grid";
    body.hidden = !this.expanded;
    body.append(...this.items.map((item) => item.renderMarketplaceCard(panel)));

    summary.append(title, count, chevron);
    summary.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    section.addEventListener("toggle", () => {
      const isExpanded = section.open;
      section.dataset.widgetsDrawerExpanded = isExpanded ? "1" : "0";
      summary.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      body.hidden = !isExpanded;
    });

    section.append(summary, body);
    return section;
  }
}

class DashboardWidget {
  constructor({ id, title, size = "1x1", status = "待設計", slotIndex = null, deletable = true, widgetType = "blank" }) {
    this.id = id;
    this.title = title;
    this.size = this.normalizeSize(size);
    this.status = status;
    this.slotIndex = Number.isInteger(slotIndex) ? slotIndex : null;
    this.deletable = deletable !== false;
    this.widgetType = widgetType;
  }

  normalizeSize(size) {
    return WidgetSizePresets[size]?.id || WidgetSizePresets["1x1"].id;
  }

  render(controller) {
    const item = document.createElement("article");
    item.className = "dashboard-widget";
    item.dataset.widgetId = this.id;
    item.dataset.widgetSize = this.size;
    item.dataset.widgetDeletable = this.deletable ? "1" : "0";
    item.dataset.widgetType = this.widgetType;

    const header = document.createElement("div");
    header.className = "dashboard-widget-header";

    const title = document.createElement("h3");
    title.className = "dashboard-widget-title";
    title.textContent = this.title;

    const body = document.createElement("div");
    body.className = "dashboard-widget-body";
    this.renderTemplate(body, { expanded: false });

    header.append(title);
    item.append(header, body);
    this.applyPlacement(item, controller.columns());
    bindWidgetPointerBehavior(item, {
      onPrimary: () => this.handlePrimaryAction(controller),
      onSettings: () => controller.openWidgetSettings(this),
    });
    bindWidgetDragBehavior(item, {
      kind: "widget",
      onDragStart: () => controller.beginWidgetDrag(this),
      onDragMove: (event) => controller.updateDragAtPoint(event.clientX, event.clientY),
      onDrop: (event) => controller.dropDraggedWidgetAtPoint(event.clientX, event.clientY),
      onDragEnd: () => controller.endWidgetDrag(),
    });
    return item;
  }

  dimensions() {
    return WidgetSizePresets[this.size] || WidgetSizePresets["1x1"];
  }

  placeAt(slotIndex, columns, rows) {
    const dimensions = this.dimensions();
    const column = slotIndex % columns;
    const row = Math.floor(slotIndex / columns);
    if (
      column < 0 ||
      row < 0 ||
      column + dimensions.columns > columns ||
      row + dimensions.rows > rows
    ) {
      return null;
    }
    this.slotIndex = slotIndex;
    return this.slotIndex;
  }

  applyPlacement(node, columns) {
    if (!node || this.slotIndex === null) return;
    const dimensions = this.dimensions();
    const column = (this.slotIndex % columns) + 1;
    const row = Math.floor(this.slotIndex / columns) + 1;
    node.style.gridColumn = `${column} / span ${dimensions.columns}`;
    node.style.gridRow = `${row} / span ${dimensions.rows}`;
    node.dataset.widgetSlotIndex = String(this.slotIndex);
  }

  renderExpanded() {
    const pane = document.createElement("section");
    pane.className = "widget-popover";
    pane.dataset.widgetId = this.id;
    pane.dataset.widgetSize = this.size;
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-modal", "true");
    pane.setAttribute("aria-label", `${this.title} 展開窗格`);

    const header = document.createElement("div");
    header.className = "widget-popover-header";

    const title = document.createElement("h3");
    title.textContent = this.title;

    const sizeBadge = document.createElement("span");
    sizeBadge.className = "dashboard-widget-size";
    sizeBadge.textContent = this.size;

    const body = document.createElement("div");
    body.className = "widget-popover-body";
    this.renderTemplate(body, { expanded: true });

    header.append(title, sizeBadge);
    pane.append(header, body);
    return pane;
  }

  renderTemplate(container) {
    container.textContent = this.status;
  }

  handlePrimaryAction(controller) {
    controller.expandWidget(this);
  }

  renderSettings({ onDelete, onConfigure, catalogItems = [] } = {}) {
    const pane = document.createElement("section");
    pane.className = "widget-settings-popover";
    pane.dataset.widgetId = this.id;
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-modal", "true");
    pane.setAttribute("aria-label", `${this.title} 設定`);

    const header = document.createElement("div");
    header.className = "widget-settings-header";

    const title = document.createElement("h3");
    title.textContent = "Widget 設定";
    header.append(title);
    if (this.deletable && typeof onDelete === "function") {
      header.append(createWidgetDeleteButton(() => onDelete?.(this)));
    }

    const nameRow = document.createElement("div");
    nameRow.className = "widget-settings-row";
    nameRow.innerHTML = `<span>名稱</span><strong>${this.title}</strong>`;

    const sizeRow = document.createElement("div");
    sizeRow.className = "widget-settings-row";
    sizeRow.innerHTML = `<span>尺寸</span><strong>${this.size}</strong>`;

    pane.append(header, nameRow, sizeRow);

    const compatibleItems = catalogItems.filter((item) => item.supportsSize(this.size));
    if (compatibleItems.length > 0) {
      const typeField = document.createElement("label");
      typeField.className = "widget-settings-field";

      const typeLabel = document.createElement("span");
      typeLabel.textContent = "工具類型";

      const typeControls = document.createElement("span");
      typeControls.className = "widget-settings-inline-controls";

      const select = document.createElement("select");
      select.dataset.widgetTypeSelect = "1";

      const blankOption = document.createElement("option");
      blankOption.value = "blank";
      blankOption.textContent = "空白版型";
      select.append(blankOption);

      for (const item of compatibleItems) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.title;
        select.append(option);
      }
      select.value = compatibleItems.some((item) => item.id === this.widgetType) ? this.widgetType : "blank";

      const applyButton = document.createElement("button");
      applyButton.type = "button";
      applyButton.className = "widget-settings-apply-button";
      applyButton.dataset.widgetTypeApply = "1";
      applyButton.textContent = "套用";
      bindWidgetActionButton(applyButton, () => onConfigure?.(this, select.value));

      typeControls.append(select, applyButton);
      typeField.append(typeLabel, typeControls);
      pane.append(typeField);
    }

    return pane;
  }
}

class ChartWidget extends DashboardWidget {
  formatValue(value, { maximumFractionDigits = 0 } = {}) {
    if (value === undefined || value === null || value === "") return "-";
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "-";
    return numeric.toLocaleString("zh-TW", { maximumFractionDigits });
  }

  percent(value, total) {
    if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
    return Math.round((value / total) * 100);
  }

  seriesDelta(values) {
    if (!Array.isArray(values) || values.length < 2) return 0;
    return values[values.length - 1] - values[0];
  }

  chartPoints(values, { width = 220, height = 124, padX = 18, padY = 14 } = {}) {
    const numericValues = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    if (!numericValues.length) return [];
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const range = Math.max(max - min, 1);
    const step = numericValues.length > 1 ? (width - padX * 2) / (numericValues.length - 1) : 0;
    return numericValues.map((value, index) => ({
      x: Number((padX + step * index).toFixed(2)),
      y: Number((height - padY - ((value - min) / range) * (height - padY * 2)).toFixed(2)),
      value,
    }));
  }

  pointsAttribute(points) {
    return points.map((point) => `${point.x},${point.y}`).join(" ");
  }

  pieSegments(slices) {
    const total = slices.reduce((sum, slice) => sum + Number(slice.value || 0), 0);
    let cursor = 0;
    return slices.map((slice) => {
      const value = Number(slice.value || 0);
      const start = cursor;
      const end = total > 0 ? cursor + (value / total) * 100 : cursor;
      cursor = end;
      return {
        ...slice,
        value,
        percent: this.percent(value, total),
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
      };
    });
  }

  renderChartEmptyState(container, model, sourceLabel = "chart source") {
    container.classList.add("is-empty");
    container.innerHTML = `
      <div class="widget-chart-empty-state">
        <strong>${lineChartEscape(model?.title || "等待資料")}</strong>
        <span>${lineChartEscape(model?.detail || "")}</span>
        <em>${lineChartEscape(sourceLabel)}</em>
      </div>
    `;
  }
}

function lineChartDateKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, 10);
}

function lineChartFormatDateLabel(value) {
  const key = lineChartDateKey(value);
  return key.length >= 10 ? key.slice(5) : key;
}

function lineChartEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function widgetMetricForDataset(dataset) {
  const metrics = Array.isArray(dataset?.metric_columns) ? dataset.metric_columns : [];
  if (metrics.length) return metrics[0];
  const roles = new Set([
    dataset?.time_column,
    dataset?.id_column,
    dataset?.lat_column,
    dataset?.lon_column,
  ].filter(Boolean));
  return (dataset?.display_columns || []).find((column) => !roles.has(column)) || null;
}

class LineChartDataSource {
  static shared() {
    if (!LineChartDataSource.instance) {
      LineChartDataSource.instance = new LineChartDataSource();
    }
    return LineChartDataSource.instance;
  }

  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
  }

  clear() {
    this.cache.clear();
    this.inflight.clear();
  }

  selectedCell() {
    return state?.tileSelection?.selected || window.TileSelectionLayer?.selected?.() || null;
  }

  selectedDates() {
    if (typeof datesInSelectedRange === "function") {
      return datesInSelectedRange();
    }
    const available = Array.isArray(state?.availableDates) ? state.availableDates : [];
    if (!available.length) return [];
    let start = $("start-date")?.value || available[0];
    let end = $("end-date")?.value || available[available.length - 1];
    if (start > end) [start, end] = [end, start];
    return available.filter((date) => date >= start && date <= end);
  }

  metricForDataset(dataset) {
    return widgetMetricForDataset(dataset);
  }

  selectedBbox(selected) {
    return Array.isArray(selected?.bbox) && selected.bbox.length === 4 ? selected.bbox : null;
  }

  selectedBboxString(selected) {
    const bbox = this.selectedBbox(selected);
    if (!bbox) return "";
    return selected.bbox_string || bbox.map((value) => Number(value).toFixed(6)).join(",");
  }

  statusModel(stateName, title, detail, extra = {}) {
    return {
      state: stateName,
      title,
      detail,
      metric: extra.metric || "指標值",
      unit: extra.unit || "",
      xLabel: "時間",
      yLabel: extra.yLabel || "值",
      labels: [],
      compactLabels: [],
      series: [],
      selection: extra.selection || null,
      rowCount: 0,
      pointCount: 0,
    };
  }

  requestForCurrentState() {
    const datasetId = state?.datasetId;
    const dataset = state?.datasets?.[datasetId] || null;
    const selected = this.selectedCell();
    if (!selected) {
      return { blocked: this.statusModel("waiting", "等待網格選取", "尚未點選 GFW 顏色格") };
    }
    if (selected.dataset_id && datasetId && selected.dataset_id !== datasetId) {
      return { blocked: this.statusModel("waiting", "等待重新選取", "目前資料集已切換", { selection: selected }) };
    }
    const bboxString = this.selectedBboxString(selected);
    const hasIdentity = Boolean(selected.identity?.column && selected.identity?.value !== undefined && selected.identity?.value !== null);
    if (!bboxString && !hasIdentity) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 bbox 或 identity", { selection: selected }) };
    }
    const dates = this.selectedDates();
    if (!dates.length) {
      return { blocked: this.statusModel("waiting", "等待時間區間", "尚未取得播放器時間序列", { selection: selected }) };
    }
    const metric = this.metricForDataset(dataset);
    if (!datasetId || !dataset || !metric) {
      return { blocked: this.statusModel("waiting", "等待資料合約", "目前圖層沒有可查詢指標", { selection: selected }) };
    }
    const aggregation = "sum";
    const start = dates[0];
    const end = dates[dates.length - 1];
    const key = [
      datasetId,
      metric,
      aggregation,
      start,
      end,
      bboxString || `${selected.identity.column}:${selected.identity.value}`,
    ].join("|");
    return {
      key,
      datasetId,
      dataset,
      selected,
      dates,
      metric,
      aggregation,
      bboxString,
      identityColumn: hasIdentity ? selected.identity.column : "",
      identityValue: hasIdentity ? selected.identity.value : "",
      start,
      end,
    };
  }

  model() {
    const request = this.requestForCurrentState();
    if (request.blocked) return request.blocked;
    const cached = this.cache.get(request.key);
    if (cached) return cached;
    this.fetch(request);
    return this.statusModel("loading", "載入時間序列", request.selected.tile_key || "等待資料", {
      metric: request.metric,
      yLabel: `${request.aggregation.toUpperCase()} ${request.metric}`,
      unit: request.metric,
      selection: request.selected,
    });
  }

  fetch(request) {
    if (this.inflight.has(request.key)) return this.inflight.get(request.key);
    const params = new URLSearchParams({
      start: request.start,
      end: request.end,
      metric: request.metric,
      aggregation: request.aggregation,
    });
    if (request.bboxString) {
      params.set("bbox", request.bboxString);
    } else {
      params.set("identity_column", request.identityColumn);
      params.set("identity_value", request.identityValue);
    }
    const url = `/api/datasets/${encodeURIComponent(request.datasetId)}/time-series?${params.toString()}`;
    const loader = fetchJson(url)
      .then((packet) => {
        this.cache.set(request.key, this.packetToModel(request, packet));
      })
      .catch((err) => {
        this.cache.set(request.key, this.statusModel("error", "查詢失敗", err.message || "time-series query failed", {
          metric: request.metric,
          yLabel: `${request.aggregation.toUpperCase()} ${request.metric}`,
          unit: request.metric,
          selection: request.selected,
        }));
      })
      .finally(() => {
        this.inflight.delete(request.key);
        window.dispatchEvent(new CustomEvent("rrkal:line-chart-data-changed", {
          detail: { key: request.key },
        }));
      });
    this.inflight.set(request.key, loader);
    return loader;
  }

  packetToModel(request, packet) {
    const pointByDate = new Map();
    for (const point of packet?.points || []) {
      pointByDate.set(lineChartDateKey(point.date), point);
    }
    const values = request.dates.map((date) => {
      const value = Number(pointByDate.get(lineChartDateKey(date))?.value ?? 0);
      return Number.isFinite(value) ? value : 0;
    });
    return {
      state: "ready",
      title: "網格時間序列",
      detail: request.selected.tile_key || "",
      metric: packet?.metric || request.metric,
      unit: packet?.metric || request.metric,
      xLabel: "時間",
      yLabel: `${String(packet?.aggregation || request.aggregation).toUpperCase()} ${packet?.metric || request.metric}`,
      labels: request.dates,
      compactLabels: request.dates.map(lineChartFormatDateLabel),
      series: [
        {
          key: "primary",
          label: request.selected.tile_key || "選取網格",
          color: "#43e28c",
          values,
        },
      ],
      selection: request.selected,
      rowCount: Number(packet?.row_count || 0),
      pointCount: Number(packet?.point_count || 0),
      timing: packet?.timing || {},
    };
  }
}

class LineChartWidget extends ChartWidget {
  chartModel() {
    return LineChartDataSource.shared().model();
  }

  primarySeries(model = this.chartModel()) {
    return model.series[0] || { label: "主要序列", values: [] };
  }

  latestValue(series) {
    return Array.isArray(series?.values) && series.values.length
      ? series.values[series.values.length - 1]
      : null;
  }

  averageValue(series) {
    const values = (series?.values || []).map(Number).filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  lineChartElementId() {
    return `${this.id}-line-chart`;
  }

  lineChartData(model) {
    return (model.series || []).map((series) => ({
      type: "scatter",
      mode: "lines+markers",
      name: series.label,
      x: model.labels,
      y: series.values,
      line: { color: series.color, width: 3, shape: "spline", smoothing: 0.45 },
      marker: { color: series.color, size: 7, line: { color: "rgba(15,23,42,0.86)", width: 1 } },
      hovertemplate:
        `${series.label}<br>` +
        `${model.xLabel}：%{x}<br>` +
        `${model.yLabel}：%{y:.1f} ${model.unit}<extra></extra>`,
    }));
  }

  lineChartLayout(model, { cinema = false } = {}) {
    const yTitle = model.unit ? `${model.yLabel} (${model.unit})` : model.yLabel;
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(5,10,16,0.5)",
      margin: cinema ? { l: 58, r: 28, t: 18, b: 46 } : { l: 48, r: 18, t: 10, b: 38 },
      autosize: true,
      font: { color: "#94a3b8", family: "Inter, system-ui, sans-serif", size: cinema ? 12 : 11 },
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: "#0f172a",
        bordercolor: "rgba(74, 222, 128, 0.72)",
        font: { color: "#e5eefb", family: "Inter, system-ui, sans-serif", size: 12 },
        align: "left",
      },
      legend: {
        orientation: "h",
        x: 0,
        y: 1.14,
        bgcolor: "rgba(0,0,0,0)",
        font: { color: "#cbd5e1" },
      },
      xaxis: {
        title: { text: model.xLabel, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
      },
      yaxis: {
        title: { text: yTitle, font: { color: "#94a3b8", size: 11 } },
        gridcolor: "rgba(148,163,184,0.16)",
        zeroline: false,
        rangemode: "tozero",
      },
    };
  }

  renderLinePlotlyWhenReady(container, model, options = {}, attempt = 0) {
    const chart = container.querySelector("[data-widget-line-plotly]");
    if (!chart) return;
    const rect = chart.getBoundingClientRect();
    const measurable = rect.width > 0 && rect.height > 0;
    if (!measurable && attempt < 6) {
      window.setTimeout(() => this.renderLinePlotlyWhenReady(container, model, options, attempt + 1), 60);
      return;
    }
    if (!window.Plotly?.react) {
      chart.textContent = "Plotly 尚未載入";
      chart.classList.add("pipeline-chart-empty");
      return;
    }
    chart.classList.remove("pipeline-chart-empty");
    chart.textContent = "";
    const data = this.lineChartData(model);
    const layout = this.lineChartLayout(model, options);
    const config = { responsive: true, displayModeBar: false, scrollZoom: false };
    Promise.resolve(window.Plotly.react(chart, data, layout, config)).then(() => {
      const resize = () => window.Plotly?.Plots?.resize?.(chart);
      window.requestAnimationFrame(() => {
        resize();
        window.requestAnimationFrame(resize);
      });
      window.setTimeout(resize, 120);
    }).catch((err) => {
      chart.textContent = err.message || "Plotly render failed";
      chart.classList.add("pipeline-chart-empty");
    });
  }

  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-line");
    if (expanded) container.classList.add("is-expanded");
    container.dataset.chartView = cinema ? "cinema" : expanded ? "expanded" : "compact";
    const model = this.chartModel();
    if (!this.isReadyModel(model)) {
      this.renderLineEmptyState(container, model);
      return;
    }
    if (expanded) {
      this.renderExpandedLineTemplate(container, model, { cinema });
      return;
    }
    this.renderCompactLineTemplate(container, model);
  }

  isReadyModel(model) {
    return model?.state === "ready" && Array.isArray(model.labels) && model.labels.length > 0;
  }

  renderLineEmptyState(container, model) {
    this.renderChartEmptyState(
      container,
      model,
      model?.state === "error" ? "time-series error" : "line chart source"
    );
  }

  renderCompactLineTemplate(container, model) {
    const primary = this.primarySeries(model);
    const primaryPoints = this.chartPoints(primary.values);
    const latest = this.latestValue(primary);
    const delta = this.seriesDelta(primary.values);
    const deltaText = `${delta >= 0 ? "+" : ""}${this.formatValue(delta)}`;
    const areaPoints = `${primaryPoints[0]?.x || 18},110 ${this.pointsAttribute(primaryPoints)} ${primaryPoints[primaryPoints.length - 1]?.x || 202},110`;
    const pointDots = primaryPoints.map((point) => (
      `<circle cx="${point.x}" cy="${point.y}" r="2.8" />`
    )).join("");
    const tickStep = Math.max(1, Math.ceil(model.labels.length / 4));
    const xTicks = model.labels.map((label, index) => {
      if (index !== 0 && index !== model.labels.length - 1 && index % tickStep !== 0) return "";
      const point = primaryPoints[index];
      const tickLabel = model.compactLabels?.[index] || lineChartFormatDateLabel(label);
      return point ? `<text x="${point.x}" y="122">${lineChartEscape(tickLabel)}</text>` : "";
    }).join("");
    const legend = (model.series || []).map((series, index) => `
      <span><i class="${index === 0 ? "legend-a" : "legend-b"}"></i>${lineChartEscape(series.label)}</span>
    `).join("");

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${this.formatValue(latest)}</strong>
        <em>${deltaText}</em>
      </div>
      <div class="widget-chart-shell">
        <div class="widget-axis-label widget-axis-y">${lineChartEscape(model.yLabel)}</div>
        <svg class="widget-line-chart" viewBox="0 0 220 124" role="img" aria-label="折線圖空白範本">
          <path class="widget-grid-line" d="M18 20H204M18 50H204M18 80H204M18 110H204" />
          <path class="widget-axis-line" d="M18 14V110H208" />
          <polygon class="widget-line-area" points="${areaPoints}" />
          <polyline class="widget-line-primary" points="${this.pointsAttribute(primaryPoints)}" />
          ${pointDots}
          ${xTicks}
        </svg>
        <div class="widget-axis-label widget-axis-x">${lineChartEscape(model.xLabel)}</div>
      </div>
      <div class="widget-chart-footer">
        ${legend}
      </div>
    `;
  }

  renderExpandedLineTemplate(container, model, { cinema = false } = {}) {
    const primary = this.primarySeries(model);
    const latest = this.latestValue(primary);
    const average = this.averageValue(primary);
    const delta = this.seriesDelta(primary.values);
    const deltaText = `${delta >= 0 ? "+" : ""}${this.formatValue(delta)}`;
    const statCards = [
      ["最新值", this.formatValue(latest), model.unit],
      ["平均值", this.formatValue(average, { maximumFractionDigits: 1 }), model.unit],
      ["變化量", deltaText, model.unit],
    ].map(([label, value, unit]) => `
      <span class="widget-line-stat-card">
        <b>${value}</b>
        <em>${label} / ${unit}</em>
      </span>
    `).join("");
    const seriesList = model.series.map((series) => `
      <span>
        <i style="--series-color: ${series.color}"></i>
        <b>${lineChartEscape(series.label)}</b>
        <em>${series.values.length} points</em>
      </span>
    `).join("");

    container.innerHTML = `
      <div class="widget-line-panel${cinema ? " is-cinema" : ""}">
        <div class="widget-line-summary">
          <div class="widget-chart-header">
            <span>${lineChartEscape(model.title)}</span>
            <strong>${this.formatValue(latest)}</strong>
            <em>${deltaText}</em>
          </div>
          <div class="widget-line-stat-grid">
            ${statCards}
          </div>
        </div>
        <div class="widget-line-plotly-stage" data-widget-interactive="1">
          <div id="${this.lineChartElementId()}" class="pipeline-plotly-chart widget-line-plotly-chart" data-widget-line-plotly aria-label="折線圖工具預覽"></div>
        </div>
        <div class="widget-line-binding-row">
          <span><b>X</b><em>${lineChartEscape(model.xLabel)}</em></span>
          <span><b>Y</b><em>${lineChartEscape(model.yLabel)}</em></span>
          <span><b>Tile</b><em>${lineChartEscape(model.detail || "-")}</em></span>
        </div>
        <div class="widget-chart-footer widget-line-series-list">
          ${seriesList}
        </div>
      </div>
    `;
    this.renderLinePlotlyWhenReady(container, model, { cinema });
  }
}

class PieChartDataSource {
  static shared() {
    if (!PieChartDataSource.instance) {
      PieChartDataSource.instance = new PieChartDataSource();
    }
    return PieChartDataSource.instance;
  }

  clear() {}

  selectedCell() {
    return state?.tileSelection?.selected || window.TileSelectionLayer?.selected?.() || null;
  }

  currentDate(selected) {
    return $("date")?.value || selected?.date || state?.renderedGfwDate || "";
  }

  metricForDataset(dataset, selected) {
    const selectedMetric = selected?.metric?.column;
    const declared = new Set([
      ...(dataset?.metric_columns || []),
      ...(dataset?.display_columns || []),
    ]);
    if (selectedMetric && declared.has(selectedMetric)) return selectedMetric;
    return widgetMetricForDataset(dataset);
  }

  selectedBbox(selected) {
    return Array.isArray(selected?.bbox) && selected.bbox.length === 4 ? selected.bbox : null;
  }

  statusModel(stateName, title, detail, extra = {}) {
    return {
      state: stateName,
      title,
      detail,
      date: extra.date || "",
      metric: extra.metric || "指標值",
      totalLabel: extra.totalLabel || "Y 總量",
      valueRole: "y",
      total: 0,
      slices: [],
      selection: extra.selection || null,
      rowCount: 0,
    };
  }

  requestForCurrentState() {
    const datasetId = state?.datasetId;
    const dataset = state?.datasets?.[datasetId] || null;
    const selected = this.selectedCell();
    if (!selected) {
      return { blocked: this.statusModel("waiting", "等待網格選取", "尚未點選 GFW 顏色格") };
    }
    if (selected.dataset_id && datasetId && selected.dataset_id !== datasetId) {
      return { blocked: this.statusModel("waiting", "等待重新選取", "目前資料集已切換", { selection: selected }) };
    }
    const hasBbox = Boolean(this.selectedBbox(selected));
    const hasIdentity = Boolean(selected.identity?.column && selected.identity?.value !== undefined && selected.identity?.value !== null);
    if (!hasBbox && !hasIdentity) {
      return { blocked: this.statusModel("waiting", "等待網格範圍", "選取結果沒有 bbox 或 identity", { selection: selected }) };
    }
    const date = this.currentDate(selected);
    if (!date) {
      return { blocked: this.statusModel("waiting", "等待時間切片", "尚未取得單日模式日期", { selection: selected }) };
    }
    const metric = this.metricForDataset(dataset, selected);
    if (!datasetId || !dataset || !metric) {
      return { blocked: this.statusModel("waiting", "等待資料合約", "目前圖層沒有可查詢指標", { date, selection: selected }) };
    }
    const recordsContext = state?.recordsContext || {};
    if (state?.dataLayer !== "gfw") {
      return { blocked: this.statusModel("waiting", "等待 GFW 圖層", "圓餅圖目前吃單日 GFW 全域資料", { date, metric, selection: selected }) };
    }
    if (
      recordsContext.loading ||
      recordsContext.layer !== "gfw" ||
      recordsContext.date !== date ||
      (state?.renderedGfwDate && state.renderedGfwDate !== date)
    ) {
      return { blocked: this.statusModel("loading", "載入切片比例", `${date} / ${selected.tile_key || selected.label || ""}`, { date, metric, selection: selected }) };
    }
    return { datasetId, dataset, selected, date, metric };
  }

  rowMatchesIdentity(row, identity) {
    if (!row || !identity?.column) return false;
    return String(row[identity.column]) === String(identity.value);
  }

  rowMatchesBbox(row, bbox, dataset) {
    if (!row || !Array.isArray(bbox) || bbox.length !== 4) return false;
    const latColumn = dataset?.lat_column || "lat";
    const lonColumn = dataset?.lon_column || "lon";
    const lat = Number(row[latColumn]);
    const lon = normalizeLongitude(Number(row[lonColumn]));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const [west, south, east, north] = bbox.map(Number);
    return lon >= west && lon <= east && lat >= south && lat <= north;
  }

  valueForSelection(rows, selected, metric, dataset) {
    const bbox = this.selectedBbox(selected);
    if (bbox) {
      const matchedRows = (rows || []).filter((row) => this.rowMatchesBbox(row, bbox, dataset));
      const value = matchedRows.reduce((sum, row) => {
        const next = Number(row?.[metric] ?? 0);
        return sum + (Number.isFinite(next) ? next : 0);
      }, 0);
      return {
        row: matchedRows[0] || null,
        value,
        rowCount: matchedRows.length,
      };
    }
    const row = (rows || []).find((item) => this.rowMatchesIdentity(item, selected.identity));
    const value = Number(row?.[metric] ?? 0);
    return {
      row,
      value: Number.isFinite(value) ? value : 0,
      rowCount: row ? Number(row.source_rows || 1) : 0,
    };
  }

  layerLabel(datasetId, dataset) {
    const layerId = dataset?.layer_id || dataset?.runtime?.layer_id || datasetId;
    return String(layerId || datasetId || "layer").toUpperCase();
  }

  model() {
    const request = this.requestForCurrentState();
    if (request.blocked) return request.blocked;

    const rows = Array.isArray(state?.rows) ? state.rows : [];
    const { row, value, rowCount } = this.valueForSelection(rows, request.selected, request.metric, request.dataset);
    const total = Math.max(0, value);
    const label = this.layerLabel(request.datasetId, request.dataset);
    const detail = `${request.date} / ${request.selected.tile_key || request.selected.label || ""}`;
    return {
      state: total > 0 ? "ready" : "zero",
      title: total > 0 ? "網格切片比例" : "切片總量為 0",
      detail,
      date: request.date,
      metric: request.metric,
      totalLabel: request.metric,
      valueRole: "y",
      total,
      slices: [{
        label,
        datasetId: request.datasetId,
        layerId: request.dataset?.layer_id || request.datasetId,
        datasetLabel: request.dataset?.label || request.datasetId,
        yKey: request.metric,
        aggregation: "sum",
        value: total,
        color: "rgba(63, 191, 131, 0.96)",
        className: "legend-a",
      }],
      selection: request.selected,
      rowCount,
      recordsRowCount: rows.length,
    };
  }
}

class PieChartWidget extends ChartWidget {
  chartModel() {
    return PieChartDataSource.shared().model();
  }

  rows() {
    return this.dimensions().rows || 1;
  }

  usePlotlyRenderer({ expanded = false } = {}) {
    return expanded || this.rows() >= 2;
  }

  pieChartElementId() {
    return `${this.id}-pie-plotly`;
  }

  isReadyModel(model) {
    return model?.state === "ready"
      && Array.isArray(model.slices)
      && model.slices.some((slice) => Number(slice.value || 0) > 0);
  }

  renderPieState(container, model) {
    const sourceLabel = model?.state === "error"
      ? "pie chart error"
      : model?.state === "zero"
        ? "pie chart zero"
        : "pie chart source";
    this.renderChartEmptyState(container, model, sourceLabel);
  }

  dominantSlice(segments) {
    if (!segments.length) return null;
    return segments.reduce((winner, slice) => (slice.value > winner.value ? slice : winner), segments[0]);
  }

  pieLegend(segments) {
    return segments.map((slice) => `
      <span>
        <i class="${slice.className}"></i>
        <b>${lineChartEscape(slice.label)}</b>
        <em>${slice.percent}%</em>
      </span>
    `).join("");
  }

  pieChartData(segments, { expanded = false, cinema = false } = {}) {
    return [{
      type: "pie",
      labels: segments.map((slice) => slice.label),
      values: segments.map((slice) => slice.value),
      hole: cinema ? 0.5 : 0.58,
      sort: false,
      direction: "clockwise",
      textinfo: expanded ? "label+percent" : "percent",
      textposition: "inside",
      insidetextorientation: "radial",
      marker: {
        colors: segments.map((slice) => slice.color),
        line: { color: "rgba(15, 23, 42, 0.92)", width: 1 },
      },
      hovertemplate: "%{label}<br>Y: %{value}<br>%{percent}<extra></extra>",
    }];
  }

  pieChartLayout(model, { expanded = false, cinema = false } = {}) {
    return {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: cinema ? { l: 18, r: 18, t: 8, b: 8 } : expanded ? { l: 12, r: 12, t: 6, b: 6 } : { l: 4, r: 4, t: 2, b: 2 },
      autosize: true,
      showlegend: expanded,
      font: { color: "#cbd5e1", family: "Inter, system-ui, sans-serif", size: expanded ? 11 : 10 },
      legend: {
        orientation: "h",
        x: 0.5,
        y: -0.08,
        xanchor: "center",
        bgcolor: "rgba(0,0,0,0)",
        font: { color: "#cbd5e1", size: 10 },
      },
      annotations: [{
        text: model.totalLabel,
        x: 0.5,
        y: 0.5,
        showarrow: false,
        font: { color: "#94a3b8", size: cinema ? 12 : 10 },
      }],
    };
  }

  renderPiePlotlyWhenReady(container, model, segments, options = {}, attempt = 0) {
    const chart = container.querySelector("[data-widget-pie-plotly]");
    if (!chart) return;
    const rect = chart.getBoundingClientRect();
    const measurable = rect.width > 0 && rect.height > 0;
    if (!measurable && attempt < 6) {
      window.setTimeout(() => this.renderPiePlotlyWhenReady(container, model, segments, options, attempt + 1), 60);
      return;
    }
    if (!window.Plotly?.react) {
      chart.textContent = "Plotly 尚未載入";
      chart.classList.add("pipeline-chart-empty");
      return;
    }
    chart.classList.remove("pipeline-chart-empty");
    chart.textContent = "";
    const data = this.pieChartData(segments, options);
    const layout = this.pieChartLayout(model, options);
    const config = { responsive: true, displayModeBar: false, scrollZoom: false };
    Promise.resolve(window.Plotly.react(chart, data, layout, config)).then(() => {
      const resize = () => window.Plotly?.Plots?.resize?.(chart);
      window.requestAnimationFrame(() => {
        resize();
        window.requestAnimationFrame(resize);
      });
      window.setTimeout(resize, 120);
    }).catch((err) => {
      chart.textContent = err.message || "Plotly render failed";
      chart.classList.add("pipeline-chart-empty");
    });
  }

  renderSvgPieTemplate(container, model, segments) {
    const total = segments.reduce((sum, slice) => sum + slice.value, 0);
    const dominant = this.dominantSlice(segments);
    const gradient = `conic-gradient(${segments.map((slice) => `${slice.color} ${slice.start}% ${slice.end}%`).join(", ")})`;

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${dominant.percent}%</strong>
        <em>${lineChartEscape(dominant.label)}</em>
      </div>
      <div class="widget-pie-shape" style="--widget-pie-gradient: ${gradient}" aria-label="圓餅圖空白範本">
        <span class="widget-pie-center">
          <strong>${this.formatValue(total)}</strong>
          <em>${lineChartEscape(model.totalLabel)}</em>
        </span>
      </div>
      <div class="widget-legend-list">
        ${this.pieLegend(segments)}
      </div>
    `;
  }

  renderPlotlyPieTemplate(container, model, segments, { expanded = false, cinema = false } = {}) {
    const dominant = this.dominantSlice(segments);
    const total = segments.reduce((sum, slice) => sum + slice.value, 0);

    container.innerHTML = `
      <div class="widget-chart-header">
        <span>${lineChartEscape(model.title)}</span>
        <strong>${this.formatValue(total)}</strong>
        <em>${lineChartEscape(dominant.label)} / ${dominant.percent}%</em>
      </div>
      <div class="widget-pie-plotly-stage" data-widget-interactive="1">
        <div id="${this.pieChartElementId()}" class="pipeline-plotly-chart widget-pie-plotly-chart" data-widget-pie-plotly aria-label="圓餅圖工具預覽"></div>
      </div>
      <div class="widget-legend-list">
        ${this.pieLegend(segments)}
      </div>
    `;
    this.renderPiePlotlyWhenReady(container, model, segments, { expanded, cinema });
  }

  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-pie");
    if (expanded) container.classList.add("is-expanded");
    const model = this.chartModel();
    if (!this.isReadyModel(model)) {
      this.renderPieState(container, model);
      return;
    }
    const segments = this.pieSegments(model.slices);
    const shouldUsePlotly = this.usePlotlyRenderer({ expanded });
    container.classList.toggle("is-pie-plotly", shouldUsePlotly);
    container.classList.toggle("is-pie-svg", !shouldUsePlotly);
    if (shouldUsePlotly) {
      this.renderPlotlyPieTemplate(container, model, segments, { expanded, cinema });
      return;
    }
    this.renderSvgPieTemplate(container, model, segments);
  }
}

class TableWidget extends DashboardWidget {
  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-table");
    if (expanded) container.classList.add("is-expanded");
    container.innerHTML = `
      <table class="widget-table-template" aria-label="表格空白範本">
        <thead>
          <tr><th>時間</th><th>指標</th><th>值</th></tr>
        </thead>
        <tbody>
          <tr><td>X1</td><td>Y1</td><td>--</td></tr>
          <tr><td>X2</td><td>Y2</td><td>--</td></tr>
          <tr><td>X3</td><td>Y3</td><td>--</td></tr>
        </tbody>
      </table>
    `;
  }
}

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

class MetricsWidget extends DashboardWidget {
  renderTemplate(container, { expanded = false, cinema = false } = {}) {
    container.classList.add("widget-template", "widget-template-metrics");
    if (expanded) container.classList.add("is-expanded");
    if (expanded && cinema) {
      this.renderCinemaMetricsTemplate(container);
    } else if (expanded) {
      this.renderExpandedMetricsTemplate(container);
    } else {
      this.renderCompactMetricsTemplate(container);
    }
    this.bindTelemetry(container);
  }

  renderCompactMetricsTemplate(container) {
    container.dataset.metricsView = "compact";
    container.innerHTML = `
      <div class="widget-metrics-hero">
        <span data-widget-metric-value="headlineLabel">等待資料</span>
        <strong data-widget-metric-value="headline">-</strong>
        <em data-widget-metric-value="headlineHint">最新測速</em>
      </div>
      <div class="widget-metrics-pipeline" aria-label="測速 pipeline">
        <span data-widget-metric-segment="query" style="--segment-share: 1"><i></i><b>SQL</b></span>
        <span data-widget-metric-segment="api" style="--segment-share: 1"><i></i><b>API</b></span>
        <span data-widget-metric-segment="draw" style="--segment-share: 1"><i></i><b>繪製</b></span>
      </div>
      <div class="widget-metrics-foot">
        <span data-widget-metric-value="rows">- rows</span>
        <span data-widget-metric-value="playback">等待播放事件</span>
      </div>
    `;
  }

  renderCinemaMetricsTemplate(container) {
    container.dataset.metricsView = "cinema";
    container.innerHTML = `
      <div class="widget-metrics-cinema-top">
        <div class="widget-metrics-cinema-head">
          <span data-widget-metric-value="headlineLabel">等待資料</span>
          <strong data-widget-metric-value="headline">-</strong>
          <em data-widget-metric-value="rows">- rows</em>
        </div>
        <div class="widget-metrics-pipeline is-expanded is-cinema" aria-label="測速 pipeline 詳細">
          <span data-widget-metric-segment="query" style="--segment-share: 1"><i></i><b>SQL</b></span>
          <span data-widget-metric-segment="api" style="--segment-share: 1"><i></i><b>API</b></span>
          <span data-widget-metric-segment="draw" style="--segment-share: 1"><i></i><b>繪製</b></span>
        </div>
        <div class="widget-metrics-detail-grid is-cinema">
          <span><b data-widget-metric-value="query">-</b><em>SQL</em></span>
          <span><b data-widget-metric-value="serialize">-</b><em>序列化</em></span>
          <span><b data-widget-metric-value="api">-</b><em>API</em></span>
          <span><b data-widget-metric-value="draw">-</b><em>繪製</em></span>
          <span><b data-widget-metric-value="interaction">-</b><em>互動延遲</em></span>
          <span><b data-widget-metric-value="eez">-</b><em>EEZ</em></span>
        </div>
      </div>
        <div class="widget-metrics-history-panel" data-widget-history-panel data-widget-interactive="1">
        <div class="widget-metrics-history-head">
          <div>
            <span>目標時間序列變化記錄</span>
            <em data-widget-metric-value="historyRange">等待快照</em>
          </div>
          <strong data-widget-metric-value="historySummary">0 records</strong>
        </div>
        <div class="widget-metrics-history-chart-wrap">
          <div id="${this.historyChartElementId()}" class="pipeline-plotly-chart widget-metrics-plotly-chart" data-widget-history-plotly aria-label="目標時間序列測速折線圖"></div>
        </div>
      </div>
    `;
  }

  renderExpandedMetricsTemplate(container) {
    container.dataset.metricsView = "expanded";
    container.innerHTML = `
      <div class="widget-metrics-expanded-head">
        <div>
          <span data-widget-metric-value="headlineLabel">等待資料</span>
          <strong data-widget-metric-value="headline">-</strong>
        </div>
        <em data-widget-metric-value="rows">- rows</em>
      </div>
      <div class="widget-metrics-pipeline is-expanded" aria-label="測速 pipeline 詳細">
        <span data-widget-metric-segment="query" style="--segment-share: 1"><i></i><b>SQL</b></span>
        <span data-widget-metric-segment="api" style="--segment-share: 1"><i></i><b>API</b></span>
        <span data-widget-metric-segment="draw" style="--segment-share: 1"><i></i><b>繪製</b></span>
      </div>
      <div class="widget-metrics-detail-grid">
        <span><b data-widget-metric-value="query">-</b><em>SQL</em></span>
        <span><b data-widget-metric-value="serialize">-</b><em>序列化</em></span>
        <span><b data-widget-metric-value="api">-</b><em>API</em></span>
        <span><b data-widget-metric-value="draw">-</b><em>繪製</em></span>
        <span><b data-widget-metric-value="interaction">-</b><em>互動延遲</em></span>
        <span><b data-widget-metric-value="eez">-</b><em>EEZ</em></span>
      </div>
      <div class="widget-metrics-expanded-foot">
        <span>播放事件</span>
        <strong data-widget-metric-value="playback">等待播放事件</strong>
      </div>
    `;
  }

  timingMetricsApi() {
    if (typeof window !== "undefined" && window.TimingMetrics) return window.TimingMetrics;
    if (typeof TimingMetrics !== "undefined") return TimingMetrics;
    return null;
  }

  metricText(packet, key) {
    return packet?.metrics?.[key]?.text || "-";
  }

  metricNumber(packet, key) {
    const value = Number(packet?.metrics?.[key]?.value);
    return Number.isFinite(value) ? value : 0;
  }

  latestPlaybackText(packet) {
    const events = packet?.details?.playbackEvents || [];
    const latest = events[events.length - 1];
    return latest?.text && latest.text !== "-" ? latest.text : this.metricText(packet, "playback");
  }

  primaryMetric(packet) {
    const candidates = [
      { key: "client", label: "到畫面", hint: "最新快照" },
      { key: "eez", label: "EEZ", hint: "靜態圖層" },
      { key: "draw", label: "繪製", hint: "renderer" },
      { key: "api", label: "API", hint: "傳輸" },
      { key: "query", label: "SQL", hint: "查詢" },
      { key: "interaction", label: "互動延遲", hint: "操作" },
    ];
    const found = candidates.find(({ key }) => {
      const metric = packet?.metrics?.[key];
      return metric?.text && metric.text !== "-";
    });
    if (!found) {
      return { label: "等待資料", value: "-", hint: "最新測速" };
    }
    return {
      label: found.label,
      value: this.metricText(packet, found.key),
      hint: found.hint,
    };
  }

  rowsText(packet) {
    const rows = packet?.details?.rows;
    if (rows === undefined || rows === null || rows === "" || rows === "-") return "- rows";
    return `${rows} rows`;
  }

  formatMsValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "-";
    return `${numeric.toFixed(1)} ms`;
  }

  historySamples(packet) {
    const history = Array.isArray(packet?.snapshotHistory) ? packet.snapshotHistory : [];
    return history.filter((sample) => (
      ["total", "query", "api", "draw"].some((key) => Number.isFinite(Number(sample?.[key])))
    ));
  }

  historyRangeText(samples) {
    if (!samples.length) return "等待快照";
    const first = samples[0]?.label || "#1";
    const last = samples[samples.length - 1]?.label || `#${samples.length}`;
    return first === last ? first : `${first} - ${last}`;
  }

  historySummaryText(samples) {
    if (!samples.length) return "0 records";
    const latest = samples[samples.length - 1];
    return `最近 ${samples.length} 張 / 最新 ${this.formatMsValue(latest?.total)}`;
  }

  historyChartElementId() {
    return `${this.id}-snapshot-performance-chart`;
  }

  statusText(packet) {
    const query = packet?.metrics?.query;
    if (query?.status === "pending") return "查詢中";
    if (query?.text && query.text !== "-" && !query.value) return query.text;
    if (this.metricNumber(packet, "client") > 0) return "已更新";
    if (this.metricNumber(packet, "eez") > 0) return "靜態圖層就緒";
    return "等待資料";
  }

  bindTelemetry(container) {
    const api = this.timingMetricsApi();
    const update = (packet) => this.updateTelemetryView(container, packet);
    if (!api?.subscribe) {
      update(api?.snapshot?.() || null);
      return;
    }
    let wasConnected = false;
    let unsubscribe = null;
    unsubscribe = api.subscribe((packet) => {
      if (container.isConnected) wasConnected = true;
      if (!container.isConnected && wasConnected) {
        unsubscribe?.();
        return;
      }
      update(packet);
    });
  }

  updateTelemetryView(container, packet) {
    const setText = (key, value) => {
      container.querySelectorAll(`[data-widget-metric-value="${key}"]`).forEach((node) => {
        node.textContent = value;
      });
    };
    const primary = this.primaryMetric(packet);
    const playback = this.latestPlaybackText(packet);
    setText("headlineLabel", primary.label);
    setText("headline", primary.value);
    setText("headlineHint", primary.hint);
    setText("client", this.metricText(packet, "client"));
    setText("status", this.statusText(packet));
    setText("query", this.metricText(packet, "query"));
    setText("serialize", this.metricText(packet, "serialize"));
    setText("api", this.metricText(packet, "api"));
    setText("draw", this.metricText(packet, "draw"));
    setText("eez", this.metricText(packet, "eez"));
    setText("rows", this.rowsText(packet));
    setText("playback", playback && playback !== "-" ? playback : "等待播放事件");
    setText("interaction", this.metricText(packet, "interaction"));
    this.updateHistoryChart(container, packet, setText);

    const values = ["query", "api", "draw"].map((key) => this.metricNumber(packet, key));
    const scale = Math.max(...values, 1);
    ["query", "api", "draw"].forEach((key) => {
      const segments = container.querySelectorAll(`[data-widget-metric-segment="${key}"]`);
      const value = this.metricNumber(packet, key);
      const share = value > 0 ? Math.max(0.12, value / scale) : 0.12;
      segments.forEach((segment) => {
        segment.style.setProperty("--segment-share", String(share));
        segment.dataset.metricStatus = packet?.metrics?.[key]?.status || "idle";
      });
    });
  }

  updateHistoryChart(container, packet, setText) {
    const panel = container.querySelector("[data-widget-history-panel]");
    if (!panel) return;
    const samples = this.historySamples(packet);
    setText("historyRange", this.historyRangeText(samples));
    setText("historySummary", this.historySummaryText(samples));

    const chart = panel.querySelector("[data-widget-history-plotly]");
    if (!chart) return;
    const createChart = window.createSnapshotPerformanceChart;
    if (typeof createChart !== "function") {
      chart.textContent = "Plotly 測速元件尚未載入";
      chart.classList.add("pipeline-chart-empty");
      return;
    }
    if (!chart.__snapshotPerformanceChart) {
      chart.__snapshotPerformanceChart = createChart({ elementId: chart.id });
    }
    chart.__snapshotPerformanceChart.renderWhenReady(samples);
  }
}

class BlankWidget extends DashboardWidget {}

function createWidgetCatalog() {
  return [
    new WidgetCatalogItem({ id: "blank-1x1", title: "空白 Widgets", size: "1x1", description: "1x1 空白版型。", group: "new", kind: "size" }),
    new WidgetCatalogItem({ id: "blank-1x2", title: "空白 Widgets", size: "1x2", description: "1x2 空白版型。", group: "new", kind: "size" }),
    new WidgetCatalogItem({ id: "blank-1x3", title: "空白 Widgets", size: "1x3", description: "1x3 空白版型。", group: "new", kind: "size" }),
    new WidgetCatalogItem({ id: "blank-2x2", title: "空白 Widgets", size: "2x2", description: "2x2 空白版型。", group: "new", kind: "size" }),
    new WidgetCatalogItem({ id: "blank-2x3", title: "空白 Widgets", size: "2x3", description: "2x3 空白版型。", group: "new", kind: "size" }),
    new WidgetCatalogItem({ id: "line-chart", title: "折線圖工具", size: "2x2", supportedSizes: WidgetSizeAbleDict["line-chart"], description: "時間序列指標。", group: "registered" }),
    new WidgetCatalogItem({ id: "pie-chart", title: "圓餅圖工具", size: "1x1", supportedSizes: WidgetSizeAbleDict["pie-chart"], description: "圖層 Y 值比例。", group: "registered" }),
    new WidgetCatalogItem({ id: "table", title: "表格工具", size: "2x2", supportedSizes: WidgetSizeAbleDict.table, description: "資料列與欄位檢視。", group: "registered" }),
    new WidgetCatalogItem({ id: "map-jump", title: "窗格跳轉工具", size: "1x2", supportedSizes: WidgetSizeAbleDict["map-jump"], description: "常用視角與區域入口。", group: "registered" }),
    new WidgetCatalogItem({ id: "metrics", title: "測速工具", size: "1x2", supportedSizes: WidgetSizeAbleDict.metrics, description: "已註冊的效能觀測圖表。", group: "registered", deletable: false }),
  ];
}

function createWidgetFromCatalogItem(catalogItem, { id, slotIndex = null }) {
  if (catalogItem.kind === "size") {
    return new BlankWidget({
      id,
      size: catalogItem.size,
      title: "空白版型",
      status: "",
      slotIndex,
      widgetType: "blank",
      deletable: true,
    });
  }
  const constructors = {
    "line-chart": LineChartWidget,
    "pie-chart": PieChartWidget,
    table: TableWidget,
    "map-jump": MapJumpWidget,
    metrics: MetricsWidget,
  };
  const WidgetClass = constructors[catalogItem.id] || DashboardWidget;
  return new WidgetClass({
    id,
    title: catalogItem.title,
    size: catalogItem.size,
    status: catalogItem.description,
    slotIndex,
    deletable: catalogItem.deletable,
    widgetType: catalogItem.id,
  });
}

function createWidgetFromRegisteredItem(registeredItem, sourceWidget) {
  if (!registeredItem || !registeredItem.supportsSize(sourceWidget.size)) return null;
  const constructors = {
    "line-chart": LineChartWidget,
    "pie-chart": PieChartWidget,
    table: TableWidget,
    "map-jump": MapJumpWidget,
    metrics: MetricsWidget,
  };
  const WidgetClass = constructors[registeredItem.id] || DashboardWidget;
  return new WidgetClass({
    id: sourceWidget.id,
    title: registeredItem.title,
    size: sourceWidget.size,
    status: registeredItem.description,
    slotIndex: sourceWidget.slotIndex,
    deletable: registeredItem.deletable,
    widgetType: registeredItem.id,
  });
}

function createBlankWidgetFromWidget(sourceWidget) {
  return new BlankWidget({
    id: sourceWidget.id,
    title: "空白版型",
    size: sourceWidget.size,
    status: "",
    slotIndex: sourceWidget.slotIndex,
    deletable: true,
    widgetType: "blank",
  });
}

class WidgetPopoverController {
  static shared() {
    if (!WidgetPopoverController.instance) {
      WidgetPopoverController.instance = new WidgetPopoverController();
    }
    return WidgetPopoverController.instance;
  }

  constructor() {
    this.layer = document.createElement("div");
    this.layer.className = "widget-popover-layer";
    this.layer.hidden = true;
    this.layer.style.display = "none";
    this.layer.style.pointerEvents = "none";
    this.layer.addEventListener("click", (event) => {
      if (event.target === this.layer) {
        this.close();
      }
    });
    document.body.append(this.layer);
    this.openWidget = null;
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    });
  }

  openExpanded(widget, { onSettings } = {}) {
    this.openWidget = widget;
    this.layer.style.display = "";
    this.layer.style.pointerEvents = "";
    this.layer.classList.remove("is-marketplace-layer");
    const pane = widget.renderExpanded();
    pane.dataset.widgetView = "detail";
    this.layer.replaceChildren(pane);
    this.layer.hidden = false;
    bindWidgetPointerBehavior(pane, {
      onPrimary: () => this.expandToCinema(widget, pane),
      onSettings: () => {
        if (typeof onSettings === "function") {
          onSettings(widget);
          return;
        }
        this.openSettings(widget);
      },
    });
  }

  expandToCinema(widget, pane) {
    if (!pane) return;
    if (pane.dataset.widgetView === "cinema") {
      this.close();
      return;
    }
    pane.dataset.widgetView = "cinema";
    pane.classList.add("is-cinema");
    const body = pane.querySelector(".widget-popover-body");
    if (body) {
      body.replaceChildren();
      widget.renderTemplate(body, { expanded: true, cinema: true });
    }
  }

  openSettings(widget, { onDelete, onConfigure, catalogItems = [] } = {}) {
    this.openWidget = null;
    this.layer.classList.remove("is-marketplace-layer");
    this.layer.style.display = "";
    this.layer.style.pointerEvents = "";
    this.layer.replaceChildren(widget.renderSettings({ onDelete, onConfigure, catalogItems }));
    this.layer.hidden = false;
  }

  openPanelSettings(panel) {
    this.openWidget = null;
    this.layer.classList.add("is-marketplace-layer");
    this.layer.style.display = "";
    this.layer.style.pointerEvents = "";
    this.layer.replaceChildren(panel.renderSettings());
    this.layer.hidden = false;
    const closeButton = this.layer.querySelector("[data-widgets-marketplace-close]");
    bindWidgetActionButton(closeButton, () => this.close());
    if (typeof ControlButtons !== "undefined") {
      ControlButtons.renderIcons?.();
    }
  }

  close() {
    this.openWidget = null;
    forceCloseWidgetPopoverLayers();
  }

  refreshOpenWidgetType(widgetType) {
    if (this.layer.hidden || this.openWidget?.widgetType !== widgetType) return;
    const pane = this.layer.querySelector(".widget-popover");
    const body = pane?.querySelector(".widget-popover-body");
    if (!pane || !body) return;
    body.replaceChildren();
    this.openWidget.renderTemplate(body, {
      expanded: true,
      cinema: pane.dataset.widgetView === "cinema",
    });
  }
}

class WidgetsPanel {
  constructor({ root, board, socketGrid, grid, configButton, widgets = [], popover = WidgetPopoverController.shared() }) {
    this.root = root;
    this.board = board;
    this.socketGrid = socketGrid;
    this.grid = grid;
    this.configButton = configButton;
    this.widgets = widgets;
    this.popover = popover;
    this.socketLayout = new WidgetSocketLayout({
      root,
      board,
      socketGrid,
      widgetGrid: grid,
    });
    this.draggedWidget = null;
    this.draggedCatalogItem = null;
    this.dropPreview = null;
    this.nextWidgetSerial = 1;
  }

  mount() {
    if (!this.grid) return;
    this.socketLayout.sync();
    this.ensureDropPreview();
    this.normalizeWidgetPlacements();
    this.renderWidgets();
    this.bindDropzone();
    if (this.configButton) {
      bindWidgetActionButton(this.configButton, () => this.openPanelSettings());
    }
    if (typeof ControlButtons !== "undefined") {
      ControlButtons.renderIcons?.();
    }
    this.observeResize();
  }

  observeResize() {
    if (!window.ResizeObserver || !this.board) return;
    this.resizeObserver = new ResizeObserver(() => {
      this.socketLayout.sync();
      this.normalizeWidgetPlacements();
      this.applyWidgetPlacements();
    });
    this.resizeObserver.observe(this.board);
  }

  columns() {
    return this.socketLayout.columns;
  }

  rows() {
    return Number.parseInt(this.root?.dataset.widgetsRowsResolved || "1", 10);
  }

  beginWidgetDrag(widget) {
    this.draggedWidget = widget;
  }

  renderWidgets() {
    this.grid?.replaceChildren(...this.widgets.map((widget) => widget.render(this)));
  }

  refreshWidgetsByType(widgetType) {
    for (const widget of this.widgets) {
      if (widget.widgetType !== widgetType) continue;
      const node = this.grid?.querySelector(`[data-widget-id="${widget.id}"]`);
      const body = node?.querySelector(".dashboard-widget-body");
      if (!body) continue;
      body.replaceChildren();
      widget.renderTemplate(body, { expanded: false });
    }
  }

  endWidgetDrag() {
    this.draggedWidget = null;
    this.clearDropState();
  }

  beginCatalogDrag(catalogItem) {
    this.draggedCatalogItem = catalogItem;
  }

  endCatalogDrag() {
    this.draggedCatalogItem = null;
    this.clearDropState();
  }

  bindDropzone() {
    if (!this.board || this.board.dataset.widgetDropzoneBound === "1") return;
    this.board.dataset.widgetDropzoneBound = "1";
    bindWidgetDragBehavior(this.board, {
      kind: "dropzone",
      onDrop: (event) => this.dropDraggedWidgetAtPoint(event.clientX, event.clientY),
      onDragEnd: () => this.clearDropState(),
    });
  }

  ensureDropPreview() {
    if (!this.board) return null;
    if (this.dropPreview) return this.dropPreview;
    const preview = document.createElement("div");
    preview.className = "widget-drop-preview";
    preview.hidden = true;
    preview.setAttribute("aria-hidden", "true");
    this.board.append(preview);
    this.dropPreview = preview;
    return preview;
  }

  slotIndexFromPoint(clientX, clientY) {
    if (!this.socketGrid) return this.widgetSlotIndexFromPoint(clientX, clientY);
    const rect = this.socketGrid.getBoundingClientRect();
    const style = window.getComputedStyle(this.board);
    const slotSize = Number.parseFloat(style.getPropertyValue("--widget-slot-size"));
    const gap = Number.parseFloat(style.getPropertyValue("--widget-slot-gap"));
    if (!Number.isFinite(slotSize) || !Number.isFinite(gap) || slotSize <= 0) {
      return this.widgetSlotIndexFromPoint(clientX, clientY);
    }

    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0) return this.widgetSlotIndexFromPoint(clientX, clientY);

    const pitch = slotSize + gap;
    const column = Math.floor(x / pitch);
    const row = Math.floor(y / pitch);
    const insideColumn = x - column * pitch;
    const insideRow = y - row * pitch;
    if (
      column < 0 ||
      row < 0 ||
      column >= this.columns() ||
      row >= this.rows() ||
      insideColumn > slotSize ||
      insideRow > slotSize
    ) {
      return this.widgetSlotIndexFromPoint(clientX, clientY);
    }
    return row * this.columns() + column;
  }

  widgetSlotIndexFromPoint(clientX, clientY) {
    const widgets = Array.from(this.grid?.querySelectorAll(".dashboard-widget") || []);
    const target = widgets.find((widget) => {
      const rect = widget.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
    if (!target) return null;
    const slotIndex = Number.parseInt(target.dataset.widgetSlotIndex, 10);
    return Number.isInteger(slotIndex) ? slotIndex : null;
  }

  updateDragAtPoint(clientX, clientY) {
    if (!this.draggedWidget || !this.root) return;
    const slotIndex = this.slotIndexFromPoint(clientX, clientY);
    this.root.dataset.widgetsDropSlot = slotIndex === null ? "" : String(slotIndex);
    const canPlace = slotIndex !== null && this.canPlaceWidgetAt(this.draggedWidget, slotIndex);
    this.root.dataset.widgetsDropState = canPlace ? "valid" : "invalid";
    this.updateDropPreview(this.draggedWidget, slotIndex, canPlace);
  }

  updateCatalogDragAtPoint(catalogItem, clientX, clientY) {
    if (!this.draggedCatalogItem || this.draggedCatalogItem !== catalogItem || !this.root) return;
    const slotIndex = this.slotIndexFromPoint(clientX, clientY);
    const replacementTarget = this.replacementTargetForCatalogAt(catalogItem, slotIndex);
    const previewSlotIndex = replacementTarget?.slotIndex ?? slotIndex;
    this.root.dataset.widgetsDropSlot = slotIndex === null ? "" : String(slotIndex);
    const canPlace = slotIndex !== null && (
      this.canPlaceWidgetAt(catalogItem, slotIndex) ||
      Boolean(replacementTarget)
    );
    this.root.dataset.widgetsDropState = canPlace ? "valid" : "invalid";
    this.updateDropPreview(catalogItem, previewSlotIndex, canPlace);
  }

  dropDraggedWidgetAtPoint(clientX, clientY) {
    if (!this.draggedWidget) return;
    const slotIndex = this.slotIndexFromPoint(clientX, clientY);
    if (slotIndex === null || !this.canPlaceWidgetAt(this.draggedWidget, slotIndex)) {
      this.clearDropState();
      return;
    }
    this.draggedWidget.placeAt(slotIndex, this.columns(), this.rows());
    this.applyWidgetPlacement(this.draggedWidget);
    this.clearDropState();
  }

  dropCatalogItemAtPoint(catalogItem, clientX, clientY) {
    if (!this.draggedCatalogItem || this.draggedCatalogItem !== catalogItem) return;
    const slotIndex = this.slotIndexFromPoint(clientX, clientY);
    if (slotIndex === null) {
      this.clearDropState();
      return;
    }
    if (this.canPlaceWidgetAt(catalogItem, slotIndex)) {
      this.addWidgetFromCatalog(catalogItem, slotIndex);
      this.clearDropState();
      return;
    }
    const replacementTarget = this.replacementTargetForCatalogAt(catalogItem, slotIndex);
    if (replacementTarget) {
      this.replaceWidgetWithRegisteredItem(replacementTarget, catalogItem);
    }
    this.clearDropState();
  }

  widgetAtSlot(slotIndex) {
    if (!Number.isInteger(slotIndex)) return null;
    return this.widgets.find((widget) => {
      const slots = this.slotsFor(widget, widget.slotIndex);
      return Boolean(slots && slots.includes(slotIndex));
    }) || null;
  }

  replacementTargetForCatalogAt(catalogItem, slotIndex) {
    if (!catalogItem || catalogItem.kind === "size") return null;
    const targetWidget = this.widgetAtSlot(slotIndex);
    if (!targetWidget || targetWidget.widgetType !== "blank") return null;
    if (!catalogItem.supportsSize(targetWidget.size)) return null;
    return targetWidget;
  }

  replaceWidgetWithRegisteredItem(targetWidget, catalogItem) {
    const index = this.widgets.findIndex((widget) => widget.id === targetWidget.id);
    if (index < 0) return false;
    const nextWidget = createWidgetFromRegisteredItem(catalogItem, targetWidget);
    if (!nextWidget) return false;
    this.widgets[index] = nextWidget;
    this.renderWidgets();
    return true;
  }

  addWidgetFromCatalog(catalogItem, slotIndex) {
    const serial = this.nextWidgetSerial;
    this.nextWidgetSerial += 1;
    const widget = createWidgetFromCatalogItem(catalogItem, {
      id: `${this.scope()}-${catalogItem.id}-${serial}`,
      slotIndex,
    });
    if (widget.placeAt(slotIndex, this.columns(), this.rows()) === null) return null;
    this.widgets.push(widget);
    this.grid?.append(widget.render(this));
    return widget;
  }

  slotsFor(widget, slotIndex) {
    if (!widget || !Number.isInteger(slotIndex)) return null;
    const dimensions = widget.dimensions();
    const columns = this.columns();
    const rows = this.rows();
    const column = slotIndex % columns;
    const row = Math.floor(slotIndex / columns);
    if (
      column < 0 ||
      row < 0 ||
      column + dimensions.columns > columns ||
      row + dimensions.rows > rows
    ) {
      return null;
    }
    const slots = [];
    for (let rowOffset = 0; rowOffset < dimensions.rows; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < dimensions.columns; columnOffset += 1) {
        slots.push((row + rowOffset) * columns + column + columnOffset);
      }
    }
    return slots;
  }

  occupiedSlots(excludingWidget = null) {
    const occupied = new Set();
    for (const widget of this.widgets) {
      if (widget === excludingWidget || widget.slotIndex === null) continue;
      const slots = this.slotsFor(widget, widget.slotIndex);
      if (!slots) continue;
      for (const slot of slots) occupied.add(slot);
    }
    return occupied;
  }

  canPlaceWidgetAt(widget, slotIndex, occupied = this.occupiedSlots(widget)) {
    const slots = this.slotsFor(widget, slotIndex);
    return Boolean(slots && slots.every((slot) => !occupied.has(slot)));
  }

  findFirstAvailableSlot(widget, occupied) {
    const total = this.columns() * this.rows();
    for (let slotIndex = 0; slotIndex < total; slotIndex += 1) {
      if (this.canPlaceWidgetAt(widget, slotIndex, occupied)) {
        return slotIndex;
      }
    }
    return null;
  }

  normalizeWidgetPlacements() {
    const occupied = new Set();
    for (const widget of this.widgets) {
      let slotIndex = widget.slotIndex;
      if (slotIndex === null || !this.canPlaceWidgetAt(widget, slotIndex, occupied)) {
        slotIndex = this.findFirstAvailableSlot(widget, occupied);
      }
      widget.slotIndex = slotIndex;
      const slots = this.slotsFor(widget, slotIndex);
      if (!slots) continue;
      for (const slot of slots) occupied.add(slot);
    }
  }

  applyWidgetPlacements() {
    for (const widget of this.widgets) {
      this.applyWidgetPlacement(widget);
    }
  }

  applyWidgetPlacement(widget) {
    const node = this.grid?.querySelector(`[data-widget-id="${widget.id}"]`);
    widget.applyPlacement(node, this.columns());
  }

  clearDropState() {
    if (!this.root) return;
    delete this.root.dataset.widgetsDropSlot;
    delete this.root.dataset.widgetsDropState;
    if (this.dropPreview) {
      this.dropPreview.hidden = true;
      this.dropPreview.removeAttribute("style");
    }
  }

  updateDropPreview(widget, slotIndex, canPlace) {
    const preview = this.ensureDropPreview();
    if (!preview || !widget || slotIndex === null) {
      if (preview) preview.hidden = true;
      return;
    }
    const rect = this.previewRectForSlot(widget, slotIndex);
    if (!rect) {
      preview.hidden = true;
      return;
    }
    preview.hidden = false;
    preview.style.left = `${rect.left}px`;
    preview.style.top = `${rect.top}px`;
    preview.style.width = `${rect.width}px`;
    preview.style.height = `${rect.height}px`;
    preview.dataset.widgetsDropValid = canPlace ? "1" : "0";
  }

  previewRectForSlot(widget, slotIndex) {
    if (!this.board || !this.socketGrid) return null;
    const dimensions = widget.dimensions();
    const boardRect = this.board.getBoundingClientRect();
    const socketRect = this.socketGrid.getBoundingClientRect();
    const boardStyle = window.getComputedStyle(this.board);
    const slotSize = Number.parseFloat(boardStyle.getPropertyValue("--widget-slot-size"));
    const gap = Number.parseFloat(boardStyle.getPropertyValue("--widget-slot-gap"));
    if (!Number.isFinite(slotSize) || !Number.isFinite(gap) || slotSize <= 0) return null;

    const columns = this.columns();
    const column = slotIndex % columns;
    const row = Math.floor(slotIndex / columns);
    const pitch = slotSize + gap;
    return {
      left: socketRect.left - boardRect.left + column * pitch,
      top: socketRect.top - boardRect.top + row * pitch,
      width: dimensions.columns * slotSize + (dimensions.columns - 1) * gap,
      height: dimensions.rows * slotSize + (dimensions.rows - 1) * gap,
    };
  }

  expandWidget(widget) {
    this.popover.openExpanded(widget, {
      onSettings: () => this.openWidgetSettings(widget),
    });
  }

  openWidgetSettings(widget) {
    this.popover.openSettings(widget, {
      onDelete: () => this.removeWidget(widget),
      onConfigure: (_widget, widgetType) => this.configureWidgetType(_widget, widgetType),
      catalogItems: this.registeredCatalogItems(),
    });
  }

  registeredCatalogItems() {
    return createWidgetCatalog().filter((item) => item.group === "registered");
  }

  configureWidgetType(widget, widgetType) {
    const index = this.widgets.findIndex((item) => item.id === widget.id);
    if (index < 0) return false;
    const currentWidget = this.widgets[index];
    let nextWidget = null;
    if (widgetType === "blank") {
      nextWidget = createBlankWidgetFromWidget(currentWidget);
    } else {
      const registeredItem = this.registeredCatalogItems().find((item) => item.id === widgetType);
      nextWidget = createWidgetFromRegisteredItem(registeredItem, currentWidget);
    }
    if (!nextWidget) return false;
    this.widgets[index] = nextWidget;
    this.renderWidgets();
    this.openWidgetSettings(nextWidget);
    return true;
  }

  removeWidget(widget) {
    const index = this.widgets.findIndex((item) => item.id === widget.id);
    if (index < 0) return false;
    if (this.widgets[index].deletable === false) return false;
    this.widgets.splice(index, 1);
    this.clearDropState();
    this.renderWidgets();
    this.popover.close();
    forceCloseWidgetPopoverLayers();
    return true;
  }

  openPanelSettings() {
    this.popover.openPanelSettings(this);
  }

  renderSettings() {
    const pane = document.createElement("section");
    pane.className = "widget-settings-popover widgets-marketplace-popover";
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-modal", "false");
    pane.setAttribute("aria-label", `${this.title()} Widget 市集`);

    const header = document.createElement("div");
    header.className = "widgets-marketplace-header";

    const titleGroup = document.createElement("div");

    const title = document.createElement("h3");
    title.textContent = "Widget 市集";

    const scope = document.createElement("span");
    scope.textContent = this.title();

    titleGroup.append(title, scope);

    const closeButton = document.createElement("button");
    closeButton.className = "widgets-marketplace-close";
    closeButton.type = "button";
    closeButton.dataset.widgetsMarketplaceClose = "1";
    closeButton.setAttribute("aria-label", "關閉 Widget 市集");
    closeButton.innerHTML = widgetActionIcon("close");

    header.append(titleGroup, closeButton);

    const catalog = createWidgetCatalog();
    const drawers = document.createElement("div");
    drawers.className = "widgets-marketplace-drawers";
    drawers.append(
      new WidgetMarketplaceDrawer({
        id: "registered",
        title: "已註冊能力",
        items: catalog.filter((item) => item.group === "registered"),
        expanded: true,
      }).render(this),
      new WidgetMarketplaceDrawer({
        id: "new",
        title: "新增空白Widgets",
        items: catalog.filter((item) => item.group !== "registered"),
        expanded: false,
      }).render(this),
    );

    pane.append(header, drawers);
    return pane;
  }

  scope() {
    return this.root?.dataset.widgetsScope || "widgets";
  }

  title() {
    return this.root?.querySelector(".widgets-panel-header h2")?.textContent?.trim() || "Widgets";
  }
}

const DefaultDashboardWidgetLayout = Object.freeze([
  Object.freeze({ type: "line-chart", id: "line-chart-2x2", title: "折線圖工具", size: "2x2", status: "時間序列指標。", slotIndex: 0 }),
  Object.freeze({ type: "pie-chart", id: "pie-chart-2x3", title: "圓餅圖工具", size: "2x3", status: "單日切片比例。", slotIndex: 2 }),
  Object.freeze({ type: "map-jump", id: "map-jump-1x1", title: "窗格跳轉工具", size: "1x1", status: "", slotIndex: 5 }),
  Object.freeze({ type: "metrics", id: "metrics-1x2", title: "測速工具", size: "1x2", status: "", slotIndex: 12, deletable: false }),
]);

function createDashboardWidgetFromDefault(item, scope) {
  const params = {
    id: `${scope}-${item.id}`,
    title: item.title,
    size: item.size,
    status: item.status,
    slotIndex: item.slotIndex,
    deletable: item.deletable,
    widgetType: item.type,
  };
  if (item.type === "line-chart") return new LineChartWidget(params);
  if (item.type === "pie-chart") return new PieChartWidget(params);
  if (item.type === "map-jump") return new MapJumpWidget(params);
  if (item.type === "metrics") return new MetricsWidget(params);
  return new BlankWidget({ ...params, widgetType: "blank" });
}

function createDashboardWidgets(scope = "widgets") {
  return DefaultDashboardWidgetLayout.map((item) => createDashboardWidgetFromDefault(item, scope));
}

function initWidgetsPanels() {
  const panels = Array.from(document.querySelectorAll("[data-widgets-panel]")).map((root, index) => {
    const scope = root.dataset.widgetsScope || `widgets-${index + 1}`;
    const panel = new WidgetsPanel({
      root,
      board: root.querySelector("[data-widgets-board]"),
      socketGrid: root.querySelector("[data-widgets-socket-grid]"),
      grid: root.querySelector("[data-widgets-grid]"),
      configButton: root.querySelector("[data-widgets-config]"),
      widgets: createDashboardWidgets(scope),
    });
    panel.mount();
    return panel;
  });
  window.WidgetsPanelInstances = panels;
  window.WidgetsPanelInstance = panels[0] || null;
}

function refreshLineChartWidgets() {
  LineChartDataSource.shared().clear();
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.("line-chart");
  }
  WidgetPopoverController.shared().refreshOpenWidgetType("line-chart");
}

function refreshPieChartWidgets() {
  PieChartDataSource.shared().clear();
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.("pie-chart");
  }
  WidgetPopoverController.shared().refreshOpenWidgetType("pie-chart");
}

function refreshLineChartWidgetsForTileSelection(event) {
  if (!["selected", "disabled", "cleared"].includes(event?.detail?.reason)) return;
  refreshLineChartWidgets();
}

function refreshPieChartWidgetsForTileSelection(event) {
  if (!["selected", "disabled", "cleared"].includes(event?.detail?.reason)) return;
  refreshPieChartWidgets();
}

function bindChartWidgetRefresh() {
  window.addEventListener("rrkal:tile-selection-changed", (event) => {
    refreshLineChartWidgetsForTileSelection(event);
    refreshPieChartWidgetsForTileSelection(event);
  });
  window.addEventListener("rrkal:schema-loaded", () => {
    refreshLineChartWidgets();
    refreshPieChartWidgets();
  });
  window.addEventListener("rrkal:records-updated", refreshPieChartWidgets);
  window.addEventListener("rrkal:line-chart-data-changed", () => {
    for (const panel of window.WidgetsPanelInstances || []) {
      panel.refreshWidgetsByType?.("line-chart");
    }
    WidgetPopoverController.shared().refreshOpenWidgetType("line-chart");
  });
  for (const id of ["start-date", "end-date", "dataset-select"]) {
    $(id)?.addEventListener("change", () => {
      window.setTimeout(refreshLineChartWidgets, 0);
    });
  }
  for (const id of ["date", "dataset-select"]) {
    $(id)?.addEventListener("change", () => {
      window.setTimeout(refreshPieChartWidgets, 0);
    });
  }
}

window.WidgetSizePresets = WidgetSizePresets;
window.WidgetSizeAbleDict = WidgetSizeAbleDict;
window.WidgetSocketLayout = WidgetSocketLayout;
window.bindWidgetPointerBehavior = bindWidgetPointerBehavior;
window.bindWidgetDragBehavior = bindWidgetDragBehavior;
window.DashboardWidget = DashboardWidget;
window.ChartWidget = ChartWidget;
window.LineChartDataSource = LineChartDataSource;
window.PieChartDataSource = PieChartDataSource;
window.LineChartWidget = LineChartWidget;
window.PieChartWidget = PieChartWidget;
window.TableWidget = TableWidget;
window.MapJumpWidget = MapJumpWidget;
window.MetricsWidget = MetricsWidget;
window.BlankWidget = BlankWidget;
window.WidgetPopoverController = WidgetPopoverController;
window.WidgetsPanel = WidgetsPanel;

initWidgetsPanels();
bindChartWidgetRefresh();
