# Common Adapter

這是一個本機資料探索與轉接工具，用 Flask、MySQL、PostGIS、Leaflet 與前端 WebGL/Canvas 管線，把 GFW、AIS 與 EEZ 等資料接到同一個地圖介面上。

它目前是研究與原型工具，不是正式 GIS 產品，也不是資料上游的最終治理系統。

## 目前能力

- GFW 漁業網格資料：從 MySQL read model 讀取，前端優先使用 WebGL 繪製，無 WebGL 時退回 Canvas。
- AIS 船舶位置：前端只消費 SQL 裡的最新狀態表；AISStream 由獨立 collector 長駐寫入 SQL。
- EEZ 經濟海域：使用 PostGIS MVT tiles 與本機快取向量資料。
- 地圖 UI：支援資料集選擇、圖層排序、圖層齒輪設定、暗色模式、底圖切換、經緯網格、比例尺、全螢幕、截圖、測速欄、渲染 ready 燈號、時間播放與播放快取預熱。
- 設定頁：保留資料源、圖層與播放行為的設定入口，避免把所有控制塞在儀表板同一層。

## 專案邊界

這個 repo 的主要角色是「消費端」：

- 消費 SQL/read model。
- 消費 PostGIS/MVT 或未來資料服務。
- 負責地圖視覺化、LOD、播放、快取與互動。

它不是正式的上游治理系統。但 AIS 目前缺少可直接使用的基礎資料庫，因此 repo 內保留一個例外的上游 collector：

- `core.py ingest-ais`
- `common_adapter/ais/ingest.py`
- `common_adapter/ais/stream.py`
- `config/sources/websocket/ais_collector.local.json`

這個 collector 是為了養出可被小可愛消費的 AIS SQL 資料庫。未來若上游同學用 Airflow、K8、Hive、Spark/Iceberg 或其他 sink 接手，只要維持 read model 與 config contract，小可愛就不需要直接碰 AISStream。

## Handoff 交接文件

交接上游時看 `handoff/`：

- `handoff/airflow_ais_crawler/`：給 Airflow / crawler 負責人。重點是 AISStream collector、輪詢/重連設定、SQL sink、健康檢查與啟動方式。
- `handoff/backend_config_contract/`：給後端 / 系統負責人。重點是 `adapter` JSON、連線設定、MySQL/Hive/Spark 邊界、dataset 欄位與 capability matrix。

不要把真實 API key、資料庫密碼或本機私有路徑 commit 進 repo。真實值應放在：

- `config/runtime/adapter.local.json`
- `config/sources/websocket/ais_collector.local.json`
- 環境變數
- 之後的 K8 Secret / Airflow Variable

## 架構總覽

```text
core.py
  -> common_adapter/http/interface.py       Flask app factory / route assembly
  -> common_adapter/http/server.py          server lifecycle / PID / port helpers
  -> common_adapter/http/routes/*           system / dataset / overlay / live / developer routes
  -> common_adapter/db/connect.py           dataset read dispatch
  -> common_adapter/db/backends/*           MySQL 與未來 backend adapters
  -> common_adapter/db/registry.py          @database_backend registry
  -> common_adapter/ais/live.py             AIS SQL consumer packet
  -> common_adapter/ais/ingest.py           AISStream upstream collector to SQL latest-state table
  -> common_adapter/spatial/overlay.py      EEZ fallback helpers
  -> common_adapter/spatial/lod.py          PostGIS / MVT EEZ tile helpers
  -> templates/index.html      Leaflet UI shell
  -> static/js/*               前端 state、API、layer、rendering、UI 模組
```

Root 層的 `Interface.py`、`DatabaseConnect.py` 等舊檔名目前只保留相容 wrapper；新的後端責任邊界以 `common_adapter/` package 為準。

前端拆分：

- `static/app.js`：啟動 app，綁定 UI 與事件。
- `static/js/core`：共用 state、DOM、map、geo、render-state。
- `static/js/services`：API client、GFW record cache、render intent 與共用 service helper。
- `static/js/playback`：播放控制、純時間線 scheduler、frame readiness buffer、playback renderer handoff、playback telemetry、progressive prefetch controller、播放預熱、worker policy 與 snapshot splitter。
- `static/js/layers`：GFW、AIS、EEZ、graticule 圖層行為，以及 GFW zoom blur / crossfade 視覺效果邊界。
- `static/js/rendering`：WebGL/Canvas 能力檢查、renderer registry、GFW paint 設定。
- `static/js/ui`：table、播放控制、圖層選單、地圖設定、圖層樣式設定。

