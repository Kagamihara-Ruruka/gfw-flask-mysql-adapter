# P0 架構整理計畫（歷史）

狀態：已由 2026-07-19 Runtime／控制面收斂取代，不得再當成目前待辦或實作指引。

目前真相請看 `docs/architecture/runtime-oop.md`、`docs/architecture/control-plane-truth-audit.md` 與 `handoff/CURRENT_STATE.zh-TW.md`。

以下保留當時的規劃與決策背景，用於追溯；其中的「future」「剩餘批次」與 compatibility wrapper 提案不代表目前仍應執行。

這份文件只記錄 P0 的整理方向、已完成拆分、剩餘切點與驗證要求。它不是產品完成宣告，也不代表後續最佳化或 BI/Probe 設計已定案。

## P0 原則

- 先理順責任邊界，再談效能最佳化。
- 每次搬移都要保留現有 URL、request、response shape，除非另有明確 migration。
- 每一批拆分至少通過 `py_compile` 與 endpoint smoke test。
- `common_adapter` 是通用 adapter 身分；`gfw`、`eez`、`ais` 都只能是 dataset/source/layer 名稱。
- 渲染路徑與 Probe/BI 查詢路徑要分開設計，避免為了地圖播放速度犧牲探針語意。

## 目標後端結構

```text
common_adapter/
  http/
    interface.py              # Flask app factory / HTTP assembly only
    server.py                 # port, PID, run_server helpers
    routes/
      system.py               # root, health, render capability
      datasets.py             # dataset metadata / records API
      overlays.py             # EEZ and future spatial overlay API
      live.py                 # AIS/live source HTTP + websocket API
      developer.py            # developer workspace API
  db/
    connect.py                # connection + backend dispatch, waiting for split
    backends/
      mysql.py                # MySQL read model implementation
      hive.py                 # future Hive/Trino contract
      spark.py                # future Spark/Iceberg contract
  layers/
    contracts.py              # normalized layer contract
    runtime.py                # imported/enabled layer runtime state
  playback/
    service.py                # future playback query/buffer orchestration
  probe/
    context.py                # future ProbeContext model
    service.py                # future Probe API orchestration
  spatial/
    eez_bootstrap.py          # EEZ source/bootstrap/import automation
    lod.py                    # EEZ MVT/PostGIS read model serving
```

## 目標前端結構

```text
static/js/
  core/                       # map/state/render-state/shared runtime
  layers/                     # map layer controllers
  services/                   # API/cache/render intent services
  playback/                   # playback state machine/controllers
  probe/                      # developer probe context + API client
  widgets/                    # registered dashboard Widget capabilities
  ui/                         # page panels and controls
```

播放控制、獨立 `PlaybackPreheater` 與 snapshot splitter 位於 `static/js/playback/`。所有 sampled-grid 查詢統一經過 `FrameDemandService` 與 `QueryBroker`，完成的 canonical frame 只存入 `DataFrameStore`；`QueryScheduler` 只服務其他 query family，不存在第二套圖層專用快取。

## 已完成拆分

- `common_adapter/http/routes/developer.py`：承接 developer workspace routes 與 route helper。
- `common_adapter/http/routes/system.py`：承接 root page、favicon、health、render capability。
- `common_adapter/http/routes/datasets.py`：承接 `/api/datasets`、schema、records、records/range。
- `common_adapter/http/routes/overlays.py`：承接 EEZ GeoJSON fallback 與 fill/boundary MVT tiles。
- `common_adapter/http/routes/live.py`：承接 AISStream settings、diagnostics、ingest status，以及 MySQL read-model 的 live REST 與 websocket。
- `common_adapter/http/server.py`：承接 port cleanup、PID file、public URL、`run_server`、`run_server_pair`。
- `common_adapter/http/interface.py`：已縮回 Flask app factory 與 route assembly。
- `core.py`：已改由 `common_adapter.http.server` 匯入 server lifecycle。
- 舊 Root `Interface.py` 相容 wrapper 已刪除；Runtime 直接匯入 canonical `common_adapter` 模組。

## 已驗證

- `python -m py_compile` 已覆蓋 `core.py`、root wrapper、HTTP app factory、server helper 與所有 route modules。
- Flask test-client smoke 已覆蓋主服務與 developer 服務：
  - `/`
  - `/api/health`
  - `/api/render/capability`
  - `/api/datasets`
  - `/api/datasets/gfw_full/schema`
  - `/api/datasets/gfw_full/records`
  - `/api/overlays/eez/tiles/<z>/<x>/<y>.pbf`
  - `/api/overlays/eez/boundary/tiles/<z>/<x>/<y>.pbf`
  - `/api/live/ais/settings`
  - `/api/live/ais/ingest/status`
  - developer `/`
  - developer `/api/developer/configs`
  - developer `/api/developer/layer-imports`
  - developer `/api/developer/layer-contracts`

