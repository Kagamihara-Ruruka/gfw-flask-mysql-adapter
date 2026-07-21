# RRK 後四分鐘簡報講稿：從 148 秒到可連續播放

> 本講稿承接既有第 1～4 頁；建議語速約每分鐘 230～260 字。頁面只使用元件角色與資料類型，不揭露內部檔名。

## TL;DR

- 速度主線是：CLI 個位數秒級 → 第一個 API curl 約 148.6 秒 → 暖機後 curl 約 1.34～2.03 秒 → 前端西北太平洋／4 km 可在數秒內載入並連續播放。
- 系統改善來自穩定入口、PyHive 連線重用、Spark Thrift 暖機、Iceberg locality 關閉、viewport 查詢與前端快取，而不是單一「SQL 加速」。
- 一個 adapter 代表一種資料協定；catalog 中每一個資料定義會建立一個 dataset instance，因此一個 adapter 可以產生多個 datasets。
- 我的工作位於 Spark 資料平台與瀏覽器產品之間，負責把可查詢的 Gold 資料變成穩定、可互動、可部署的全端服務。

## GLSR

- `Serving path`：資料從瀏覽器 request 經後端、查詢引擎、JSON response 回到瀏覽器的完整路徑。
- `Adapter`：Adapter 讀取來源協定與 mapping，將來源資料轉成前端共用契約。
- `Dataset instance`：Dataset instance 代表一個具名資料產品，包含欄位角色、時間、範圍、解析度與查詢能力。
- `Canonical contract`：Canonical contract 用固定欄位語意隔離 Gold schema 與前端功能。
- `Warm path`：Warm path 重用既有連線、Spark session 與快取，排除首次啟動成本。

## 第 5 頁｜速度改善不是一次跳躍（約 40 秒）

### 畫面文字

```text
CLI 原生查詢：個位數秒級
        ↓
第一個 API curl：148.6 秒
        ↓
暖機後 API curl：1.34～2.03 秒
        ↓
前端西北太平洋／4 km：數秒載入＋連續播放
```

資料規模：西北太平洋單一 dataset、單一日期，4 km 約 `345,600 rows`。

### 口述講稿

前四頁把 API 生命週期拆開之後，我們開始得到真正可比較的數字。原生 CLI 查詢原本落在個位數秒，但第一個經過 Flask 的 curl 花了大約一百四十八秒。完成連線生命週期、暖機與 Spark 穩定性處理後，相同類型的 curl 總時間降到約一點三四到二點零三秒，其中後端只需要約零點三七秒，其餘波動主要是 JSON 下載。這不是只把 SQL 調快，而是把整條 serving path 從不可用，推進到瀏覽器可以互動的速度。最後在前端選擇西北太平洋與四公里解析度時，資料可以在數秒內出現，日期也能連續播放。

### 視覺建議

- 使用四段式速度階梯或折線圖。
- 將 `148.6 s → 約 2 s` 放大，標示端到端改善約 `74×`。
- 將 `Backend 約 0.37 s` 與 `JSON／網路約 0.8～1.6 s` 分色。

## 第 6 頁｜148 秒如何降到約 2 秒（約 45 秒）

### 畫面文字

- 第一次 PyHive connection 約 `753 ms`，暖機後約 `26～29 ms`。
- 第一次 Spark execute 約 `3.52 s`，暖機後約 `155～167 ms`。
- Flask process 延遲建立並保留 PyHive connection；每次 request 只建立與關閉 cursor。
- Connection 失效時丟棄並重連一次；process 結束時才關閉 connection。
- Spark Thrift 完成 cold start 後保留 warm session。
- 關閉 Iceberg locality 查詢，避免 HDFS block location 建立過量 native threads。
- 時間欄位分開記錄 connection、execute、fetch、transform 與 transport。

### 口述講稿

第一個改善是連線生命週期。第一次 PyHive connection 約七百五十三毫秒，暖機後只剩二十六到二十九毫秒；第一次 Spark execute 約三點五二秒，暖機後約一百五十五到一百六十七毫秒。因此 Flask 不能讓每個 curl 都完整開關 connection，而是由 process 保留 connection，每次 request 只開關 cursor；connection 失效才重連。第二個改善是穩定 Spark Thrift。連續測試時，我們發現 native thread OOM 發生在 Iceberg 查詢 HDFS block location 的規劃階段，因此關閉 locality 查詢，用可能增加少量網路傳輸，換取查詢能穩定開始。Connection reuse 降低 session 成本；locality 修正才排除觀察到的 OOM。

### 轉場句

> 當 API 已經又快又穩，下一個問題就不是「資料能不能出來」，而是「前端如何理解這些資料」。

## 第 7 頁｜一個 Adapter 為什麼能產生多個 Dataset（約 45 秒）

### 畫面文字

```text
RRK Catalog JSON
  ├─ Dataset A：海溫格網
  ├─ Dataset B：漁業活動格網
  └─ Dataset C：生產力格網
          ↓
同一種 Adapter 類型＋不同 Dataset Contract
          ↓
多個 Dataset Instances
```

### 口述講稿