## 資料流

```mermaid
flowchart TD
  UI["Browser UI / Leaflet / WebGL"]
  API["common_adapter/http/routes/* / Flask API"]
  READ["common_adapter/db/connect.py / read_backend"]
  REG["database.registry"]
  MYSQL["MySQL backend"]
  HIVE["Hive backend stub"]
  SPARK["Spark/Iceberg backend stub"]
  EEZ["EEZ overlay / MVT + cache"]
  AISREAD["AIS SQL consumer"]
  AISCOLLECT["AIS ingest collector"]
  AISUP["AISStream upstream"]
  SQLAIS["BDDE38No1 AIS tables"]
  GFW["GFW gold_grid table"]

  UI --> API
  API --> READ
  READ --> REG
  REG --> MYSQL
  REG --> HIVE
  REG --> SPARK
  MYSQL --> GFW
  API --> EEZ
  API --> AISREAD
  AISREAD --> SQLAIS
  AISUP --> AISCOLLECT
  AISCOLLECT --> SQLAIS
```

## Database backend 模式

資料庫讀取端以 config + registry 解耦：

- `@database_backend("mysql")` 註冊 backend。
- `config/state/router_manifest.local.json` 決定目前啟用哪些 route fragments；DATABASE fragment 決定 dataset 使用哪個 backend、connection、table。
- `common_adapter/http/interface.py` 只負責 Flask app 組裝；HTTP shape 由 `common_adapter/http/routes/*` 管理。兩者都不應知道 MySQL、Hive、Spark 或 Iceberg 的查詢細節。
- `common_adapter/db/connect.py` 負責 config、共用查詢 helper 與 read dispatch；backend classes 位於 `common_adapter/db/backends/`。root 層 `DatabaseConnect.py` 只是相容 wrapper。
- `database/registry.py` 負責 backend registration / instantiation。

Hive 與 Spark 目前只是明確保留的 unsupported stub。這代表架構上有位置，不代表目前已經完成 Hive、Spark 或 Iceberg 連線。

## 圖層

目前資料集選擇器支援：

- GFW 漁業網格
- AIS 船舶位置
- EEZ 經濟海域邊界

GFW 與 AIS 是互斥主圖層：可以都不開，但不能同時當主圖層。EEZ 是獨立 overlay，可以疊在 GFW 或 AIS 上。圖層可拖拉排序，齒輪可調整顏色、alpha、顯示模式等。

## 時間與播放

時間控制只有在選中的資料層具備時間能力時啟用。EEZ-only 模式會把日期與播放控制灰掉。

GFW 支援：

- 單日模式
- 跳到最後一日
- 起訖日期
- replay
- 前一日 / 後一日
- 播放 / 暫停
- 播放速度
- 播放前預熱快取

播放排程以時間線為主控：播放速度是時間軸倍率，不是舊的「上一格完成後再等待」迴圈。預設步進策略是逐張播放：每一張選取範圍內的 snapshot 都會依序消耗，`playbackRate` 只改變下一張 snapshot 的目標節拍。設定頁也提供流暢播放模式；流暢模式會把到點 tick 映射到時間軸 offset，因此允許跳到較新的 ready frame。查詢與渲染工作不會在每格後再額外疊一個完整 interval。progressive 模式不會為了完整 prebuffer 阻塞開播；逐張模式會 buffering 而不是跳過下一張，流暢模式則可維持目前畫面或顯示 target date 之前最接近且 ready 的 frame。

設定頁把播放器拆成多個責任 box，而不是把所有選項混在同一個控制面：

- 播放時間軸：`playbackRate` 與步進策略決定播放器正在追哪一張真實 snapshot。
- 資料快取 / 預熱：range 預熱、progressive 背景預載、並行數與容量上限只負責供應 records packet。
- Frame 補間：保留給未來的 `requestAnimationFrame` 視覺循環，只在兩張已 ready 的真實資料幀之間計算 alpha。
- 視覺效果：淡入淡出只修飾 layer 替換；高斯模糊只限縮放 / LOD 重算時遮罩。
- 渲染壓力與測速：renderer policy 與儀表板測速 box 只觀測或降級，不擁有播放 clock。

