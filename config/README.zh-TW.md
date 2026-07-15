# Config 合約分層

本專案的 runtime 入口是 `config/runtime/adapter.local.json`，但它只是啟動用 JSON，不是資料源。它不直接持有資料庫、空間圖層或 websocket 來源的細節。實際啟用的 source configs 以 `config/state/router_manifest.local.json` 的 `active_configs` 為唯一真相來源。

## Runtime JSON

`config/runtime/adapter.local.json` 負責：

- Flask 服務與 port 設定
- query scheduler policy，例如全域 network concurrency 與跨 namespace 的 `snapshot_cache_max_rows`
- rendering/runtime policy

它不應該直接塞 MySQL、PostGIS、AISStream API 等具體協定細節，也不持有另一份啟用路由集合、dataset 清單或啟動遷移規則。開發者頁若顯示它，只能把它視為一般 JSON runtime 入口；它不是 `DATABASE`、`WEBSOCKET`、`SPATIAL` 之外的第四種 router。

## DATABASE

`config/sources/database/local.json` 負責消費端資料庫資料源：

- `sql_backend`
- `connections`
- `query_policy`
- source adapter 可探測的 dataset/table descriptors
- 來源欄位與服務參數；這些仍是 source 外語，不能直接流入 renderer

未來切到其他關聯式或 SQL-like backend 時，應新增或修改對應 source JSON，而不是把值塞回 runtime JSON；source kind 由 `config/sources/<kind>/` 的父資料夾與 JSON 宣告共同決定，probe adapter 只負責探測與下游注入能力。

DATABASE route 只宣告來源能力，不是儀表板最終真相。Schema Inspector 探測 route 提供的表與欄位後，Mapping Controller 才把使用者確認的欄位角色寫入 `config/artifacts/layer_mappings.local.json`。服務啟動不會偷偷把 source config 改寫或遷移成 mapping；後續資料圖層導入、runtime dataset、cache identity 與儀表板都消費同一份 Mapping Controller 產物。

## SPATIAL

`config/sources/spatial/eez.local.json` 負責空間圖層資料源：

- EEZ / PostGIS overlay 設定
- PostGIS host、port、database、table、tile table
- MVT layer 與 geometry 欄位設定

SPATIAL 不是一般資料集查詢路由；它服務地圖 overlay。EEZ 不應混在 DATABASE 合約裡。

## WEBSOCKET

`config/sources/websocket/aisstream.local.json` 負責 websocket/source 設定：

- AISStream provider
- websocket endpoint
- API key fingerprint
- collector handoff path

`live.ais` 目前仍保留 runtime 既有形狀，內含本機 AIS read-model 需要的 SQL 讀取欄位。這是過渡合約；下一階段應再拆成 AIS source、AIS sink、AIS read model。

## Router Manifest

`config/state/router_manifest.local.json` 是開發者控制面板的狀態檔：

- `active_configs`：目前啟用的 source configs，也是 runtime 組裝資料來源的唯一真相來源
- `locked_configs`：禁止 UI 修改的 config
- `config_notes`：使用者註記
- `imported_layers`：由已啟用路由提供、且已導入儀表板的資料圖層

資料源群組不另設覆寫表。`config/sources/<role>/` 的資料夾名稱必須與 JSON 的 `role` 完全一致；從控制頁切換抽屜時會同步搬移檔案、更新 `role`，並遷移下游路徑引用。

`DATABASE`、`WEBSOCKET`、`SPATIAL` 是目前已實作 probe adapter 的內建 source kind，不是資料源類型的永久上限。未來新增 Iceberg、Spark 或其他資料源時，應先新增 `config/sources/<kind>/` 與對應 JSON；若尚未有 probe adapter，控制頁可以列出 source config，但不會把它注入下游 Schema、Mapping 或 Layer Contract。

不在 `config/sources/*/*.json` 底下的 config 不會進入資料源瀏覽器；`config/runtime/`、`config/state/`、`config/artifacts/` 與 `config/examples/` 都不是資料源。

