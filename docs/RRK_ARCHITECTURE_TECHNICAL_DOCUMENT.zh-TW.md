# RRK 技術文件：從 PyHive Driver 到多 Dataset 全端與 Kubernetes

> 範圍：RRK 0.1.0～0.10.0、0713～0716 實驗結果與目前實作行為。本文只使用元件角色、協定與版本階段，不揭露內部檔名。

## TL;DR

- RRK 解決的第一個系統問題是：Spark on Kubernetes 能執行批次 SQL，但瀏覽器沒有穩定、可重複呼叫的 serving endpoint。RRK 以 Spark Thrift 作為 SQL endpoint，以 PyHive 作為 Flask driver，再用 Kubernetes Service 提供穩定網路名稱。
- RRK 解決的第二個系統問題是：初始 API curl 約 148.6 秒，且 Spark Thrift 在連續查詢時發生 native-thread OOM。連線重用降低 session churn；關閉 Iceberg locality 查詢才排除觀察到的 HDFS block-location thread 壓力。暖機後 API backend 約 0.366～0.375 秒，curl total 約 1.34～2.03 秒。
- RRK 解決的全端問題是：raw Gold rows 不能直接驅動地圖、日期播放、選取、表格與圖表。Adapter 必須把來源欄位、時間、幾何、AOI、解析度與值域轉成 canonical dataset contract。
- 「目前只有一種 adapter」不代表「只能有一個 dataset」。一個 adapter type 代表一種來源協定；catalog 每列資料定義會產生一個 runtime dataset descriptor，查詢 registry 再以同一 adapter type 處理多個 dataset instances。
- 目前 0.10.0 的正式部署是單一 Flask Pod 直接使用 Hive adapter 連 Spark Thrift；程式同時具備未來拆成 RRK source Pod 與 GFW consumer Pod 的 HTTP catalog adapter 能力。兩種模式共用相同 canonical contract。
- 專題的核心不是再做一張地圖，而是完成資料平台到使用者產品之間的 Data Serving 與 Contract Integration：讓資料可查、可量測、可互動、可播放、可部署，也能在失敗時定位是哪一層出問題。

## GLSR

- `Driver`：Driver 實作應用程式與既有 endpoint 的通訊協定。PyHive driver 讓 Flask 以 HiveServer2／Thrift SQL 協定呼叫 Spark Thrift。
- `Spark Thrift`：Spark Thrift 將 Spark SQL 暴露成長時間存在的 SQL service；它不是 Spark batch job 本身。
- `Serving path`：Serving path 是 UI state → HTTP request → Flask → PyHive → Spark → rows → JSON → browser 的完整資料路徑。
- `Adapter type`：Adapter type 定義如何向某一種來源協定查詢，以及如何把 response 轉成 canonical packet。
- `Dataset instance`：Dataset instance 是由 catalog item 與 mapping 產生的具名資料產品，擁有獨立欄位角色、AOI、解析度、值域與 cache identity。
- `Catalog`：Catalog 是來源服務提供的資料產品清單；GFW 依 catalog 動態建立 datasets，而不是把 datasets 寫死在前端。
- `Canonical contract`：Canonical contract 用固定語意表示時間、cell identity、位置、數值、類別、coverage 與解析度，隔離來源 schema 與前端能力。
- `AOI`：AOI 定義可查詢的地理區域與資料 partition，不等於地圖比例尺。
- `Viewport query`：Viewport query 將瀏覽器可視 bbox 轉成來源端格網範圍，避免每次下載整個區域。
- `Cache identity`：Cache identity 用 dataset、date、AOI、resolution 與 bbox 區分快取，避免不同查詢互相污染。
- `Cold path`：Cold path 包含首次 connection、session、Spark planning 與 executor 啟動成本。
- `Warm path`：Warm path 重用既有 connection、session 與已完成的 frame，因此代表互動操作的穩態成本。
- `Capability`：Capability 是前端可執行的功能，例如地圖、播放、選取、表格或圖表；capability 消費 dataset contract，不直接理解來源表。

## 1. 從 PyHive Driver 開始的端到端架構

### 1.1 為什麼選 PyHive

Driver 的選擇由後端 endpoint 協定決定，不由 Flask 偏好決定。既有 Spark 服務提供 HiveServer2 相容的 Thrift SQL endpoint，因此 Flask 使用 PyHive 可以直接建立 session、建立 cursor、執行 SQL 與取回 rows。若改用 PySpark，Flask Pod 會變成 Spark client，必須攜帶 Spark／Hadoop runtime、YARN 設定與更大的資源；若改用 MySQL driver，則無法連接 Spark Thrift；若改用 Trino client，則前提是叢集先存在 Trino endpoint。[E1][E2]