```mermaid
flowchart LR
  Clock["播放時間軸：倍率 + 步進策略"] --> Target["目標真實 snapshot date"]
  Cache["資料快取 / 預熱時間軸"] --> Packet["Ready records packet"]
  Target --> Packet
  Packet --> Renderer["GFW renderer：aggregate rows + WebGL/Canvas draw"]
  Interp["Frame 補間循環：未來能力，只算視覺 alpha，不查 SQL"] -.-> Renderer
  Effects["視覺效果：只修飾，不排程"] -.-> Renderer
  Renderer --> Map["可見 Leaflet 圖層"]
  Metrics["儀表板測速 box：觀測 SQL/API/client/render"] -.-> Clock
  Metrics -.-> Cache
  Metrics -.-> Renderer
```

AIS live 模式目前不走日期播放器。

## 播放快取與預熱

播放快取是 v95 之後的重要行為：

- `static/js/playback/playback-cache-service.js` 負責播放前預熱、進度統計、快取容量顯示與預熱策略。
- `static/js/playback/playback-controls.js` 保留控制器事件、按鈕狀態、播放節奏與設定視窗。
- 預熱模式可設定為關閉、播放前完整預熱、或漸進式背景預熱。
- before_play 或明確預熱時，播放按鈕會被防呆；progressive 模式則讓時間線先跑，資料由背景預熱供應。
- 快取有容量上限，預設 2 GB，可在播放設定中調整。
- 快取生命週期以瀏覽器頁面為主；關閉頁面後可視為釋放。

設計原則：使用者看圖時，程式不要只是等使用者操作，而是預先準備時間序列播放可能用到的資料。

## GFW 播放 Frame 生命週期

GFW 播放的每一個 frame 不是從「每格一個檔案」讀出來。它是一個 records packet，主要由下面這組 key 決定：

```text
datasetId + date + bbox + limit + columns
```

以本機 GFW route 來說，`datasetId = gfw_full` 會透過 config 與 layer mapping 指到 MySQL 的 `ocean_fishery.gold_grid`。mapping/config 是路由合約：它說明 backend、connection、table，以及 time/lat/lon 欄位角色；它不是 frame 資料本體。冷路徑會查 MySQL，熱路徑會先吃瀏覽器端 `GfwRecordCache` 或 Flask server-side records cache。

`columns=render` 只查渲染需要的欄位，例如 time/id/lat/lon，以及可用的 `fish_sum`、`fish_ratio`、`vessels`。它和完整表格顯示欄位是分開的。

```mermaid
sequenceDiagram
  autonumber
  actor User as 使用者
  participant UI as 儀表板 UI
  participant Playback as PlaybackControls
  participant Preload as PlaybackCacheService
  participant BrowserCache as GfwRecordCache 瀏覽器快取
  participant API as Flask Records API
  participant ServerCache as Flask Records Cache
  participant DB as MySQL ocean_fishery.gold_grid
  participant Renderer as GFW Renderer
  participant Map as Leaflet Map

  User->>UI: 按下播放
  UI->>Playback: setPlayback(true)
  Playback->>Playback: 啟動時間線(display cadence + playback rate + step mode)
  Playback->>Preload: progressive 背景預載
  Preload->>BrowserCache: prefetchRequests(date + bbox + columns=render)

  alt 只有 before_play 模式
    Preload->>API: GET /api/datasets/{datasetId}/records/range
    API->>DB: 依 start/end + bbox 做 range SELECT
    API-->>BrowserCache: 將 range packet 拆成逐日期 packet
  end

  loop 每一個播放 tick
    Playback->>Playback: dueFrame = elapsed / displayCadence
    alt 逐張播放模式
      Playback->>Playback: targetDateIndex = currentDateIndex + 1
    else 流暢播放模式
      Playback->>Playback: targetDateIndex = baseDateIndex + dueFrame * playbackRate
    end

    alt target 或前一個可用 frame 已 ready
      Playback->>UI: date = selected frame date
      Playback->>BrowserCache: fetchPacket(datasetId + date + bbox + columns)

      alt 瀏覽器快取命中
        BrowserCache-->>Playback: packet(rows)
      else 瀏覽器快取未命中
        BrowserCache->>API: GET /api/datasets/{datasetId}/records
        API->>ServerCache: 查 server-side records cache
        alt Server cache 命中
          ServerCache-->>API: cached packet
        else Server cache 未命中
          API->>DB: SELECT render columns WHERE obs_date + bbox
          DB-->>API: rows
          API->>ServerCache: remember packet
        end
        API-->>BrowserCache: packet(rows + timing)
        BrowserCache-->>Playback: packet(rows)
      end

      Playback->>Renderer: renderGfwMap(rows)
      Renderer->>Renderer: aggregateGfwRowsForRender()
      Renderer->>Renderer: 依 fish_sum 計算 cell 顏色
      Renderer->>Map: WebGL 或 Canvas 畫到地圖
    else 逐張模式 target frame 尚未 ready
      Playback->>Preload: 以 target date 為 anchor 預熱窗口
      Playback->>UI: buffering，保留下一張 snapshot
    else 流暢模式 target frame 尚未 ready
      Playback->>Preload: 以 target date 為 anchor 預熱窗口
      Playback->>UI: 維持目前顯示 frame
    end
  end
```

