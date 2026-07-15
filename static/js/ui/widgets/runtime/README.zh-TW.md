# Widgets Runtime

此資料夾負責把 Application Runtime、Core、Capabilities 與 Registry 接到頁面生命週期。`WidgetsPanel` 管理槽位與拖曳，`WidgetPopoverController` 管理展開與設定，`WidgetRuntimeController` 負責預設排版及跨能力事件刷新。

Runtime 可以調用公開能力介面，但不得直接修改 Application DataSource 的 cache 或能力 DOM 結構。Widget instance 只能由 Registry factory 建立，並由 `WidgetApplicationRuntime.servicesFor(type)` 注入資料服務；刷新走 Widget class 的公開方法，不建立第二條 service lookup 路徑。