| 方案 | 連接目標 | Flask Pod 負擔 | 與本專題的關係 |
|---|---|---:|---|
| PyHive | Spark Thrift SQL endpoint | 中 | 符合現有協定，也是目前實作 |
| PySpark | YARN／Spark runtime | 高 | Flask 會變成 Spark client，部署更重 |
| JDBC bridge | Spark Thrift JDBC | 中高 | Python bridge 與 Java runtime 增加複雜度 |
| MySQL driver | MySQL protocol | 低 | 協定不相容，不能讀 Spark Thrift |
| Trino client | Trino endpoint | 低 | 目前沒有相對應 endpoint |

### 1.2 Spark on Kubernetes「沒有 endpoint」的真正意思

Spark batch application 有 driver 與 executors，但 batch application 不會自動成為提供給瀏覽器的長時間 API。Pod IP 也會隨排程與重啟改變，因此把 Pod IP 寫進 Flask 不能形成穩定服務。RRK 建立的路徑是：Spark Thrift 長時間監聽 SQL port，Kubernetes Service 提供穩定 DNS，Flask 再把 SQL 能力包裝成資料 API。[E2][E3]

```text
flowchart TD
  A["Browser reads UI state"] --> B["Browser sends dataset request"]
  B --> C["Flask validates query context"]
  C --> D["Query registry selects a driver adapter"]
  D --> E["PyHive opens or reuses a Thrift connection"]
  E --> F["Spark Thrift submits Spark SQL"]
  F --> G["YARN schedules Spark work"]
  G --> H["Spark reads Iceberg metadata and HDFS data"]
  H --> I["Spark returns rows through Thrift"]
  I --> J["Flask canonicalizes rows and builds a packet"]
  J --> K["Flask serializes a JSON response"]
  K --> L["Browser caches and renders the dataset"]
```

### 1.3 PyHive connection lifecycle

目前 connection manager 在單一 Python process 中延遲建立一條 connection，並用 lock 序列化 SQL。每次 request 建立自己的 cursor；cursor 完成後關閉，但 connection 保留給下一次 request。Connection 不會永遠不關：transport／session 失效時 manager 會丟棄它，process 正常結束時也會關閉它。若錯誤可重試，manager 重連並重試一次；伺服器回報的非連線型 SQL 錯誤不重試，避免把資料或語法錯誤誤判成暫時網路問題。[E1][E3][E5]

```text
flowchart TD
  A["Request enters Flask"] --> B["Manager acquires process lock"]
  B --> C{"Reusable connection exists?"}
  C -->|"Yes"| D["Create request cursor"]
  C -->|"No"| E["Create PyHive connection"]
  E --> D
  D --> F["Execute SQL and fetch rows"]
  F --> G["Close cursor"]
  G --> H["Keep connection for next request"]
  F -->|"Retryable transport error"| I["Discard connection"]
  I --> J{"Already retried once?"}
  J -->|"No"| E
  J -->|"Yes"| K["Return error"]
```

這個設計解決單 process 的重複 handshake，但不等於全叢集只有一條 connection。每一個 Flask worker、每一個 Pod 都有自己的 process-local manager。若 replicas 或 worker 數增加，Spark Thrift 看到的 connection 與併發 SQL 也會增加。

**Recommendation：**在增加 Flask replicas 前，先替 Spark Thrift 定義最大 session 與 query concurrency，再讓每個 Pod 使用有限連線數。依據是 0715 連續查詢曾出現 thread 壓力，而 process-local reuse 無法約束跨 Pod concurrency。[E3]

### 1.4 時間量測與速度演進

0713 的第一條 heatmap curl 回報 `query_ms ≈ 148,590 ms`。0715 將生命週期拆開後，第一次 instrumented cold path 的 curl total 約 `5.45 s`；第二次約 `3.32 s`；第 3～5 次 warm path 的 backend 約 `366～375 ms`，curl total 約 `1.34～2.03 s`。同一批 warm response 約 `3.53 MB`，下載約 `0.79～1.56 s`，因此穩態波動主要已從 Spark execute 轉移到 JSON 與網路。[E2][E3]