Frame 來源判斷：

```mermaid
flowchart TD
  A["Frame request: datasetId + date + bbox + columns"] --> B{"瀏覽器快取有嗎？"}
  B -->|有| C["直接回 packet(rows)"]
  B -->|沒有| D["呼叫 Flask /records API"]

  D --> E{"Flask records cache 有嗎？"}
  E -->|有| F["回 cached packet"]
  E -->|沒有| G["查 MySQL ocean_fishery.gold_grid"]

  G --> H["WHERE obs_date = date AND lon/lat inside bbox"]
  H --> I["回 rows"]
  I --> J["存入 server cache"]
  J --> K["回 packet 給瀏覽器"]

  F --> L["存入或沿用瀏覽器 packet"]
  K --> L
  C --> M["renderGfwMap(rows)"]
  L --> M

  M --> N["aggregate rows into render cells"]
  N --> O{"WebGL 可用且允許嗎？"}
  O -->|可用| P["WebGL canvas draw"]
  O -->|不可用| Q["2D Canvas draw"]
  P --> R["顯示在 Leaflet 圖層"]
  Q --> R
```

Config 與 layer mapping 的角色：

```mermaid
flowchart LR
  A["config / layer mapping"] --> B["datasetId = gfw_full"]
  B --> C["backend = mysql"]
  C --> D["connection = local_mysql"]
  D --> E["database = ocean_fishery"]
  E --> F["table = gold_grid"]
  F --> G["time=obs_date, lat=lat, lon=lon"]
  G --> H["每個 frame 用這份合約組 SQL 查詢"]
```

## 渲染與 LOD

GFW 渲染優先走 WebGL，無法使用時回退 Canvas。GFW record cache 會依 viewport、zoom、date、dataset 與粒度建立快取。

目前行為：

- 同 zoom 平移時盡量沿用既有 LOD packet。
- zoom 改變時會標記 GFW loading、套用可選的縮放模糊遮罩、清除舊 LOD key，並重新抓取 LOD packet。
- 日期播放換幀不再套用高斯模糊；它依賴快取 readiness、renderer 工作與 layer crossfade。
- 成功渲染後會在背景預熱其他設定過的 zoom / LOD packet。
- GFW 支援漸層色票、alpha、最大強度與粒度控制。

EEZ 被視為接近底圖的 overlay，應盡量重用向量 tile / local vector cache，而不是每次平移都重新載入。

## AIS collector

AIS 拆成兩個進程：

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json serve
```

負責地圖與 API。

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json ingest-ais --collector-config config\sources\websocket\ais_collector.local.json
```

負責長駐 AISStream collector，寫入 SQL。

AIS latest-state table 採用 `mmsi` upsert：一艘船保留最新狀態，不無限制成長。若未來要歷史軌跡，應建立獨立 history/events table，並設定 retention policy。

目前內部 key check 不是正式 auth，只是原型邊界標記：前端設定 AIS key 後，consumer 端只保存 fingerprint；raw key 交給 collector handoff。小可愛讀 SQL 前會確認 SQL metadata 中的 collector key fingerprint 是否匹配。

## GFW upstream collector

GFW ingestion 被視為 upstream collector job，不是前端功能：

- `collectors/gfw_collector.py`：將 GFW DuckDB source 匯入 SQL read model。

地圖 UI 不應知道原始 source path 或暫存 manifest。這些屬於 collector 設定；小可愛只消費 SQL/read model 或之後約定好的資料服務。

## 快速啟動

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config\examples\runtime\adapter.example.json config\runtime\adapter.local.json -Force
```

接著編輯：

```text
config\runtime\adapter.local.json
```

啟動服務：

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json serve
```

開啟：

