# 大可愛目前交接狀態

更新時間：2026-07-19

Git checkpoint：`85072c3 refactor: close runtime truth ownership gaps`

本文件是目前 checkpoint 的操作索引，不取代下列權威文件：

- Runtime owner 與 DI：`docs/architecture/runtime-oop.md`
- 控制面真相與收斂紀錄：`docs/architecture/control-plane-truth-audit.md`
- Runtime 健檢與 remediation closure：`docs/architecture/runtime-truth-audit-2026-07-18.md`
- 最新使用者風暴證據：`benchmarks/runtime_truth_acceptance_2026-07-19.md`

## 專案定位

本 repo 是消費端海事資料儀表板與本機資料 adapter。預設主服務 port 為 `5057`；開發者控制台使用主服務 port + 1。CLI `--port` 可以覆寫實際 port，狀態頁應顯示有效值而不是只顯示檔案值。

核心邊界：

- Config 描述外部來源與 Runtime policy。
- Probe／Scout 觀察來源實際提供的 schema、coverage 與格網。
- Mapping 將來源外語翻譯成 Canonical roles／columns。
- Registry 與能力矩陣決定合法能力與 Runtime Layer identity。
- 地圖與 Playback 提交 sampled-grid demand；Widget 優先消費 `DataFrameStore`。
- AIS collector 是獨立 upstream feeder；Dashboard 只讀 MySQL read model。

## 啟動方式

```powershell
Copy-Item config\examples\runtime\adapter.example.json config\runtime\adapter.local.json -Force
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json serve
```

Source 啟用與 Layer 導入由 `config/state/router_manifest.local.json` 保存。不要把 connections、datasets 或 Mapping 寫回 Runtime JSON。

## 目前主鏈

```text
Source Config
-> Router Manifest active_configs
-> Probe / Scout
-> Mapping Controller artifact
-> Runtime Layer Registry
-> imported_layers
-> Dashboard Layer Activation
-> FrameDemandService
-> QueryBroker
-> Canonical Frame
-> DataFrameStore
-> Renderer / Widget Application Services
```

## 目前能力

| 領域 | 目前狀態與邊界 |
|---|---|
| Sampled-grid | Mapping 驅動；目前包含 GFW MySQL read model 與五個 Pipeline Iceberg serving datasets。Renderer 優先 WebGL，必要時退回 Canvas。 |
| Playback | `PlaybackEngineCore` 擁有日期、狀態、buffer episode 與 timeout；`PlaybackRuntimeController` 擁有 timer/session；`PlaybackPreheater` 依水位獨立補貨。 |
| Query | `FrameDemandServiceCore` cache-first；Browser sampled-grid transport 只由 `QueryBroker` 發送；Flask 由 `QueryBatchExecutor` 解包並執行。 |
| Cache | `DataFrameStoreCore` 只接受 Canonical Frame，擁有 alias、pin、failure 與 LRU；插隊與 scope cancellation 不清除已完成快取。 |
| Resolution | requested、effective query 與 observed actual resolution 已分離；actual observation 不反向覆寫 query policy。 |
| Spatial demand | CC viewport 與 coverage 共同決定 query scope；內部分頁由本系統計算，不依賴來源提供 shard id。 |
| Virtual grid | 選取格網與 Renderer 共用 `RenderGridProfile`、聚合倍率與原點。Primary Layer 目前維持 XOR；multi-layer LCM 是保留的未來 composition 能力。 |
| Widgets | UI 只呼叫注入的 Application service。表格與事件檢視器嚴格唯讀；圖表依明確 policy 讀 cache 或提交有限的補貨 demand。 |
| EEZ | PostGIS／MVT overlay，生命週期與 sampled-grid 分離。 |
| AIS | 唯一路徑為 AISStream delta collector -> MySQL read model -> Dashboard；沒有 AISHub fallback。Kafka 只列為未來 upstream 方向。 |
| Developer UI | Source Config、Route Status、Schema Probe、Mapping、Layer Import 與 Runtime Registry 已形成單向註冊鏈。 |

## 狀態所有權摘要

| 狀態／資源 | 唯一 owner |
|---|---|
| Source 啟用、鎖定、註記、Layer 導入 | `RouterManifestStore` |
| Runtime dataset／layer snapshot | `RuntimeLayerRegistry` |
| Primary Layer | `LayerActivationController` |
| Playback state／date／buffer episode | `PlaybackEngineCore` |
| Playback timer／session | `PlaybackRuntimeController` |
| Replenishment lifecycle | `PlaybackPreheater` |
| Watermark decision | `AdaptiveWatermarkController` |
| Browser sampled-grid batch | `QueryBroker` |
| Canonical RAM Frame | `DataFrameStoreCore` |
| Widget data access | Widget Application Services |
| GPU／Leaflet render resources | Renderer／Layer pool owners |

## 已知邊界

- 直接 Hive／Spark SQL backend 仍是 explicit unsupported stub；HTTP serving 的 Pipeline Iceberg adapter 是另一條已實作路徑。
- 4x 冷快取若來源供給低於消耗率，仍可能進入可解釋的 buffering；不得以跳日期或錯誤節拍掩蓋。
- Arrow／Topology Split 尚未導入；目前 Runtime transport 維持既有 Canonical 合約。
- Multi-layer LCM 尚未有正式 Layer Composition owner；目前不能由 Primary Layer XOR 流程產生多 participant。
- EEZ 在新環境需要可用 PostGIS 與匯入資產；`core.py serve` 會依 Config 執行 dependency check／bootstrap。

## 最新驗收

2026-07-19 checkpoint：

- Node contracts／architecture：233 checks passed。
- Python service／route：96 passed。
- 受控 batch=2：冷快取 1.912 fps、暖快取 15.309 fps。
- Duplicate storm：12 consumers 只產生 1 次來源請求。
- Mixed storm：五資料集 15 個不同 Frame，以 2.618 fps 完成且零失敗。
- 側邊瀏覽器：五個 Pipeline Iceberg 資料集完成 2020 全年，期間執行切速、Buffering、Zoom、選格、Seek、Widget、Event Viewer 與播放中切換資料集，沒有永久 FETCHING 或瀏覽器 warning/error。

這些數字是該 checkpoint 的歷史證據，不是永久效能保證。完整條件見 `benchmarks/runtime_truth_acceptance_2026-07-19.md`。

## 重要入口

- `core.py`：CLI 與服務啟動入口。
- `common_adapter/http/interface.py`：Flask app factory 與 route assembly。
- `common_adapter/query/registry.py`：database／endpoint 共用 query-adapter registry。
- `common_adapter/layers/runtime.py`：Runtime Layer Registry。
- `common_adapter/developer/schema_inspector.py`：Schema Probe／Scout。
- `common_adapter/developer/artifacts/layer_mappings.py`：Mapping artifact owner。
- `static/js/runtime/runtime-composition-root.js`：前端 DI composition root。
- `static/js/services/frame-demand-service.js`：logical Frame demand owner。
- `static/js/services/query-broker.js`：sampled-grid Browser transport owner。
- `static/js/services/data-frame-store.js`：Canonical RAM Frame owner。
- `static/js/playback/playback-engine.js`：播放狀態 owner。
- `static/js/playback/playback-runtime-controller.js`：播放 timer/session owner。
- `static/js/playback/playback-preheater.js`：補貨生命週期 owner。
- `static/js/ui/telemetry/snapshot-performance-chart.js`：效能縮圖 UI。
