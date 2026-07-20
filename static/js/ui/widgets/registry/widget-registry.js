(() => {
const { DashboardWidget, WidgetCatalogItem, WidgetSizeAbleDict } = window.WidgetCore;
const {
  LineChartWidget,
  PieChartWidget,
  HorizontalBarChartWidget,
  EezAttributionWidget,
  TableWidget,
  MapJumpWidget,
  MetricsWidget,
  LifecycleEventViewerWidget,
  UsageGuideWidget,
  SpotifyPlayerWidget,
} = window.WidgetCapabilities;
class BlankWidget extends DashboardWidget {}

const WidgetAbilityRegistry = Object.freeze({
  "line-chart": Object.freeze({
    WidgetClass: LineChartWidget,
    title: "折線圖工具",
    size: "2x2",
    description: "時間序列指標。",
    icon: "chart-line",
    tone: "cyan",
  }),
  "pie-chart": Object.freeze({
    WidgetClass: PieChartWidget,
    title: "圓餅圖工具",
    size: "1x1",
    description: "圖層 Y 值比例。",
    icon: "chart-pie",
    tone: "violet",
  }),
  "horizontal-bar-chart": Object.freeze({
    WidgetClass: HorizontalBarChartWidget,
    title: "橫條圖工具",
    size: "1x3",
    description: "分類 Y 與指標 X 的比較。",
    icon: "chart-bar",
    tone: "amber",
  }),
  table: Object.freeze({
    WidgetClass: TableWidget,
    title: "表格工具",
    size: "2x2",
    description: "資料列與欄位檢視。",
    icon: "table-2",
    tone: "slate",
  }),
  "map-jump": Object.freeze({
    WidgetClass: MapJumpWidget,
    title: "窗格跳轉工具",
    size: "1x2",
    description: "常用視角與區域入口。",
    icon: "map-pin",
    tone: "green",
  }),
  metrics: Object.freeze({
    WidgetClass: MetricsWidget,
    title: "測速工具",
    size: "1x2",
    description: "已註冊的效能觀測圖表。",
    deletable: true,
    icon: "gauge",
    tone: "rose",
  }),
  "event-viewer": Object.freeze({
    WidgetClass: LifecycleEventViewerWidget,
    title: "生命週期事件檢視器",
    size: "2x2",
    description: "播放、查詢、快取與 Renderer 事件。",
    deletable: true,
    icon: "activity",
    tone: "cyan",
  }),
  "eez-attribution": Object.freeze({
    WidgetClass: EezAttributionWidget,
    title: "海域管轄判定工具",
    size: "1x1",
    description: "依選取網格判定 EEZ 交疊。",
    icon: "compass",
    tone: "blue",
  }),
  "usage-guide": Object.freeze({
    WidgetClass: UsageGuideWidget,
    title: "使用說明",
    size: "1x1",
    description: "系統操作指南。",
    icon: "book-open-text",
    tone: "slate",
  }),
  "spotify-player": Object.freeze({
    WidgetClass: SpotifyPlayerWidget,
    title: "彩蛋",
    size: "1x1",
    description: "Spotify 彩蛋播放器。",
    icon: "disc-3",
    tone: "green",
  }),
});

function widgetClassForType(widgetType) {
  return WidgetAbilityRegistry[widgetType]?.WidgetClass || DashboardWidget;
}

function createWidgetInstance(widgetType, params = {}, services = {}) {
  const normalizedType = String(widgetType || "blank");
  if (normalizedType === "blank") {
    return new BlankWidget({ ...params, widgetType: "blank", services });
  }
  const WidgetClass = widgetClassForType(normalizedType);
  return new WidgetClass({ ...params, widgetType: normalizedType, services });
}

function createWidgetCatalog() {
  const blankItems = [
    new WidgetCatalogItem({ id: "blank-1x1", title: "空白 Widgets", size: "1x1", description: "1x1 空白版型。", group: "new", kind: "size", icon: "square-dashed", tone: "neutral" }),
    new WidgetCatalogItem({ id: "blank-1x2", title: "空白 Widgets", size: "1x2", description: "1x2 空白版型。", group: "new", kind: "size", icon: "square-dashed", tone: "neutral" }),
    new WidgetCatalogItem({ id: "blank-1x3", title: "空白 Widgets", size: "1x3", description: "1x3 空白版型。", group: "new", kind: "size", icon: "square-dashed", tone: "neutral" }),
    new WidgetCatalogItem({ id: "blank-2x2", title: "空白 Widgets", size: "2x2", description: "2x2 空白版型。", group: "new", kind: "size", icon: "square-dashed", tone: "neutral" }),
    new WidgetCatalogItem({ id: "blank-2x3", title: "空白 Widgets", size: "2x3", description: "2x3 空白版型。", group: "new", kind: "size", icon: "square-dashed", tone: "neutral" }),
  ];
  const abilityItems = Object.entries(WidgetAbilityRegistry).map(([id, definition]) => (
    new WidgetCatalogItem({
      id,
      title: definition.title,
      size: definition.size,
      supportedSizes: WidgetSizeAbleDict[id],
      description: definition.description,
      group: "registered",
      deletable: definition.deletable,
      icon: definition.icon,
      tone: definition.tone,
    })
  ));
  return [...abilityItems, ...blankItems];
}

function createRegisteredWidgetCatalog() {
  return createWidgetCatalog().filter((item) => item.group === "registered");
}

function createWidgetFromCatalogItem(catalogItem, { id, slotIndex = null }, services = {}) {
  if (catalogItem.kind === "size") {
    return createWidgetInstance("blank", {
      id,
      size: catalogItem.size,
      title: "空白版型",
      status: "",
      slotIndex,
      deletable: true,
    }, services);
  }
  return createWidgetInstance(catalogItem.id, {
    id,
    title: catalogItem.title,
    size: catalogItem.size,
    status: catalogItem.description,
    slotIndex,
    deletable: catalogItem.deletable,
  }, services);
}

function createWidgetFromRegisteredItem(registeredItem, sourceWidget, services = {}) {
  if (!registeredItem || !registeredItem.supportsSize(sourceWidget.size)) return null;
  return createWidgetInstance(registeredItem.id, {
    id: sourceWidget.id,
    title: registeredItem.title,
    size: sourceWidget.size,
    status: registeredItem.description,
    slotIndex: sourceWidget.slotIndex,
    deletable: registeredItem.deletable,
  }, services);
}

function createBlankWidgetFromWidget(sourceWidget, services = {}) {
  return createWidgetInstance("blank", {
    id: sourceWidget.id,
    title: "空白版型",
    size: sourceWidget.size,
    status: "",
    slotIndex: sourceWidget.slotIndex,
    deletable: true,
  }, services);
}


window.WidgetCapabilities = Object.freeze({ ...window.WidgetCapabilities });
window.WidgetRegistry = Object.freeze({
  BlankWidget,
  WidgetAbilityRegistry,
  widgetClassForType,
  createWidgetInstance,
  createWidgetCatalog,
  createRegisteredWidgetCatalog,
  createWidgetFromCatalogItem,
  createWidgetFromRegisteredItem,
  createBlankWidgetFromWidget,
});
})();