```text
http://127.0.0.1:5057
```

服務是 single-instance：啟動時會讀 `flask_pid.txt`，若舊 Flask 進程還在，會強制退出舊進程並清理 port，避免重複查詢 AIS 或資料庫。

## EEZ 的 PostGIS 依賴

當 `overlays.eez.provider` 設為 `postgis` 時，PostGIS 是 EEZ 的正式執行期依賴。地圖正常渲染 EEZ 時走 PostGIS MVT table，不是在前端或 Flask 直接讀 `.gpkg`。

Marine Regions 的預設下載 URL 會先回傳互動表單，再提供 zip 檔。下載器現在會用 `source.form` 自動填寫表單、保留第一次請求的 cookie、送出 disclaimer agreement，並在寫入前確認最後回應是真正的 zip。若專案要回報其他 contact metadata，可以在 local config 覆寫 `source.form`。

先啟動 PostGIS：

```powershell
docker compose up -d postgis
```


把 EEZ 匯入 PostGIS：

```powershell
.\.venv\Scripts\python.exe scripts\import_eez_to_postgis.py --config config\runtime\adapter.local.json --replace
```

啟動前可先做依賴健檢：

```powershell
.\.venv\Scripts\python.exe core.py --config config\runtime\adapter.local.json check-dependencies
```

`core.py serve` 會先確認 EEZ runtime assets，再執行依賴檢查。若本地 `data/eez/eez_v12.gpkg` 不存在且 `auto_download` 為 true，啟動會先自動下載並解壓 GPKG。若 `eez_v12`、`eez_v12_tile` 或 `eez_v12_boundary` 缺表或空表且 `auto_import` 為 true，啟動會在開服務前從 GPKG 匯入 PostGIS。

## 常用 API

```text
GET /api/health
GET /api/datasets
GET /api/datasets/<dataset_id>/schema
GET /api/datasets/<dataset_id>/records?date=YYYY-MM-DD&bbox=west,south,east,north&limit=max
GET /api/datasets/<dataset_id>/records/range?start=YYYY-MM-DD&end=YYYY-MM-DD&bbox=west,south,east,north&limit=max
GET /api/overlays/eez
GET /api/overlays/eez/tiles/<z>/<x>/<y>.pbf
GET /api/overlays/eez/boundary/tiles/<z>/<x>/<y>.pbf
GET /api/live/ais?bbox=west,south,east,north
GET /api/live/ais/ingest/status
GET /api/live/ais/settings
GET /api/live/ais/diagnostics
POST /api/live/ais/settings
DELETE /api/live/ais/settings
GET /api/render/capability
```

## 驗證

Demo-critical smoke：

```powershell
python scripts\demo_smoke.py --base-url http://127.0.0.1:5081
```

JavaScript syntax check：

```powershell
Get-ChildItem static\js -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
node --check static\app.js
```

Python syntax check：

```powershell
.\.venv\Scripts\python.exe -m py_compile core.py common_adapter\http\interface.py common_adapter\db\connect.py common_adapter\spatial\dependency.py common_adapter\spatial\lod.py
```

Git whitespace check：

```powershell
git diff --check -- static templates scripts *.py config requirements.txt docker-compose.yml README.md README.zh-TW.md
```

## 文件漂移檢查結果

本次檢查時：

- `README.md` 已涵蓋大多數 v94 架構，包括中文 UI、GFW/EEZ/AIS、SQL/Hive/Spark 邊界、upstream handoff 與資料不入 repo 的策略。
- `README.md` 缺少 v95 新增的 `playback-cache-service.js` 模組說明，因此已補上。
- `handoff/*.zh-TW.md` 與 `benchmarks/*.md` 可以用 UTF-8 嚴格解碼，沒有 U+FFFD 或 PUA；PowerShell 看到的亂碼是終端顯示問題，不是檔案本體壞掉。
- 現在新增本中文 README，作為 repo 使用者的主要 zh-TW 入口。

## 注意事項

- 不要 commit `config/runtime/adapter.local.json`。
- 不要 commit `config/sources/websocket/ais_collector.local.json`。
- 不要 commit runtime logs、PID、下載資料集、資料庫檔。
- 真實 secret 應放環境變數、local config、K8 Secret 或 Airflow Variable。
- AISHub polling 目前只是備援，不是 MVP 主線。
- EEZ 國家/主權歸屬尚未完成，只畫幾何，不等於已能說明每一片海域屬於誰。
