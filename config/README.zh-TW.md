# Config 合約分層

本專案的 runtime 入口仍是 `config/adapter.local.json`，但它現在只是一份 profile，不直接持有資料庫、空間圖層或 websocket 來源的細節。實際啟用的 route fragments 以 `config/router_manifest.local.json` 的 `active_configs` 為唯一真相來源。

## Profile

`adapter.local.json` 負責：

- Flask 服務與 port 設定
- 啟動時必要的 bootstrap 設定
- 舊版相容用的 `default_dataset`

它不應該直接塞 MySQL、PostGIS、AISStream API 等具體協定細節，也不再持有另一份啟用路由集合。

## DATABASE

`database.local.json` 負責消費端資料庫路由：

- `sql_backend`
- `connections`
- `query_policy`
- 舊版 `datasets`
- 舊版欄位映射，例如 `time_column`、`lat_column`、`lon_column`

未來切 Hive、Spark、MongoDB 或其他 backend 時，應新增或修改 DATABASE fragment，而不是把值塞回 profile。

目前舊版 `datasets` 仍可運作。後端會把它正規化成 `rrkal.layer_contract.v1`，讓新舊合約可以同時被系統吃下來。

## SPATIAL

`spatial.eez.local.json` 負責空間圖層路由：

- EEZ / PostGIS overlay 設定
- PostGIS host、port、database、table、tile table
- MVT layer 與 geometry 欄位設定

SPATIAL 不是一般資料集查詢路由；它服務地圖 overlay。EEZ 不應混在 DATABASE 合約裡。

## WEBSOCKET

`websocket.aisstream.local.json` 負責 websocket/source 設定：

- AISStream provider
- websocket endpoint
- API key fingerprint
- collector handoff path

`live.ais` 目前仍保留 runtime 既有形狀，內含本機 AIS read-model 需要的 SQL 讀取欄位。這是過渡合約；下一階段應再拆成 AIS source、AIS sink、AIS read model。

## Router Manifest

`router_manifest.local.json` 是開發者控制面板的狀態檔：

- `active_configs`：目前啟用的 route fragments，也是 runtime 組裝路由的唯一真相來源
- `locked_configs`：禁止 UI 修改的 config
- `config_groups`：把 config 分到 `database`、`spatial`、`websocket`、`demo`
- `config_notes`：使用者註記
- `imported_layers`：由已啟用路由提供、且已導入儀表板的資料圖層

DEMO 不會進入路由狀態機，也不能被啟用。

## Schema Inspector

`SchemaInspector.py` 是純後端探測器。

它只做三件事：

- 依照目前啟用的 DATABASE route 連到關聯式資料庫
- 讀取 schema、table、column、型別、索引與 nullable 等資訊
- 產生保守的候選提示，例如 `time_candidate`、`latitude_candidate`、`numeric_candidate`

它不決定欄位語意，不建立圖層，也不修改 config。使用者要在 Mapping Controller 裡手動決定欄位如何對應。

## Mapping Controller

Mapping Controller 是前後端共同的控制器，前端位置在開發者頁的「路由狀態機」與「路由提供圖層」之間。

它的責任是把 Schema Inspector 探測到的欄位暴露給使用者，讓使用者手動定義：

- 哪個 table 要形成資料圖層
- 哪些欄位是時間、經度、緯度、識別欄
- 哪些欄位要作為顯示欄、指標欄或分類欄

目前第一階段先顯示 schema profile 與舊合約候選映射。後續若要真正保存使用者映射，應寫回獨立 mapping contract，再由 Layer Contract 正規化。

## Layer Contract

`LayerContractService.py` 是後端 Layer Contract 正規化層。

它把不同來源整理成一致的資料圖層合約：

- 舊版 `datasets` 會變成 `contract_source = legacy_dataset_contract`
- WEBSOCKET route 會變成 `contract_source = websocket_route_contract`
- SPATIAL route 會變成 `contract_source = spatial_route_contract`

Layer Contract 是儀表板資料圖層導入的後端語意來源。它不是 UI 狀態，也不是資料庫 schema 本身。

## Runtime 組裝流程

`core.py --config config/adapter.local.json serve` 會先讀 profile，再由 `ConfigContracts.py` 讀取 `router_manifest.local.json.active_configs`，依序組裝 DATABASE、SPATIAL、WEBSOCKET fragments。

開發者控制面與主服務不各自維護兩套啟用集合。runtime 的啟用真相就是 manifest。