| 階段 | 初始觀察 | Warm 觀察 | 可推論內容 |
|---|---:|---:|---|
| CLI 原生查詢 | 個位數秒級 | 個位數秒級 | Gold 與 Spark SQL 本身可查 |
| 第一個 API smoke curl | 約 148.6 s | 未量測 | 初始 serving path 不可互動 |
| PyHive connection | 約 753 ms | 約 26～29 ms | connection 有 cold-start 成本，但 warm 時不是主瓶頸 |
| Spark execute | 約 3.52 s | 約 155～167 ms | Spark planning／session warm-up 是主要 cold cost |
| API backend | 約 4.56 s | 約 0.366～0.375 s | SQL、fetch、轉換在 warm path 已穩定 |
| JSON＋網路 | 約 0.82 s | 約 0.79～1.56 s | warm total 的主要波動來源 |
| 最終前端 | 尚不可用 | 西北太平洋／4 km 數秒載入 | Serving path 已進入互動範圍 |

`148.6 s → 約 2.0 s` 的端到端差異約為 `74×`。這個數字代表不同成熟階段的實測結果，不代表單一修改獨自帶來 74×；改善同時包含 connection lifecycle、Spark warm-up、查詢範圍、快取、穩定性與前端 frame pipeline。

### 1.5 Spark Thrift native-thread OOM

連續 curl 的失敗不是固定發生；每五次為一組時，部分組別出現 2 次 fail。Flask connection reuse 降低 session churn 後，20 次測試仍有 2 次 fail，證明 connection lifecycle 不是完整根因。錯誤位置顯示 Iceberg 在 planning 階段向 HDFS 查詢 file block location，Hadoop RPC 平行建立 native threads，JVM 無法再建立 thread 後回傳 OOM。[E3]

修正將 Iceberg locality 查詢關閉。Spark 仍讀 Iceberg 與 HDFS，也仍使用 YARN；它只是不再先為每個資料檔查詢 executor location preference。Trade-off 是 executor 可能離資料較遠，增加網路傳輸；收益是 planning 不會在 SQL 開始前因 thread 建立失敗。設定後的觀察樣本為 20 次 curl、0 fail。[E3]

```text
flowchart TD
  A["Spark reads Iceberg file plan"] --> B{"Locality lookup enabled?"}
  B -->|"Yes"| C["Hadoop RPC requests HDFS block locations"]
  C --> D["Planning creates many native threads"]
  D --> E["Thread pressure may stop SQL before execution"]
  B -->|"No"| F["Skip block-location preference"]
  F --> G["YARN uses available executors"]
  G --> H["Executors read data from HDFS"]
```

### 1.6 查詢範圍、資料量與 response

早期固定 `LIMIT 20,000` 讓 API 看起來快，但會切掉地圖格網，造成不完整空洞。後續版本先改成完整 snapshot，再量出西北太平洋單一 dataset 的每日資料量。完整 JSON 會同時壓迫 Spark fetch、Flask memory、serialization、HTTP 與 browser rendering。系統因此改用 viewport bbox pushdown，將可視經緯度轉成格網索引範圍；同時保留 AOI、解析度與最大 row budget。[E1][E4]

| 西北太平洋解析度 | 單一 dataset／單日 rows | 單一 dataset／31 日 rows |
|---|---:|---:|
| 4 km | 345,600 | 10,713,600 |
| 16 km | 21,600 | 669,600 |
| 32 km | 5,400 | 167,400 |

這些 row counts 是每一個 product／metric dataset 分開計算。若同一天同時讀五個相同格網粒度的資料產品，四公里理論總量會是 `345,600 × 5 = 1,728,000 rows`；目前前端垂直切片只啟用單一 SST dataset，所以單日完整 AOI 的基準是 `345,600 rows`。Viewport query 若只涵蓋部分畫面，實際 response 會少於這個完整 AOI 數量。

0.9.0 將 budget 從 12,000 提高到 400,000，因為 12,000 會讓使用者明明選四公里，後端卻自動降到十六或三十二公里。400,000 讓完整西北太平洋四公里落在允許範圍內，但仍保留保護上限。[E1]

**Recommendation：**若未來多使用者同時查四公里大範圍，保留 viewport pushdown，並增加 HTTP compression 或格網 tile／binary transport。依據是 warm backend 已低於 0.4 秒，但 3.53 MB JSON 下載仍需要 0.79～1.56 秒。[E3]

## 2. Adapter、API JSON 與多 Dataset 全端架構

### 2.1 四個名詞不能混在一起

| 名詞 | 回答的問題 | 數量關係 |
|---|---|---|
| Source protocol | 資料如何被呼叫？ | 一種 endpoint protocol 可服務多個產品 |
| Adapter type | 如何查詢與轉換這種 protocol？ | 通常一種 protocol／資料形狀一種 adapter type |
| Dataset instance | 這一份資料產品是什麼？ | catalog 每個 item 可產生一個 dataset |
| Frontend capability | 這份 dataset 能做什麼？ | 一個 dataset 可被多個 capabilities 共用 |

