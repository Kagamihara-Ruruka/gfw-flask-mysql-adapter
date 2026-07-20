(() => {
const {
  WidgetSizePresets,
  WidgetSizeAbleDict,
  bindWidgetPointerBehavior,
  bindWidgetDragBehavior,
  WidgetSocketLayout,
  WidgetCatalogItem,
  DashboardWidget,
  ChartWidget,
  WidgetPlotlyLifecycle,
} = window.WidgetCore;
const {
  WidgetTableView,
  LineChartWidget,
  PieChartWidget,
  HorizontalBarChartWidget,
  EezAttributionWidget,
  TableWidget,
  MapJumpWidget,
  MetricsWidget,
} = window.WidgetCapabilities;
const {
  BlankWidget,
  WidgetAbilityRegistry,
  createWidgetCatalog,
  createRegisteredWidgetCatalog,
  createWidgetInstance,
  createWidgetFromCatalogItem,
  createWidgetFromRegisteredItem,
  createBlankWidgetFromWidget,
} = window.WidgetRegistry;
class WidgetPopoverController {
  constructor() {
    this.layer = document.createElement("div");
    this.layer.className = "widget-popover-layer";
    this.layer.hidden = true;
    this.layer.style.display = "none";
    this.layer.style.pointerEvents = "none";
    this.boundLayerClick = (event) => {
      if (event.target === this.layer) {
        this.close();
      }
    };
    this.layer.addEventListener("click", this.boundLayerClick);
    document.body.append(this.layer);
    this.openWidget = null;
    this.boundKeydown = (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    };
    document.addEventListener("keydown", this.boundKeydown);
    this.activeView = null;
    this.retainedViews = new Map();
  }

  openExpanded(widget, { onSettings } = {}) {
    this.deactivateActiveView();
    const retentionKey = String(widget?.popoverRetentionKey?.() || "").trim();
    let view = retentionKey ? this.retainedViews.get(retentionKey) : null;
    if (!view) {
      const pane = widget.renderExpanded();
      pane.dataset.widgetView = "detail";
      view = { widget, pane, retentionKey };
      if (retentionKey) this.retainedViews.set(retentionKey, view);
      bindWidgetPointerBehavior(pane, {
        onPrimary: () => this.expandToCinema(view.widget, pane),
        onSettings: () => {
          if (typeof onSettings === "function") {
            onSettings(view.widget);
            return;
          }
          this.openSettings(view.widget);
        },
      });
    }
    this.activeView = view;
    this.openWidget = view.widget;
    this.layer.style.display = "";
    this.layer.style.pointerEvents = "";
    if (view.pane.parentElement !== this.layer) this.layer.append(view.pane);
    view.pane.hidden = false;
    this.layer.hidden = false;
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
      widget.renderCinema(body);
    }
  }

  openSettings(widget, { onDelete, onConfigure, catalogItems = [] } = {}) {
    this.deactivateActiveView();
    this.openWidget = null;
    this.layer.style.display = "";
    this.layer.style.pointerEvents = "";
    const pane = widget.renderSettings({ onDelete, onConfigure, catalogItems });
    this.activeView = { widget: null, pane, retentionKey: "" };
    this.layer.append(pane);
    this.layer.hidden = false;
  }

  deactivateActiveView() {
    const view = this.activeView;
    for (const retainedView of this.retainedViews.values()) {
      retainedView.pane.hidden = true;
    }
    if (!view) {
      this.openWidget = null;
      return;
    }
    view.pane.hidden = true;
    if (!view.retentionKey) {
      view.widget?.disposeRenderedView?.(view.pane);
      view.pane.remove();
    }
    this.activeView = null;
    this.openWidget = null;
  }

  close() {
    this.deactivateActiveView();
    this.layer.hidden = true;
    this.layer.style.display = "none";
    this.layer.style.pointerEvents = "none";
  }

  refreshOpenWidgetType(widgetType) {
    if (this.layer.hidden || this.openWidget?.widgetType !== widgetType) return;
    const pane = this.layer.querySelector(".widget-popover");
    const body = pane?.querySelector(".widget-popover-body");
    if (!pane || !body) return;
    this.openWidget.replaceRenderedTemplate(body, {
      expanded: true,
      cinema: pane.dataset.widgetView === "cinema",
    });
  }

  dispose() {
    this.close();
    document.removeEventListener("keydown", this.boundKeydown);
    this.layer.removeEventListener("click", this.boundLayerClick);
    for (const view of this.retainedViews.values()) {
      view.widget?.disposeRenderedView?.(view.pane);
      view.pane.remove();
      view.widget?.dispose?.();
    }
    this.retainedViews.clear();
    this.layer.remove();
    this.openWidget = null;
  }
}

let widgetRuntimeOwner = null;

class WidgetsPanel {
  constructor({ root, board, socketGrid, grid, widgets = [], popover, applicationRuntime }) {
    if (!popover) throw new TypeError("WidgetsPanel requires a popover controller");
    if (!applicationRuntime) throw new TypeError("WidgetsPanel requires WidgetApplicationRuntime");
    this.root = root;
    this.board = board;
    this.socketGrid = socketGrid;
    this.grid = grid;
    this.widgets = widgets;
    this.popover = popover;
    this.applicationRuntime = applicationRuntime;
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

  servicesFor(widgetType) {
    return this.applicationRuntime.servicesFor(widgetType);
  }

  mount() {
    if (!this.grid) return;
    this.socketLayout.sync();
    this.ensureDropPreview();
    this.normalizeWidgetPlacements();
    this.renderWidgets();
    this.bindDropzone();
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

  dispose() {
    this.resizeObserver?.disconnect?.();
    this.popover?.close?.();
    for (const widget of this.widgets) widget.dispose?.();
    this.clearDropState();
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
    WidgetPlotlyLifecycle.purge(this.grid);
    this.grid?.replaceChildren(...this.widgets.map((widget) => widget.render(this)));
  }

  refreshWidgetsByType(widgetType) {
    for (const widget of this.widgets) {
      if (widget.widgetType !== widgetType) continue;
      const node = this.grid?.querySelector(`[data-widget-id="${widget.id}"]`);
      const body = node?.querySelector(".dashboard-widget-body");
      if (!body) continue;
      widget.replaceRenderedTemplate(body, { expanded: false });
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
    const nextWidget = createWidgetFromRegisteredItem(
      catalogItem,
      targetWidget,
      this.servicesFor(catalogItem.id),
    );
    if (!nextWidget) return false;
    targetWidget.dispose?.();
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
    }, this.servicesFor(catalogItem.kind === "size" ? "blank" : catalogItem.id));
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

  activateCatalogItem(catalogItem) {
    if (!catalogItem) return null;
    const widget = createWidgetFromCatalogItem(catalogItem, {
      id: `${this.scope()}-launchpad-${catalogItem.id}`,
    }, this.servicesFor(catalogItem.kind === "size" ? "blank" : catalogItem.id));
    widget.handlePrimaryAction(this);
    return widget;
  }

  openWidgetSettings(widget) {
    this.popover.openSettings(widget, {
      onDelete: () => this.removeWidget(widget),
      onConfigure: (_widget, widgetType) => this.configureWidgetType(_widget, widgetType),
      catalogItems: this.registeredCatalogItems(),
    });
  }

  registeredCatalogItems() {
    return createRegisteredWidgetCatalog();
  }

  configureWidgetType(widget, widgetType) {
    const index = this.widgets.findIndex((item) => item.id === widget.id);
    if (index < 0) return false;
    const currentWidget = this.widgets[index];
    let nextWidget = null;
    if (widgetType === "blank") {
      nextWidget = createBlankWidgetFromWidget(currentWidget, this.servicesFor("blank"));
    } else {
      const registeredItem = this.registeredCatalogItems().find((item) => item.id === widgetType);
      nextWidget = createWidgetFromRegisteredItem(registeredItem, currentWidget, this.servicesFor(widgetType));
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
    const [removedWidget] = this.widgets.splice(index, 1);
    removedWidget?.dispose?.();
    this.clearDropState();
    this.renderWidgets();
    this.popover.close();
    return true;
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
  Object.freeze({ type: "eez-attribution", id: "eez-attribution-1x1", title: "海域管轄判定工具", size: "1x1", status: "EEZ 管轄判定。", slotIndex: 11 }),
  Object.freeze({ type: "metrics", id: "metrics-1x2", title: "測速工具", size: "1x2", status: "", slotIndex: 12 }),
  Object.freeze({ type: "horizontal-bar-chart", id: "horizontal-bar-chart-1x3", title: "橫條圖工具", size: "1x3", status: "多標籤比較。", slotIndex: 14 }),
  Object.freeze({ type: "spotify-player", id: "spotify-player-1x1", title: "彩蛋", size: "1x1", status: "", slotIndex: 17 }),
]);

function createDashboardWidgetFromDefault(item, scope, applicationRuntime) {
  const definition = WidgetAbilityRegistry[item.type];
  const params = {
    id: `${scope}-${item.id}`,
    title: item.title,
    size: item.size,
    status: item.status,
    slotIndex: item.slotIndex,
    deletable: definition?.deletable,
    widgetType: item.type,
  };
  if (definition?.WidgetClass) {
    return createWidgetInstance(item.type, params, applicationRuntime.servicesFor(item.type));
  }
  return createWidgetInstance("blank", params, applicationRuntime.servicesFor("blank"));
}

function createDashboardWidgets(scope = "widgets", applicationRuntime) {
  if (!applicationRuntime) throw new TypeError("createDashboardWidgets requires WidgetApplicationRuntime");
  return DefaultDashboardWidgetLayout.map((item) => createDashboardWidgetFromDefault(item, scope, applicationRuntime));
}

function initWidgetsPanels(popover, applicationRuntime) {
  const panels = Array.from(document.querySelectorAll("[data-widgets-panel]")).map((root, index) => {
    const scope = root.dataset.widgetsScope || `widgets-${index + 1}`;
    const panel = new WidgetsPanel({
      root,
      board: root.querySelector("[data-widgets-board]"),
      socketGrid: root.querySelector("[data-widgets-socket-grid]"),
      grid: root.querySelector("[data-widgets-grid]"),
      widgets: createDashboardWidgets(scope, applicationRuntime),
      popover,
      applicationRuntime,
    });
    panel.mount();
    return panel;
  });
  window.WidgetsPanelInstances = panels;
  window.WidgetsPanelInstance = panels[0] || null;
  return panels;
}

function refreshLineChartWidgets({ cause = "context_changed" } = {}) {
  const source = widgetRuntimeOwner?.applicationRuntime.source("line-chart");
  if (!source) return;
  source.refresh({ cause });
  renderLineChartWidgets();
}

function renderLineChartWidgets() {
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.("line-chart");
  }
  widgetRuntimeOwner?.popover.refreshOpenWidgetType("line-chart");
}

function refreshPieChartWidgets() {
  widgetRuntimeOwner?.applicationRuntime.clear("pie-chart");
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.("pie-chart");
  }
  widgetRuntimeOwner?.popover.refreshOpenWidgetType("pie-chart");
}

function refreshHorizontalBarWidgets() {
  widgetRuntimeOwner?.applicationRuntime.clear("horizontal-bar-chart");
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.("horizontal-bar-chart");
  }
  widgetRuntimeOwner?.popover.refreshOpenWidgetType("horizontal-bar-chart");
}

function renderWidgetType(widgetType) {
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.(widgetType);
  }
  widgetRuntimeOwner?.popover.refreshOpenWidgetType(widgetType);
}