這裡最容易誤解的是，一個 adapter 並不等於只能接一張表。Adapter 是一種轉換規則，例如它知道怎麼呼叫 catalog、怎麼帶日期、區域與解析度、以及怎麼把來源 row 轉成標準格網。RRK 的 catalog JSON 可以列出多個資料產品；GFW 逐項讀取 catalog，替每一項建立獨立 dataset instance。每個 instance 有自己的名稱、指標、值域、AOI、解析度與快取身份，但共用同一套 adapter 程式。因此 adapter 的數量取決於資料協定種類，不取決於資料表數量，也不取決於前端按鈕數量。

### 視覺建議

- 左側放一份 catalog；中間放一個 adapter；右側分裂成三張 dataset 卡片。
- 強調公式：`1 Adapter Type × N Contracts = N Dataset Instances`。

## 第 8 頁｜Dataset 如何支援整個前端（約 45 秒）

### 畫面文字

- 地圖需要格網位置、值與色階。
- 日期播放需要時間欄位與可用日期。
- 格網選取需要穩定 cell identity。
- 資料表需要 display columns。
- 折線圖、圓餅圖與橫條圖需要 metric、category 與時間範圍。
- AOI、解析度與 bbox 必須進入 request state 與 cache identity。

### 口述講稿

一個 dataset 也不是只能支援一個畫面功能。只要 dataset contract 已經定義時間、格網 identity、位置、數值、類別與解析度，地圖、日期播放、格網選取、資料表與圖表就能共用同一份 canonical rows。這也是為什麼早期 raw JSON 明明回來了，完整前端仍然不能工作：前端缺的不是更多 API，而是資料語意。後續版本陸續修正日期範圍、AOI、解析度、viewport、cache identity、工具列與事件鏈，直到使用者選擇四公里時，request 才真的帶四公里，回來的格網也真的以四公里重畫。

### 轉場句

> 全端在本機正確，放進 Kubernetes 仍然不代表會正確，因為部署本身又增加了一層狀態。

## 第 9 頁｜全端進入 Kubernetes 後的新問題（約 40 秒）

### 畫面文字

- Service 提供穩定 endpoint；Pod IP 不可寫死。
- Runtime image 必須同時兼顧體積與相依完整性。
- ConfigMap 是唯讀來源；程式需要可寫 runtime config。
- Rolling update 可能同時存在新舊 Pod；`dev` image 必須配合強制拉取與版本標記。
- Unicode、靜態檔快取與瀏覽器舊 JavaScript 會造成「後端已更新、畫面沒更新」。
- 大範圍四公里資料會同時壓迫 Spark、Flask memory、JSON 與瀏覽器 rendering。

解析度與單日資料量：`4 km = 345,600 rows`、`16 km = 21,600 rows`、`32 km = 5,400 rows`（西北太平洋、單一 dataset）。

### 口述講稿

全端丟進叢集後，我們遇到的問題已經不只是程式錯誤。映像裁切太積極會漏掉 runtime module；設定直接掛載會變成唯讀，程式啟動時無法建立需要的目錄；滾動更新期間可能看到舊 Pod 還在、新 Pod Pending、拉不到 image 或使用舊靜態檔。中文字也曾因 YAML 編碼變成亂碼。這些問題說明 Kubernetes 不只是把本機程式搬上去，而是要求 image、config、service、resources、rollout 與 browser cache 共同一致。

## 第 10 頁｜我的位置與專題價值（約 25 秒）

### 畫面文字

```text
Spark／Iceberg／HDFS
        ↓
Data Serving＋Contract Integration ← 我的工作位置
        ↓
GFW 全端互動與 Kubernetes 交付
```

### 口述講稿

所以我在這個專題裡做的，不只是 Flask，也不只是前端。我位於資料平台與使用者產品之間，負責建立 serving endpoint、穩定 Spark 查詢、設計 dataset contract、接上完整前端，最後讓它在 Kubernetes 中可部署、可量測、可播放。這個位置重要，是因為 Gold table 只能證明資料被算出來；只有經過這一層，資料才真正能被使用者看見、選擇、比較與連續操作。

## 數字備忘

| 階段 | 觀察值 | 解讀 |
|---|---:|---|
| CLI 原生查詢 | 個位數秒級 | Spark／Gold 本身可查 |
| 第一個 API curl | 約 148.6 秒 | Serving path 尚未暖機且連線生命週期不成熟 |
| 第一次完整 cold path | 約 5.45 秒 | 已完成主要程式修正，但仍含 PyHive 與 Spark cold start |
| Warm API backend | 約 0.366～0.375 秒 | 後端查詢與轉換已穩定 |
| Warm API curl total | 約 1.34～2.03 秒 | 主要波動轉移到 JSON 與網路傳輸 |
| 最終前端 | 西北太平洋／4 km、單日約 345,600 rows，數秒載入 | 進入互動式使用階段 |

> 速度證據來源：0713 的首次 curl、0715 的分段 timing 與連續測試、0716 的最終部署結果，以及 RRK 0.1.0～0.10.0 版本紀錄。最終前端的「數秒」是目前實測結論；尚未提供單一固定毫秒值，因此簡報不虛構更精確數字。
