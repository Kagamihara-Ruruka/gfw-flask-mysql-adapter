# Widget Application Services

此資料夾是 Widget UI 與 Runtime 資料服務之間的 Application 邊界。

- `widget-model-functions.js`：日期、指標與色彩等 pure function。
- `widget-query-context.js`：統一解讀目前圖層、日期、Tile、BBOX、LOD 與 canonical cache request。
- `*-data-source.js`：各能力的 cache-backed Application DataSource；不建立 DOM。
- `widget-application-runtime.js`：由 DI composition root 建立 DataSource，並依能力型別提供 frozen service bundle。

Widget UI 不得直接存取 `DataFrameStore`、`FrameDemandService` 或 `LayerQueryCoordinator`。Application DataSource 一律先檢查 canonical RAM cache；播放生命週期處於 `PREPARING`、`PLAYING` 或 `BUFFERING` 時，日期刷新只讀快取，不得補查歷史區間。明確的 Tile 互動若缺少當日切片，可提交單張 `widget-interactive` demand；只有閒置或暫停中的圖表可用 `widget-auto` 補齊設定區間。表格與事件檢視器始終唯讀。

Widget 不維護第二套日期、播放或計時真相。當前日期由 `PlaybackEngine` 投影，資料到貨由 `DataFrameStore` commit 事件驅動；自動刷新不得訂閱廣域 `records-updated` 後再重送查詢。

Pure mapping 與 ViewModel 計算維持函數；有 runtime identity、依賴不變量、可變 cache 或 dispose 責任的角色才使用 class。所有 instance 只能由 `RuntimeCompositionRoot` 組裝。
