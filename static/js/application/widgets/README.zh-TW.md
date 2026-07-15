# Widget Application Services

此資料夾是 Widget UI 與 Runtime 資料服務之間的 Application 邊界。

- `widget-model-functions.js`：日期、指標與色彩等 pure function。
- `widget-query-context.js`：統一解讀目前圖層、日期、Tile、BBOX、LOD 與 canonical cache request。
- `*-data-source.js`：各能力的 cache-backed Application DataSource；不建立 DOM。
- `widget-application-runtime.js`：由 DI composition root 建立 DataSource，並依能力型別提供 frozen service bundle。

Widget UI 不得直接存取 `DataFrameStore`、`FrameDemandService` 或 `LayerQueryCoordinator`。Application DataSource 預設先檢查 canonical RAM cache；只有明確允許補資料的圖表可以提交 `widget` lane demand。表格與事件檢視器必須保持唯讀。

Pure mapping 與 ViewModel 計算維持函數；有 runtime identity、依賴不變量、可變 cache 或 dispose 責任的角色才使用 class。所有 instance 只能由 `RuntimeCompositionRoot` 組裝。