function refreshEezAttributionWidgets() {
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.("eez-attribution");
  }
  widgetRuntimeOwner?.popover.refreshOpenWidgetType("eez-attribution");
}

function refreshTableWidgets() {
  for (const panel of window.WidgetsPanelInstances || []) {
    panel.refreshWidgetsByType?.("table");
  }
  widgetRuntimeOwner?.popover.refreshOpenWidgetType("table");
}

function refreshLineChartWidgetsForTileSelection(event) {
  if (!tileSelectionChangeAffectsWidgets(event)) return;
  refreshLineChartWidgets({ cause: "tile_selection" });
}

function refreshPieChartWidgetsForTileSelection(event) {
  if (!tileSelectionChangeAffectsWidgets(event)) return;
  refreshPieChartWidgets();
}

function tileSelectionChangeAffectsWidgets(event) {
  return ["selected", "disabled", "cleared", "mode_changed", "grid_changed"].includes(event?.detail?.reason);
}

class WidgetRefreshCoordinator {
  constructor({ eventTarget, targetMap = null, applicationRuntime, elementById } = {}) {
    if (!eventTarget?.addEventListener) throw new TypeError("WidgetRefreshCoordinator requires an event target");
    if (!applicationRuntime) throw new TypeError("WidgetRefreshCoordinator requires WidgetApplicationRuntime");
    if (typeof elementById !== "function") throw new TypeError("WidgetRefreshCoordinator requires elementById");
    if (typeof applicationRuntime.schedule !== "function" || typeof applicationRuntime.cancelSchedule !== "function") {
      throw new TypeError("WidgetRefreshCoordinator requires injected scheduling");
    }
    this.eventTarget = eventTarget;
    this.targetMap = targetMap;
    this.applicationRuntime = applicationRuntime;
    this.elementById = elementById;
    this.abortController = null;
    this.mapMoveHandler = null;
    this.timers = new Set();
    this.pendingFrameStoreEvents = [];
    this.frameStoreRefreshQueued = false;
    this.bound = false;
  }