所以正確關係不是「一個前端功能配一個 adapter」，也不是「一張表配一個 adapter」。正確關係是：adapter type 處理協定；dataset contract 描述語意；frontend capability 消費語意。

### 2.2 目前單 Pod 模式與未來雙 Pod 模式

目前 0.10.0 使用單一 Flask Pod。GFW consumer 與 Hive adapter 在同一個 process 中，adapter 直接透過 PyHive 查 Spark Thrift，不會在同一 Pod 內用 HTTP 呼叫自己。這個模式部署簡單、少一次 JSON hop，適合目前專題驗證。[E1][E4]

```text
flowchart TD
  A["Browser"] --> B["GFW frontend and dataset API"]
  B --> C["Hive adapter"]
  C --> D["PyHive"]
  D --> E["Spark Thrift"]
  E --> F["Spark／Iceberg／HDFS"]
```

未來若拆成兩個 Pod，RRK source Pod 只負責 source catalog、availability、snapshot 與 timing；GFW Pod 使用 HTTP adapter 讀 RRK JSON。這個模式讓 RRK 與 GFW 可以獨立擴充、部署與限流，但增加一次 HTTP serialization、網路失敗與版本相容問題。[E5]

```text
flowchart TD
  A["Browser"] --> B["GFW consumer Pod"]
  B --> C["HTTP dataset adapter"]
  C --> D["RRK source Pod"]
  D --> E["PyHive"]
  E --> F["Spark Thrift"]
  F --> G["Spark／Iceberg／HDFS"]
```

**Recommendation：**目前專題保留單 Pod 作為主要 demo，將雙 Pod 作為架構延伸。依據是目前效能目標已達成，而雙 Pod 會把已知的 JSON transport 成本再加入一次；只有在團隊權責、獨立擴縮或來源共用需求明確時，拆分才產生足夠收益。[E3][E4][E5]

### 2.3 一個 adapter type 如何產生多個 datasets

HTTP catalog adapter 的核心流程是：

```text
flowchart TD
  A["RRK returns catalog JSON"] --> B["GFW reads dataset items"]
  B --> C["Catalog mapper reads id label product metric"]
  C --> D["Catalog mapper attaches AOI resolutions geometry and value domain"]
  D --> E["Catalog mapper creates one runtime dataset descriptor per item"]
  E --> F["Query registry selects the shared HTTP adapter type"]
  F --> G["Adapter receives one descriptor and creates a query instance"]
  G --> H["Frontend registry exposes multiple datasets and layers"]
```

概念演算法如下：

```text
catalog = source.get_catalog()

for item in catalog.datasets:
    contract = mapping.build_contract(item)
    runtime_dataset = DatasetDescriptor(contract)
    dataset_registry.add(runtime_dataset)

on_query(dataset_id, request_context):
    dataset = dataset_registry.get(dataset_id)
    adapter_type = adapter_registry.resolve(dataset.backend_kind)
    adapter = adapter_type(source_config, dataset)
    return adapter.records(request_context)
```

同一 adapter type 的程式碼沒有複製，但每個 dataset descriptor 保留獨立的 product、metric、AOI、resolution、value domain 與 cache namespace。因此一個 adapter 可以服務海溫、漁業活動與生產力等多個格網 dataset，只要它們遵守相同 sampled-grid protocol。[E5]

### 2.4 RRK 到 GFW 傳的是 JSON packet，不是 database row

資料庫回來的是 raw rows；RRK 或 GFW source adapter 將 raw rows 放進 JSON envelope。GFW HTTP adapter 接收 JSON、讀取 metadata 與 rows，再將每列轉成 canonical row。瀏覽器取得的是 canonical JSON response，不會直接接觸 PyHive cursor row。

Catalog packet 的抽象範例：

```json
{
  "contract_version": "dataset-catalog.v1",
  "datasets": [
    {
      "id": "ocean_temperature",
      "label": "Ocean Temperature",
      "kind": "sampled_grid",
      "product": "temperature_product",
      "metric": "temperature_metric",
      "operations": ["schema", "snapshot", "range", "time_series"],
      "value_domain": {"min": 0, "max": 40, "unit": "degree"}
    }
  ],
  "coverages": [
    {"id": "regional_a", "bounds": {"west": 100, "south": 10, "east": 140, "north": 40}}
  ],
  "resolutions_km": [4, 16, 32]
}
```

