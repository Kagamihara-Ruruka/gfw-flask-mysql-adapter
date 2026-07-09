const WidgetSizePresets = Object.freeze({
  "1x1": Object.freeze({ id: "1x1", columns: 1, rows: 1 }),
  "1x2": Object.freeze({ id: "1x2", columns: 2, rows: 1 }),
  "1x3": Object.freeze({ id: "1x3", columns: 3, rows: 1 }),
  "2x2": Object.freeze({ id: "2x2", columns: 2, rows: 2 }),
  "2x3": Object.freeze({ id: "2x3", columns: 3, rows: 2 }),
});

function bindWidgetPointerBehavior(node, { onPrimary, onSettings }) {
  node.addEventListener("click", (event) => {
    if (node.dataset.widgetSuppressClick === "1") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onPrimary();
  });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    onSettings();
  });
}

function setWidgetSelectionLock(locked) {
  document.body?.classList.toggle("is-widget-pointer-dragging", Boolean(locked));
  if (!locked) {
    document.getSelection?.().removeAllRanges();
  }
}

function createWidgetDeleteButton(onDelete) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "widget-delete-button";
  button.title = "Delete widget";
  button.setAttribute("aria-label", "Delete widget");
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2Z"></path>
      <path d="M6 9h12l-1 12H7L6 9Z"></path>
      <path d="M10 11v7M14 11v7"></path>
    </svg>
  `;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onDelete?.();
  });
  return button;
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
  constructor({ id, title, size, description, group = "new", enabled = false, deletable = true }) {
    this.id = id;
    this.title = title;
    this.size = size;
    this.description = description;
    this.group = group;
    this.enabled = enabled;
    this.deletable = deletable !== false;
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
    card.tabIndex = 0;

    const preview = document.createElement("div");
    preview.className = `widget-product-preview widget-product-preview--${this.id}`;
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
    bindWidgetDragBehavior(card, {
      kind: "catalog",
      onDragStart: () => panel.beginCatalogDrag(this),
      onDragMove: (event) => panel.updateCatalogDragAtPoint(this, event.clientX, event.clientY),
      onDrop: (event) => panel.dropCatalogItemAtPoint(this, event.clientX, event.clientY),
      onDragEnd: () => panel.endCatalogDrag(),
    });
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
    const section = document.createElement("section");
    section.className = "widgets-marketplace-drawer";
    section.dataset.widgetsDrawerId = this.id;
    section.dataset.widgetsDrawerExpanded = this.expanded ? "1" : "0";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "widgets-marketplace-drawer-button";
    button.setAttribute("aria-expanded", this.expanded ? "true" : "false");

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

    button.append(title, count, chevron);
    button.addEventListener("click", () => {
      const nextExpanded = section.dataset.widgetsDrawerExpanded !== "1";
      section.dataset.widgetsDrawerExpanded = nextExpanded ? "1" : "0";
      button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
      body.hidden = !nextExpanded;
    });

    section.append(button, body);
    return section;
  }
}

class DashboardWidget {
  constructor({ id, title, size = "1x1", status = "待設計", slotIndex = null, deletable = true }) {
    this.id = id;
    this.title = title;
    this.size = this.normalizeSize(size);
    this.status = status;
    this.slotIndex = Number.isInteger(slotIndex) ? slotIndex : null;
    this.deletable = deletable !== false;
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

    const header = document.createElement("div");
    header.className = "dashboard-widget-header";

    const title = document.createElement("h3");
    title.className = "dashboard-widget-title";
    title.textContent = this.title;

    const sizeBadge = document.createElement("span");
    sizeBadge.className = "dashboard-widget-size";
    sizeBadge.textContent = this.size;

    const body = document.createElement("div");
    body.className = "dashboard-widget-body";
    this.renderTemplate(body, { expanded: false });

    header.append(title, sizeBadge);
    item.append(header, body);
    this.applyPlacement(item, controller.columns());
    bindWidgetPointerBehavior(item, {
      onPrimary: () => controller.expandWidget(this),
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

  renderSettings({ onDelete } = {}) {
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
    if (this.deletable) {
      header.append(createWidgetDeleteButton(() => onDelete?.(this)));
    }

    const nameRow = document.createElement("div");
    nameRow.className = "widget-settings-row";
    nameRow.innerHTML = `<span>名稱</span><strong>${this.title}</strong>`;

    const sizeRow = document.createElement("div");
    sizeRow.className = "widget-settings-row";
    sizeRow.innerHTML = `<span>尺寸</span><strong>${this.size}</strong>`;

    pane.append(header, nameRow, sizeRow);
    return pane;
  }
}

class LineChartWidget extends DashboardWidget {
  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-line");
    if (expanded) container.classList.add("is-expanded");
    container.innerHTML = `
      <div class="widget-chart-shell">
        <div class="widget-axis-label widget-axis-y">Y</div>
        <svg class="widget-line-chart" viewBox="0 0 180 92" role="img" aria-label="折線圖空白範本">
          <path class="widget-grid-line" d="M24 14H172M24 38H172M24 62H172" />
          <path class="widget-axis-line" d="M24 8V78H174" />
          <polyline class="widget-line-primary" points="24,66 62,42 100,55 138,24 172,34" />
          <circle cx="24" cy="66" r="3" />
          <circle cx="62" cy="42" r="3" />
          <circle cx="100" cy="55" r="3" />
          <circle cx="138" cy="24" r="3" />
          <circle cx="172" cy="34" r="3" />
          <text x="24" y="90">X1</text>
          <text x="86" y="90">X2</text>
          <text x="149" y="90">X3</text>
        </svg>
        <div class="widget-axis-label widget-axis-x">X</div>
      </div>
    `;
  }
}

class PieChartWidget extends DashboardWidget {
  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-pie");
    if (expanded) container.classList.add("is-expanded");
    container.innerHTML = `
      <div class="widget-pie-shape" aria-label="圓餅圖空白範本"></div>
      <div class="widget-legend-list">
        <span><i class="legend-a"></i>A</span>
        <span><i class="legend-b"></i>B</span>
        <span><i class="legend-c"></i>C</span>
      </div>
    `;
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
  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-map-jump");
    if (expanded) container.classList.add("is-expanded");
    container.innerHTML = `
      <div class="widget-map-mini" aria-label="地圖跳轉空白範本">
        <span class="widget-map-route"></span>
        <span class="widget-map-pin"></span>
      </div>
      <div class="widget-map-jump-list">
        <span>視角 A</span>
        <span>視角 B</span>
      </div>
    `;
  }
}

class MetricsWidget extends DashboardWidget {
  renderTemplate(container, { expanded = false } = {}) {
    container.classList.add("widget-template", "widget-template-metrics");
    if (expanded) container.classList.add("is-expanded");
    container.innerHTML = `
      <div class="widget-metric-bars" aria-label="測速空白範本">
        <span style="--bar-level: 72%"></span>
        <span style="--bar-level: 48%"></span>
        <span style="--bar-level: 86%"></span>
      </div>
      <div class="widget-metric-caption">
        <strong>-- ms</strong>
        <span>資料到畫面</span>
      </div>
    `;
  }
}

class BlankWidget extends DashboardWidget {}

function createWidgetCatalog() {
  return [
    new WidgetCatalogItem({ id: "line-chart", title: "折線圖工具", size: "2x2", description: "時間序列指標。", group: "new" }),
    new WidgetCatalogItem({ id: "pie-chart", title: "圓餅圖工具", size: "1x1", description: "分類比例摘要。", group: "new" }),
    new WidgetCatalogItem({ id: "table", title: "表格工具", size: "2x2", description: "資料列與欄位檢視。", group: "new" }),
    new WidgetCatalogItem({ id: "map-jump", title: "地圖窗格快速跳轉工具", size: "1x2", description: "常用視角與區域入口。", group: "new" }),
    new WidgetCatalogItem({ id: "metrics", title: "測速", size: "1x2", description: "已註冊的效能觀測圖表。", group: "registered", deletable: false }),
  ];
}

function createWidgetFromCatalogItem(catalogItem, { id, slotIndex = null }) {
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
    this.layer.addEventListener("click", (event) => {
      if (event.target === this.layer) {
        this.close();
      }
    });
    document.body.append(this.layer);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    });
  }

  openExpanded(widget, { onSettings } = {}) {
    this.layer.classList.remove("is-marketplace-layer");
    const pane = widget.renderExpanded();
    pane.dataset.widgetView = "detail";
    this.layer.replaceChildren(pane);
    this.layer.hidden = false;
    bindWidgetPointerBehavior(pane, {
      onPrimary: () => this.expandToCinema(widget, pane),
      onSettings: () => onSettings?.(widget) || this.openSettings(widget),
    });
  }

  expandToCinema(widget, pane) {
    if (!pane || pane.dataset.widgetView === "cinema") return;
    pane.dataset.widgetView = "cinema";
    pane.classList.add("is-cinema");
    const body = pane.querySelector(".widget-popover-body");
    if (body) {
      body.replaceChildren();
      widget.renderTemplate(body, { expanded: true, cinema: true });
    }
  }

  openSettings(widget, { onDelete } = {}) {
    this.layer.classList.remove("is-marketplace-layer");
    this.layer.replaceChildren(widget.renderSettings({ onDelete }));
    this.layer.hidden = false;
  }

  openPanelSettings(panel) {
    this.layer.classList.add("is-marketplace-layer");
    this.layer.replaceChildren(panel.renderSettings());
    this.layer.hidden = false;
    const closeButton = this.layer.querySelector("[data-widgets-marketplace-close]");
    closeButton?.addEventListener("click", () => this.close());
    if (typeof ControlButtons !== "undefined") {
      ControlButtons.renderIcons?.();
    }
  }

  close() {
    this.layer.hidden = true;
    this.layer.classList.remove("is-marketplace-layer");
    this.layer.replaceChildren();
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
      this.configButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openPanelSettings();
      });
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
    if (!this.socketGrid) return null;
    const rect = this.socketGrid.getBoundingClientRect();
    const style = window.getComputedStyle(this.board);
    const slotSize = Number.parseFloat(style.getPropertyValue("--widget-slot-size"));
    const gap = Number.parseFloat(style.getPropertyValue("--widget-slot-gap"));
    if (!Number.isFinite(slotSize) || !Number.isFinite(gap) || slotSize <= 0) return null;

    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0) return null;

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
      return null;
    }
    return row * this.columns() + column;
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
    this.root.dataset.widgetsDropSlot = slotIndex === null ? "" : String(slotIndex);
    const canPlace = slotIndex !== null && this.canPlaceWidgetAt(catalogItem, slotIndex);
    this.root.dataset.widgetsDropState = canPlace ? "valid" : "invalid";
    this.updateDropPreview(catalogItem, slotIndex, canPlace);
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
    if (slotIndex === null || !this.canPlaceWidgetAt(catalogItem, slotIndex)) {
      this.clearDropState();
      return;
    }
    this.addWidgetFromCatalog(catalogItem, slotIndex);
    this.clearDropState();
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
    });
  }

  removeWidget(widget) {
    const index = this.widgets.findIndex((item) => item.id === widget.id);
    if (index < 0) return false;
    if (this.widgets[index].deletable === false) return false;
    this.widgets.splice(index, 1);
    this.clearDropState();
    this.renderWidgets();
    this.popover.close();
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
    closeButton.innerHTML = '<span class="control-icon-fallback" aria-hidden="true">×</span><i class="control-icon" data-lucide="x" aria-hidden="true"></i>';

    header.append(titleGroup, closeButton);

    const catalog = createWidgetCatalog();
    const drawers = document.createElement("div");
    drawers.className = "widgets-marketplace-drawers";
    drawers.append(
      new WidgetMarketplaceDrawer({
        id: "registered",
        title: "已註冊",
        items: catalog.filter((item) => item.group === "registered"),
        expanded: true,
      }).render(this),
      new WidgetMarketplaceDrawer({
        id: "new",
        title: "新增",
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

function createDashboardWidgets(scope = "widgets") {
  return [
    new BlankWidget({ id: `${scope}-blank-1x1`, title: "空白版型", size: "1x1", status: "", slotIndex: 0 }),
    new BlankWidget({ id: `${scope}-blank-1x2`, title: "空白版型", size: "1x2", status: "", slotIndex: 1 }),
    new BlankWidget({ id: `${scope}-blank-1x3`, title: "空白版型", size: "1x3", status: "", slotIndex: 3 }),
    new BlankWidget({ id: `${scope}-blank-2x2`, title: "空白版型", size: "2x2", status: "", slotIndex: 6 }),
    new BlankWidget({ id: `${scope}-blank-2x3`, title: "空白版型", size: "2x3", status: "", slotIndex: 8 }),
  ];
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

window.WidgetSizePresets = WidgetSizePresets;
window.WidgetSocketLayout = WidgetSocketLayout;
window.bindWidgetPointerBehavior = bindWidgetPointerBehavior;
window.bindWidgetDragBehavior = bindWidgetDragBehavior;
window.DashboardWidget = DashboardWidget;
window.LineChartWidget = LineChartWidget;
window.PieChartWidget = PieChartWidget;
window.TableWidget = TableWidget;
window.MapJumpWidget = MapJumpWidget;
window.MetricsWidget = MetricsWidget;
window.BlankWidget = BlankWidget;
window.WidgetPopoverController = WidgetPopoverController;
window.WidgetsPanel = WidgetsPanel;

initWidgetsPanels();