  queue(callback) {
    let timerId = null;
    timerId = this.applicationRuntime.schedule(() => {
      this.timers.delete(timerId);
      if (this.bound) callback();
    }, 0);
    this.timers.add(timerId);
  }

  queueFrameStoreRefresh(event) {
    this.pendingFrameStoreEvents.push({ detail: event?.detail || {} });
    if (this.frameStoreRefreshQueued) return;
    this.frameStoreRefreshQueued = true;
    this.queue(() => {
      this.frameStoreRefreshQueued = false;
      const events = this.pendingFrameStoreEvents.splice(0);
      const lineSource = this.applicationRuntime.source("line-chart");
      const tableSource = this.applicationRuntime.source("table");
      const barSource = this.applicationRuntime.source("horizontal-bar-chart");
      if (events.some((candidate) => lineSource?.cacheEventAffectsCurrent(candidate))) {
        renderLineChartWidgets();
      }
      if (events.some((candidate) => tableSource?.cacheEventAffectsCurrent(candidate))) {
        refreshTableWidgets();
      }
      if (events.some((candidate) => barSource?.cacheEventAffectsCurrent(candidate))) {
        refreshHorizontalBarWidgets();
      }
    });
  }

  bind() {
    if (this.bound) return this;
    this.bound = true;
    this.abortController = new AbortController();
    const listenerOptions = { signal: this.abortController.signal };
    this.eventTarget.addEventListener("rrkal:tile-selection-changed", (event) => {
    refreshLineChartWidgetsForTileSelection(event);
    refreshPieChartWidgetsForTileSelection(event);
    if (tileSelectionChangeAffectsWidgets(event)) {
      refreshHorizontalBarWidgets();
      this.applicationRuntime.source("eez-attribution")?.rememberTileSelection(event);
      refreshEezAttributionWidgets();
      refreshTableWidgets();
    }
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:schema-loaded", () => {
    if (!this.applicationRuntime.hasActiveLayer()) return;
    refreshLineChartWidgets();
    refreshPieChartWidgets();
    refreshTableWidgets();
    refreshHorizontalBarWidgets();
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:layer-activation-changed", (event) => {
    if (event?.detail?.reason === "activation_failed") return;
    refreshLineChartWidgets();
    refreshPieChartWidgets();
    refreshTableWidgets();
    refreshHorizontalBarWidgets();
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:records-updated", () => {
    refreshPieChartWidgets();
    refreshTableWidgets();
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:active-date-changed", () => {
    renderLineChartWidgets();
    refreshHorizontalBarWidgets();
    refreshTableWidgets();
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:line-chart-data-changed", () => {
    for (const panel of window.WidgetsPanelInstances || []) {
      panel.refreshWidgetsByType?.("line-chart");
    }
    widgetRuntimeOwner?.popover.refreshOpenWidgetType("line-chart");
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:pie-chart-data-changed", () => {
    renderWidgetType("pie-chart");
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:horizontal-bar-data-changed", () => {
    renderWidgetType("horizontal-bar-chart");
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:eez-attribution-data-changed", () => {
    refreshEezAttributionWidgets();
  }, listenerOptions);
    this.eventTarget.addEventListener("rrkal:data-frame-store-changed", (event) => {
    if (event?.detail?.type !== "committed") return;
    this.queueFrameStoreRefresh(event);
  }, listenerOptions);
  for (const id of ["start-date", "end-date", "dataset-select"]) {
      this.elementById(id)?.addEventListener("change", () => {
      this.queue(refreshLineChartWidgets);
    }, listenerOptions);
  }
  for (const id of ["date", "dataset-select"]) {
      this.elementById(id)?.addEventListener("change", () => {
      this.queue(refreshPieChartWidgets);
      if (id === "dataset-select") this.queue(refreshHorizontalBarWidgets);
      this.queue(refreshTableWidgets);
    }, listenerOptions);
  }
    this.mapMoveHandler = () => refreshTableWidgets();
    this.targetMap?.on?.("moveend", this.mapMoveHandler);
    return this;
  }