Snapshot packet 的抽象範例：

```json
{
  "dataset_id": "ocean_temperature",
  "rows": [
    {
      "date": "2024-01-01",
      "cell_id": "cell-001",
      "value": 25.8,
      "resolution_km": 4,
      "bounds": {"west": 120.0, "south": 22.0, "east": 120.04, "north": 22.04},
      "coverage_ratio": 0.75,
      "data_status": "available"
    }
  ],
  "grid": {
    "requested_resolution_km": 4,
    "actual_resolution_km": 4,
    "coverage_id": "regional_a"
  },
  "timing": {
    "query_ms": 320,
    "api_total_ms": 380
  }
}
```

若來源只回傳五個欄位，也不代表任何五欄 JSON 都能自動變成地圖。最小 sampled-grid contract 必須具有：

1. `time`：快照或播放日期。
2. `id`：穩定 cell identity。
3. `value`：可視化數值。
4. `geometry`：直接提供 bounds／lat／lon，或提供 row／column／resolution 並在 catalog 宣告 origin 與 index units。
5. `request semantics`：AOI、resolution、date 與 bbox 如何映射到來源 query。

Coverage、status、category 與 value domain 雖可選，但會影響透明度、圖例、圓餅圖與橫條圖。

### 2.5 一個 dataset 為什麼能支援多個前端功能

| 前端能力 | 消費的 canonical roles | 是否需要另一個 adapter |
|---|---|---|
| 格網地圖 | cell identity、bounds、value、resolution | 否 |
| 日期播放 | time、available dates、snapshot operation | 否 |
| 格網選取 | cell identity、bounds、current frame | 否 |
| 資料表 | display columns、current rows | 否 |
| 折線圖 | time、metric、range／time-series operation | 通常否 |
| 圓餅圖 | category、metric、current selection | 通常否 |
| 橫條圖 | category、metric、aggregation | 通常否 |

同一 dataset 可以支援多個 capabilities，因為 capabilities 消費的是同一 frame 的不同角色。只有當資料粒度或協定根本不同，例如「每格每日值」與「全區每日狀態分布」，才需要另一種 dataset contract；這仍不代表每張 Gold table 都要新增一套 adapter 程式。

### 2.6 多類 Gold 資料如何使用

0716 顯示目前至少存在地圖格網、每日儀表板指標、格網特徵與狀態分布等 Gold 類型。0.10.0 先把地圖格網 dataset 做成可運作的垂直切片；其他 Gold 尚未全部轉成 runtime datasets。[E4]

| Gold 語意類型 | 建議 dataset contract | 主要能力 | 是否共用 sampled-grid adapter |
|---|---|---|---|
| 地圖格網快照 | sampled-grid | 地圖、播放、選取、表格、當日圖表 | 是 |
| 每日指標 | time-series／aggregate | KPI、折線圖、比較 | 若 response 符合 time-series operation，可共用來源協定；不強迫轉成格網 |
| 格網特徵 | sampled-grid detail | 選取詳情、表格、特徵比較 | 可共用格網 identity，但欄位 contract 需擴充 |
| 狀態分布 | categorical aggregate | 圓餅圖、橫條圖 | 不適合假裝成格網；使用 aggregate contract |

**Inference：**將四類 Gold 合併成一個巨大 JSON 會混合不同粒度、增加 response、讓 cache identity 與更新週期難以定義。

**Recommendation：**RRK catalog 應逐一列出語意資料產品；相同 sampled-grid protocol 共用一個 adapter type，不同粒度使用另一種 contract。依據是目前前端已用 canonical roles 解耦 capability，而現有 registry 也以 backend kind 選 adapter，不以 table name 選 adapter。[E5]

### 2.7 前端 request、state、cache 與 rendering

完整互動鏈如下：

```text
flowchart TD
  A["User selects dataset AOI resolution and date"] --> B["Frontend updates request state"]
  B --> C["Frontend builds render intent"]
  C --> D["Frame identity includes dataset date AOI resolution and bbox"]
  D --> E{"Canonical frame already cached?"}
  E -->|"Yes"| F["Reuse frame"]
  E -->|"No"| G["Request dataset packet"]
  G --> H["Adapter queries source and canonicalizes rows"]
  H --> I["Frame store commits actual resolution and rows"]
  I --> F
  F --> J["Map table and widgets consume the same frame"]
  J --> K["Playback preheater requests upcoming dates"]
```

