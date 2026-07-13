# Widget Capabilities

此資料夾中的每個檔案代表一種可註冊能力。能力負責自己的 DataSource、呈現與 Widget class，但不負責決定預設排版、建立面板或監聽整頁生命週期。

能力只能依賴 `WidgetCore`、`WidgetCapabilityShared` 與既有服務合約。新增能力時先在此建立 class，再由 `registry/widget-registry.js` 宣告 metadata 與可用尺寸。