  dispose() {
    if (!this.bound) return;
    this.bound = false;
    this.abortController?.abort();
    this.targetMap?.off?.("moveend", this.mapMoveHandler);
    for (const timerId of this.timers) this.applicationRuntime.cancelSchedule(timerId);
    this.timers.clear();
    this.pendingFrameStoreEvents.length = 0;
    this.frameStoreRefreshQueued = false;
    this.abortController = null;
    this.mapMoveHandler = null;
  }
}


window.WidgetSizePresets = WidgetSizePresets;
window.WidgetSizeAbleDict = WidgetSizeAbleDict;
window.WidgetAbilityRegistry = WidgetAbilityRegistry;
window.WidgetCatalogItem = WidgetCatalogItem;
window.WidgetCatalog = Object.freeze({
  create: createWidgetCatalog,
  registered: createRegisteredWidgetCatalog,
});
window.WidgetSocketLayout = WidgetSocketLayout;
window.bindWidgetPointerBehavior = bindWidgetPointerBehavior;
window.bindWidgetDragBehavior = bindWidgetDragBehavior;
window.DashboardWidget = DashboardWidget;
window.ChartWidget = ChartWidget;
window.WidgetTableView = WidgetTableView;
window.LineChartWidget = LineChartWidget;
window.PieChartWidget = PieChartWidget;
window.HorizontalBarChartWidget = HorizontalBarChartWidget;
window.EezAttributionWidget = EezAttributionWidget;
window.TableWidget = TableWidget;
window.MapJumpWidget = MapJumpWidget;
window.MetricsWidget = MetricsWidget;
window.BlankWidget = BlankWidget;
window.WidgetPopoverController = WidgetPopoverController;
window.WidgetsPanel = WidgetsPanel;