AOI、resolution 與 bbox 都必須進入 request state 與 cache identity。若 AOI 不在 identity 中，台灣 frame 可能被西北太平洋誤用；若 requested 與 actual resolution 不分開，使用者選四公里但來源降級到三十二公里時，前端可能錯誤重用 frame；若 change event 沒接上 active dataset，選單文字會改，API request 卻不會發生。0.6.0～0.10.0 的主要工作就是逐步修正這些跨層狀態。[E1]

連續播放依賴 frame store 與 preheater。播放器將下一段日期轉成 frame demand；同一 dataset/date/AOI/resolution/bbox 的地圖與 widgets 共用 canonical frame。這避免同一張資料被地圖、表格與每個圖表分別查一次，也是最終能連續播放的必要條件。[E5]

## 3. RRK 0.1.0～0.10.0 問題演進

### 3.1 版本主線

| 版本 | 階段目標 | 遇到的核心問題 | 解法 | 問題類型 |
|---|---|---|---|---|
| 0.1.0 | 建立 Spark serving path | Spark 有資料但沒有給 Flask 的穩定 SQL endpoint；request 重建 connection；需要分段 timing | Spark Thrift＋PyHive、lazy connection reuse、cursor-per-request、retry-once、診斷 API | 系統 |
| 0.2.0 | 接回完整 GFW 前端 | API rows 出得來，但地圖、播放、表格與 widgets 不理解來源欄位 | 單 Pod 整合、Hive query adapter、canonical sampled-grid contract、snapshot cache | 全端架構 |
| 0.3.0 | 建立可移動的 runtime | 專案資料夾含近 200 MB 本地環境；runtime image 與本機測試內容混在一起 | Build allowlist、縮小 build context、拆出非必要內容 | 叢集／交付 |
| 0.4.0 | 修正資料完整性與地圖導航 | 20,000-row limit 截斷格網；coverage 鎖住地圖導航 | 完整 snapshot、Flask cache、bbox 篩選、coverage 只限制 query | 資料正確性／前端 |
| 0.5.0 | 支援大範圍 Gold | 完整四公里 AOI 過大；ConfigMap 直接掛載為唯讀 | Viewport pushdown、解析度 LOD、runtime config 複製到可寫 volume | 系統／叢集 |
| 0.6.0 | 讓使用者選 AOI 與 resolution | 不同 AOI／resolution 可能共用錯誤快取 | request state 與 frame/cache identity 納入 AOI、resolution、bbox | 全端狀態 |
| 0.7.0 | 恢復完整日期與單列 UI | 日期只剩局部範圍；工具列換行或超出；控制載入不同步 | 完整日期範圍、單列可捲動工具列、dataset 啟用後同步控制 | 前端 UI |
| 0.8.0 | 修正圖層與控制顯示 | 圖層選單被裁切；AOI／resolution 依賴已移除舊控制；YAML 中文亂碼 | 合約驅動選單、控制接線、cache-busting、Unicode escape | 前端／叢集 |
| 0.9.0 | 讓選擇語意真正生效 | 四公里被 12,000-row budget 偷偷降級；AOI fit 使用錯誤 bounds 模式，台灣被裁切 | Budget 400,000、requested／actual resolution、完整 bounds fit | 後端策略／地圖 |
| 0.10.0 | 修正 resolution event | 選單顯示四公里，但 controller 的 dataset state 尚未同步，change 直接返回 | Change handler 直接讀 active dataset、清舊 frame、以 resolution reason reload | 前端事件鏈 |

### 3.2 系統層問題

| 問題 | Observed evidence | 根因 | 已完成處理 | 剩餘風險 |
|---|---|---|---|---|
| Spark 沒有 serving endpoint | CLI 可查，但 browser 無法直接呼叫 Spark batch | Batch job 不是長時間 API；Pod IP 不穩定 | Spark Thrift＋Service DNS＋Flask API | Thrift service 本身仍是關鍵依賴 |
| 初始 curl 148.6 秒 | 同一 Gold 類型 CLI 快、API 極慢 | Cold connection、session、Spark planning、fetch、JSON 全混在一起 | 分段 timing、connection reuse、warm path | 首次 cold request 仍比 warm request 慢 |
| Native-thread OOM | 連續測試間歇 fail，connection reuse 後仍存在 | Iceberg locality 查 HDFS block location 建立 threads | 關閉 locality lookup | 更多 tables／users 仍可能帶來其他資源壓力 |
| 大 response | Warm backend 約 0.37 秒，但 curl total 最多約 2.03 秒 | 3.53 MB JSON serialization／transport | Viewport、cache、欄位控制 | 大範圍四公里仍需要 compression／tile 化 |
| 併發限制 | 單 process 以 lock 序列 SQL | 保護單 connection，但限制同 Pod throughput | 前景／背景查詢 concurrency policy | 多 Pod 會繞過單 process lock |