AIS 外部診斷暫不列為 P0 驗證項，因為 GitHub clone 不包含 AIS API key。

## 歷史剩餘批次（已失效）

### Batch B：資料服務解耦

- 拆分 `common_adapter/db/connect.py` 的 config loading、connection、query builder、backend adapter。
- 當時曾提議保留 root `DatabaseConnect.py` 相容 wrapper；此提議後來被否決，wrapper 已刪除，新程式只使用 canonical `common_adapter` 入口。
- 當時 `records/range` 被視為播放瓶頸；目前 sampled-grid 播放改走 `FrameDemandService -> QueryBroker -> DataFrameStore`，`records/range` 不再是播放主鏈。

### Batch C：語意漂移修正

- `ocean_*` database 名稱出現在 example config 與 docs。這是歷史 demo 命名，不應代表 adapter domain。
- `gfw` 只能保留為 demo dataset/source/layer id，不應出現在 adapter 身分命名。
- `eez` 只能保留為 spatial overlay/source/layer id，不應變成專案主題。
- `esri_ocean_basemap` 是 Esri basemap provider id，語意上不是本專案 ocean domain；當時提議的 `esri_ocean` legacy alias 已移除，不得復活。
- Spark/Iceberg 是鄰組可能使用的查詢層；P0 只能保留 config/read-backend 邊界，不宣稱已完成 Spark/Iceberg 查詢。
- 高風險通用詞必須單層語意化：`config` 是 JSON file；`route` 是資料來源連線註冊；`runtime_json` 是服務啟動入口；`mapping` 是服務內部欄位協議；`layer contract` 是資料圖層導入產物。不得讓同一個詞同時代表 UI 分類、外部資料源、內部協議與 runtime state。
- `DATABASE`、`WEBSOCKET`、`SPATIAL` 是目前已實作的 probe adapter，不是 route group 探測能力的永久上限。未知資料源需要先能被 JSON 宣告或 probe adapter 探測，才會注入下游。

### Batch D：Probe / Widget 邊界

- 當時只建立概念邊界；目前 Widget Registry、Application Service、表格、圖表與事件檢視器均已有實作，現行規則以 Widget/Application README 為準。
- ProbeContext 至少應包含 selection、time range、viewport、active layer、metric intent。
- Probe API 應與 playback/render API 分離，避免渲染快取直接綁死 BI 查詢。

### Batch E：Developer Workspace 通用兼容性盤點

- 盤點 route group 探測、database / websocket / spatial probe、schema / mapping / layer contract 的狀態機與 config contract。
- 分清楚 runtime JSON、route JSON、mapping artifact、layer contract、runtime state。
- 標記 prototype 功能，不把實驗性 UI 說成正式 contract。

## P0.5：避免硬編碼的小型重構

P0 與 P1 中間加一個 P0.5。P0.5 的目標是把已經成形、但還散落在程式碼中的硬編碼選項，改成「能力矩陣 + 宣告式 route/feature registry」。它不等同於 P1 效能最佳化，也不應在 P0 期間大規模重寫播放管線。

### 宣告式化候選盤點

P0 不急著把所有流程改成宣告式，但要標出適合收斂的區域：

- Config fragments：DATABASE / SPATIAL / WEBSOCKET 應由 manifest 宣告啟用，不應讓 UI 或 route 手動猜目前來源。
- Layer contract：圖層 id、label、capability、time support、style controls 應由後端 contract 宣告，前端只做渲染與互動。
- Playback state machine：此收斂已完成；目前 owner 分工以 `docs/architecture/runtime-oop.md` 為準，不得依本歷史段落建立第二套流程。
- Developer wizard：資料庫種類、必要欄位、測試動作、啟用條件應由 schema/capability 宣告，不由前端硬編碼每個 backend。
- Probe/BI widgets：widget registry、ProbeContext、metric query contract 應宣告化，避免每個桌面小工具各自發明資料請求格式。

P0.5 的判斷規則：

- declared：repo/schema/UI 知道這個能力的存在。
- implemented：後端或前端已有可測試實作。
- enabled：runtime manifest 或 config 明確啟用。
- route/feature registry：用宣告表組裝 route、config page、developer status rows 與 UI controls，減少各處硬編碼同一組 backend/layer/source 名稱。

## 收尾驗證要求

P0 結束前必須完成：

- `py_compile` 全量通過。
- 主服務與 developer 服務本機 smoke 通過。
- 側邊欄瀏覽器開啟主頁與 developer 頁籤，確認功能串接沒有因搬檔案漂移。
- 中文文件通過 UTF-8 strict、U+FFFD、mojibake/PUA marker、human spot check。
- 不宣稱 repo rename、schema finalized、BI ready 或效能最佳化完成。

## P5 記錄

- 依賴下載與部署進度 UX：EEZ 下載、解壓、PostGIS import、dependency check 需要可視化進度彈窗或事件 feed。這是後期 UX 工作，不列入 P0 完成條件。