class WidgetRuntimeController {
  constructor({ eventTarget, targetMap = null, applicationRuntime, refreshCoordinatorFactory } = {}) {
    if (!eventTarget?.addEventListener) throw new TypeError("WidgetRuntimeController requires an event target");
    if (!applicationRuntime) throw new TypeError("WidgetRuntimeController requires WidgetApplicationRuntime");
    if (typeof refreshCoordinatorFactory !== "function") {
      throw new TypeError("WidgetRuntimeController requires refreshCoordinatorFactory");
    }
    this.eventTarget = eventTarget;
    this.targetMap = targetMap;
    this.applicationRuntime = applicationRuntime;
    this.refreshCoordinatorFactory = refreshCoordinatorFactory;
    this.refreshCoordinator = null;
    this.panels = [];
    this.popover = null;
    this.mounted = false;
  }

  mount() {
    if (this.mounted) return this;
    this.mounted = true;
    this.popover = new WidgetPopoverController();
    this.panels = initWidgetsPanels(this.popover, this.applicationRuntime);
    widgetRuntimeOwner = this;
    this.refreshCoordinator = this.refreshCoordinatorFactory({
      eventTarget: this.eventTarget,
      targetMap: this.targetMap,
      applicationRuntime: this.applicationRuntime,
      elementById: (id) => document.getElementById(id),
    }).bind();
    return this;
  }

  dispose() {
    if (!this.mounted) return;
    this.mounted = false;
    this.refreshCoordinator?.dispose();
    this.panels.forEach((panel) => panel.dispose());
    this.popover?.dispose();
    if (window.WidgetsPanelInstances === this.panels) {
      window.WidgetsPanelInstances = [];
      window.WidgetsPanelInstance = null;
    }
    if (widgetRuntimeOwner === this) widgetRuntimeOwner = null;
    this.refreshCoordinator = null;
    this.panels = [];
    this.popover = null;
  }
}

function createWidgetRuntimeOwner({
  eventTarget = window,
  targetMap = null,
  applicationRuntime,
  refreshCoordinatorFactory,
} = {}) {
  return new WidgetRuntimeController({
    eventTarget,
    targetMap,
    applicationRuntime,
    refreshCoordinatorFactory,
  }).mount();
}

widgetRuntimeOwner = window.AppRuntime.install(
  "WidgetRuntimeOwner",
  ({ services, eventTarget }) => createWidgetRuntimeOwner({
    eventTarget,
    targetMap: typeof map === "undefined" ? null : map,
    applicationRuntime: services.WidgetApplicationRuntime,
    refreshCoordinatorFactory: (dependencies) => new WidgetRefreshCoordinator(dependencies),
  }),
  { expose: false },
);

window.WidgetRuntime = Object.freeze({
  WidgetPopoverController,
  WidgetRefreshCoordinator,
  WidgetRuntimeController,
  WidgetsPanel,
  createWidgetRuntimeOwner,
  createDashboardWidgets,
  refreshLineChartWidgets,
  refreshPieChartWidgets,
  refreshHorizontalBarWidgets,
  refreshEezAttributionWidgets,
  refreshTableWidgets,
});
window.WidgetRuntimeReady = true;
})();