### 3.3 全端問題

| 問題 | 為什麼只看 API JSON 看不出來 | 修正後的契約 |
|---|---|---|
| 前端不是原 GFW 畫面 | Smoke page 只證明 curl path，不包含完整 component runtime | 保留完整 GFW UI，source 只替換 adapter |
| Raw row 無法畫地圖 | row／column 不等於 lat／lon／bounds | Geometry contract 宣告 origin、units、resolution 並計算 bounds |
| 一個 dataset 被多功能使用 | 地圖、表格與圖表需要不同角色 | Canonical row 同時提供 identity、time、value、category 與 display columns |
| 日期播放不連續 | 每一日、每一 widget 都各自 fetch 會重複查詢 | Frame store＋range demand＋preheater 共享 frame |
| AOI 看似只改縮放 | AOI 若只改 camera，source partition 沒變 | AOI 同時進 query context、frame identity 與 coverage bounds |
| Resolution 看似可選但無效 | UI option、backend LOD、actual frame、change event 分屬不同層 | Requested／query／actual resolution 分離並串接 reload |
| 地圖裁切台灣 | `inside bounds` 與 `fit bounds` 語意相反 | 以完整 AOI bounds 計算可容納的 zoom |

### 3.4 全端進 Kubernetes 後的問題

| 叢集問題 | 實際症狀 | 根因 | 解法／原則 |
|---|---|---|---|
| Build context 太重 | 搬專案目錄耗時，主要體積來自本地虛擬環境 | 本地依賴約 198 MB，runtime source 只有數 MB | 傳輸前排除本地環境；build allowlist 只送 runtime |
| Image 裁切過度 | Pod 啟動後缺 runtime module | Allowlist 忽略實際 import dependency | 以 import graph 與啟動測試驗證 allowlist，不只看大小 |
| ConfigMap 唯讀 | 程式啟動時無法建立 managed config 目錄 | ConfigMap volume 不能寫 | Init container 複製到可寫 ephemeral volume，再掛給主程式 |
| Pod Pending／rollout 卡住 | 新舊 Pod 同時存在、舊 Pod等待終止 | Scheduler resources、rolling strategy 或新 Pod未 Ready | 先看 Pod events、requests／limits、readiness，再決定是否刪舊 Pod |
| Image pull／版本不一致 | UI 與程式回報舊版本 | Mutable `dev` tag、registry pull、Pod 未重建 | Always pull、Pod template revision、runtime version check |
| YAML 中文亂碼 | AOI label 顯示 replacement characters | 編碼經 shell／YAML／JSON 多層轉換 | Config JSON 使用 ASCII-safe Unicode escape 並在 build 前 parse 驗證 |
| 靜態 JavaScript 快取 | 控制已顯示但仍執行舊事件邏輯 | Browser 以相同 URL 重用舊資產 | 每次行為修正更新 asset cache key |
| 大格網記憶體 | 四公里大範圍同時增加 server 與 browser memory | Spark rows、Python dict、JSON text 與 WebGL buffer 各自占用 | Viewport、row budget、bounded cache、column projection |
| 多 replicas 壓 Spark | 每個 Pod 各自建立 connection | Connection reuse 只在 process 內有效 | 在 Spark Thrift 前建立全域 concurrency budget 或 gateway |

## 4. 我的工作位置、專題價值與下一階段

### 4.1 我在架構中的位置

```text
flowchart TD
  A["Data engineering produces Gold data"] --> B["Spark／Iceberg／HDFS stores and computes data"]
  B --> C["RRK data serving and contract integration"]
  C --> D["GFW frontend capabilities"]
  D --> E["Kubernetes delivers the interactive system"]
  C --> F["Timing reliability and failure diagnosis"]
  E --> F
```

我的工作可命名為 `Data Serving and Full-stack Integration`。這個位置包含：

1. 將 Spark SQL 能力轉成穩定 endpoint。
2. 管理 PyHive connection、retry 與 timing。
3. 將 raw Gold rows 轉成 canonical dataset contract。
4. 讓一個 adapter type 動態建立多個 dataset instances。
5. 將 dataset state 接到地圖、播放、選取、表格與 widgets。
6. 將 image、config、service、resources 與 rollout 組合成可運作的 Kubernetes workload。
7. 用跨層證據判斷慢點在 Spark、driver、JSON、network、state 還是 browser rendering。

### 4.2 為什麼這是專題問題點

