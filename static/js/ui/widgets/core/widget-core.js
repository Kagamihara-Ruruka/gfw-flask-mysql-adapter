(() => {
function lineChartEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

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
  "horizontal-bar-chart": Object.freeze(["1x3"]),
  metrics: Object.freeze(["1x2", "2x2"]),
  "event-viewer": Object.freeze(["1x2", "2x2", "2x3"]),
  table: Object.freeze(["2x2"]),
  "map-jump": Object.freeze(["1x1", "1x2"]),
  "eez-attribution": Object.freeze(["1x1"]),
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
    ".widgets-panel, .widget-popover-layer, .widget-popover, .widget-settings-popover"
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
  if (typeof onSettings !== "function") return;
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
    const widthSlotSize = Math.max(1, Math.floor((contentWidth - (this.columns - 1) * this.gap) / this.columns));
    const rows = this.resolveRows(widthSlotSize, paddingY);
    const heightSlotSize = rows > 0 && contentHeight > 0
      ? Math.floor((contentHeight - (rows - 1) * this.gap) / rows)
      : widthSlotSize;
    const fittingSlotSize = Math.min(widthSlotSize, heightSlotSize);
    const slotSize = Math.max(1, fittingSlotSize);
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
    icon = "box",
    tone = "neutral",
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
    this.icon = icon;
    this.tone = tone;
  }

  supportsSize(size) {
    return this.supportedSizes ? this.supportedSizes.includes(size) : this.size === size;
  }

  dimensions() {
    return WidgetSizePresets[this.size] || WidgetSizePresets["1x1"];
  }
}

class DashboardWidget {
  constructor({
    id,
    title,
    size = "1x1",
    status = "待設計",
    slotIndex = null,
    deletable = true,
    widgetType = "blank",
    services = {},
  }) {
    this.id = id;
    this.title = title;
    this.size = this.normalizeSize(size);
    this.status = status;
    this.slotIndex = Number.isInteger(slotIndex) ? slotIndex : null;
    this.deletable = deletable !== false;
    this.widgetType = widgetType;
    this.services = Object.freeze({ ...services });
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

  dispose() {}

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

    this.renderCapabilitySettings?.({ pane, onConfigure });

    return pane;
  }
}

const widgetPlotlyResizeWarnings = new WeakSet();

class WidgetPlotlyLifecycle {
  static isDisplayed(chart) {
    if (!chart?.isConnected || typeof chart.getBoundingClientRect !== "function") return false;
    if (typeof chart.getClientRects === "function" && chart.getClientRects().length === 0) return false;
    const rect = chart.getBoundingClientRect();
    return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
  }

  static waitUntilDisplayed(chart, retry, { attempt = 0, maxAttempts = 6, delayMs = 60 } = {}) {
    if (this.isDisplayed(chart)) return true;
    if (attempt < maxAttempts && typeof retry === "function") {
      window.setTimeout(retry, delayMs);
    }
    return false;
  }

  static resize(chart) {
    if (!this.isDisplayed(chart) || typeof window.Plotly?.Plots?.resize !== "function") return false;
    try {
      window.Plotly.Plots.resize(chart);
      return true;
    } catch (error) {
      const hiddenElementError = /displayed plot div element/i.test(String(error?.message || error));
      if (!hiddenElementError && !widgetPlotlyResizeWarnings.has(chart)) {
        widgetPlotlyResizeWarnings.add(chart);
        console.warn("Widget Plotly resize failed", error);
      }
      return false;
    }
  }

  static scheduleResize(chart, { delayMs = 120 } = {}) {
    const resize = () => this.resize(chart);
    window.requestAnimationFrame(() => {
      resize();
      window.requestAnimationFrame(resize);
    });
    window.setTimeout(resize, delayMs);
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


window.WidgetCore = Object.freeze({
  WidgetSizePresets,
  WidgetSizeAbleDict,
  bindWidgetPointerBehavior,
  bindWidgetDragBehavior,
  bindWidgetActionButton,
  forceCloseWidgetPopoverLayers,
  lineChartEscape,
  WidgetSocketLayout,
  WidgetCatalogItem,
  DashboardWidget,
  WidgetPlotlyLifecycle,
  ChartWidget,
});
})();
