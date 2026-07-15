# Widget Capabilities

此資料夾中的每個檔案代表一種可註冊能力。能力只負責 View、ViewModel 轉換與 Widget class，不負責資料查詢、預設排版、建立面板或監聽整頁生命週期。

能力只能依賴 `WidgetCore`、`WidgetCapabilityShared` 與建構時注入的 `services`。禁止直接讀取 `DataFrameStore`、`FrameDemandService`、`LayerQueryCoordinator` 或任何 `.shared()` singleton。新增能力時先在 Application 層建立必要的資料服務，再在此建立 Widget class，最後由 `registry/widget-registry.js` 宣告 metadata 與可用尺寸。