Gold table 已存在只證明 batch pipeline 產生結果；它沒有回答使用者如何取得資料、如何選日期與區域、如何辨識解析度、如何避免重複查詢、如何連續播放、服務失敗時如何定位、以及程式如何在叢集重啟後繼續工作。

這個專題的難點具有三個特徵：

- `跨邊界`：問題橫跨 browser、Flask、PyHive、Spark Thrift、YARN、Iceberg、HDFS 與 Kubernetes。
- `跨語意`：來源欄位、API packet、canonical row、frame state 與 UI capability 必須一致。
- `跨生命週期`：cold start、warm query、playback、cache、rollout 與 Pod restart 都會改變系統狀態。

因此，成果不能只用「SQL 查得到」驗收；成果要用「使用者在前端選擇西北太平洋與四公里後，畫面數秒出現、request 與 actual resolution 一致、日期能連續播放、服務可在 Kubernetes 重建」驗收。

### 4.3 下一階段：由一個可用 dataset 擴充為多 dataset catalog

1. `盤點語意粒度`：將現有 Gold 分成 sampled-grid、time-series、grid-detail 與 categorical-aggregate，不按 table 數量硬切 adapter。
2. `發布 catalog`：RRK 為每個資料產品提供 id、label、operations、AOI、resolutions、value domain 與 contract version。
3. `建立 mappings`：GFW mapping 宣告來源 row fields、request fields、geometry 與 static product／metric parameters。
4. `產生 instances`：Catalog mapper 逐項建立 runtime datasets；query registry 依 backend kind 使用共用 adapter type。
5. `宣告 capabilities`：每個 dataset 明確標示 map、playback、selection、table、line、pie、bar 的可用性，避免前端猜測。
6. `保留隔離`：每個 dataset 使用獨立 cache namespace；date、AOI、resolution 與 bbox 進入 identity。
7. `控制傳輸`：大範圍 sampled-grid 使用 viewport、compression 或 tile；aggregate dataset 不重送格網 rows。
8. `驗證叢集`：以 immutable release 或可驗證 revision 部署；readiness 同時確認 catalog 與至少一個 dataset contract。

### 4.4 驗收矩陣

| 驗收面 | 驗收問題 | 通過條件 |
|---|---|---|
| Source | Spark endpoint 是否穩定？ | 連續查詢無 observed native-thread OOM；失效 connection 可重連 |
| Catalog | 一個 adapter 能否建立多個 datasets？ | Catalog N items 產生 N 個具唯一 identity 的 runtime datasets |
| Contract | JSON 是否具有可解釋語意？ | Schema、geometry、AOI、resolution、value domain 與 operations 完整 |
| Resolution | 使用者選四公里是否真的查四公里？ | Request、source query、packet actual 與 rendered cell size 一致 |
| AOI | 使用者切區域是否改資料？ | AOI 同時改 source partition、cache identity 與 fitted bounds |
| Performance | 是否達到互動速度？ | Warm backend 與 curl total 有分段數字；前端數秒出圖 |
| Playback | 是否能持續播放？ | Upcoming frames 預取；map 與 widgets 共用 frame；無重複暴增查詢 |
| Kubernetes | 新版本是否真的生效？ | Pod Ready、runtime version 正確、config 可寫、asset revision 正確 |
| Failure diagnosis | 失敗能否定位？ | Log／timing 可區分 connection、execute、fetch、JSON、network 與 render |

### 4.5 Evidence register

- `[E1]` RRK 0.1.0～0.10.0 版本紀錄：提供每版目標、資料完整性、viewport、AOI、resolution、UI 與事件修正。
- `[E2]` 0713 實驗紀錄：提供 CLI／curl 對照、第一個約 148.6 秒 query、Spark routes 與 Kubernetes smoke path。
- `[E3]` 0715 實驗紀錄：提供 cold／warm 分段 timing、3.53 MB JSON 下載、20 次連續測試、native-thread OOM 與 locality 修正。
- `[E4]` 0716 最終紀錄：提供 0.10.0 runtime contract、AOI、4／16／32 km、400,000-row budget 與 Kubernetes 配置結果。
- `[E5]` 目前程式行為與 automated tests：提供 query adapter registry、catalog item → runtime dataset、canonicalization、frame identity、playback cache 與 resolution event 證據。

> 不確定性：最終「西北太平洋／4 km 數秒載入」已有使用者實測結論，但沒有單一固定毫秒紀錄；本文保留「數秒」而不虛構精確數字。CLI 的「個位數秒級」同樣採使用者提供的量級描述。