## 持久化產物

這些 `.local.json` 是本機持久狀態，不是暫存快取。可以把它們想像成瀏覽器 cookie 或 local storage：系統會自動生成與更新，但不會因為服務重啟就自動清除。

- `config/state/router_manifest.local.json`：目前啟用的 source、鎖定狀態、導入狀態與註記。
- `config/sources/<role>/*.json`：使用者建立或匯入的 source configs；不是由 runtime JSON 展開的副本。
- `config/artifacts/layer_mappings.local.json`：Mapping Controller 生成的欄位語意與資料圖層 contract 來源。

若要清除或重建這些產物，必須由使用者在控制頁操作，或明確刪除對應 local 檔案。自動化只負責正規化與接線，不負責啟動遷移，也不會偷偷清空使用者已形成的本機狀態。

## Schema Inspector

`common_adapter/developer/schema_inspector.py` 是純後端探測器。

它只做三件事：

- 接收路由狀態機判定為啟用、已連線、可探測的 DATABASE route
- 讀取 schema、table、column、型別、索引與 nullable 等資訊
- 產生保守的候選提示，例如 `time_candidate`、`latitude_candidate`、`numeric_candidate`

它不決定欄位語意，不建立圖層，也不修改 route config。它只把上方路由狀態機的結果往下游注入。

## Mapping Controller

Mapping Controller 是前後端共同的控制器，前端位置在開發者頁的「路由狀態機」與「資料圖層導入」之間。它不是 router，也不屬於 `DATABASE`、`WEBSOCKET` 或 `SPATIAL` 分類。

它的責任是消費 Schema Inspector 探測到的欄位，生成持久化 mapping 產物：

- 哪個 table 要形成資料圖層
- 哪些欄位是時間、經度、緯度、識別欄
- 哪些欄位要作為顯示欄、指標欄或分類欄

使用者不需要手動串接 source、schema、mapping、layer contract 與 dashboard。系統會把 mapping 寫入 `config/artifacts/layer_mappings.local.json`，使用者只需要在頁面上勾選是否把已生成的資料圖層導入儀表板。Mapping 產物可以引用 `DATABASE` source 作為上游資料來源，但它本身是服務內部協議。

HTTP sampled-grid mapping 也負責翻譯來源失敗語意：`query.snapshot.no_data` 宣告哪些來源錯誤代表該切片無資料，`query.snapshot.retry` 宣告哪些錯誤可以有限重試，`resolution_policy` 則只描述真正的 LOD 降級。runtime、renderer 與 Widget 不讀來源錯誤文字。

## Layer Contract

`common_adapter/layers/contracts.py` 是後端 Layer Contract 正規化層。

它把不同來源整理成一致的資料圖層合約：

- Mapping Controller 產物會變成 `contract_source = mapping_controller_contract`，並標成 `contract_group = mapping`
- WEBSOCKET route 會變成 `contract_source = websocket_route_contract`
- SPATIAL route 會變成 `contract_source = spatial_route_contract`

Layer Contract 是「資料圖層導入」的後端語意來源。被導入的 layer 才會進入儀表板資料圖層；儀表板不直接吃 schema inspector，也不直接吃 route config。Mapping contract 的來源路由會以 `source_route_group = database` 表示，不會把 mapping 自己放進 DATABASE router。

## Runtime 組裝流程

`core.py --config config/runtime/adapter.local.json serve` 會先讀 runtime policy，再由 `common_adapter/config/contracts.py` 讀取 `config/state/router_manifest.local.json.active_configs`，組裝 active DATABASE、SPATIAL、WEBSOCKET source configs。DATABASE runtime layers 還必須同時滿足：來源 route active、mapping 存在、layer 已列入 `imported_layers`。

開發者控制面與主服務不各自維護兩套啟用集合。runtime 的啟用真相就是 manifest。
