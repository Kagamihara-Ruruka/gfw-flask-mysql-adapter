# Widgets Core

此資料夾只定義所有 Widget 共用的穩定合約：尺寸 preset、滑鼠與拖曳行為、槽位配置、`WidgetCatalogItem`、`DashboardWidget` 與 `ChartWidget`。

Core 不得引用任何具體能力、能力名稱、資料來源或 API。能力只能透過 `window.WidgetCore` 取得這些基礎物件。
