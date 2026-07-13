# Widgets Runtime

此資料夾負責把 Core、Capabilities 與 Registry 接到頁面生命週期。`WidgetsPanel` 管理槽位與拖曳，`WidgetPopoverController` 管理展開與設定，bootstrap 負責預設排版及跨能力事件刷新。

Runtime 可以調用公開能力介面，但不得直接修改能力的私有 cache 或 DOM 結構；刷新必須走能力 DataSource 與 Widget class 暴露的方法。
