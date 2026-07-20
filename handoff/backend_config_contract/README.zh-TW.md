# Backend / System Source Config Contract Handoff

## 目的

這份交接給後端／系統負責人，說明目前可執行的資料源註冊合約，以及提案文件與 Runtime 真相的邊界。

核心原則：後端提供可連線、可探測的 source；本系統以 Probe／Scout 讀取資料事實，再由 Mapping 翻譯成內部 Canonical 合約。Runtime 不直接理解來源內部 schema，也不把來源後設描述當成不可質疑的資料真相。

## 權威與提案

目前 Runtime 權威：

- `config/schemas/adapter.schema.json`：只驗證服務、查詢政策與渲染政策。
- `config/examples/runtime/adapter.example.json`：Runtime JSON 範例，不包含 source connection 或 dataset 欄位。
- `config/sources/<role>/*.json`：正式外部資料源設定。
- `config/state/router_manifest.local.json`：`active_configs` 與 `imported_layers` 的持久化真相。
- `config/artifacts/layer_mappings.local.json`：Probe／Scout 結果經 Mapping Controller 確認後形成的內部合約。
- `common_adapter/query/registry.py`：database 與 endpoint 共用的 query-adapter registry。
- `common_adapter/db/connect.py`：SQL source config loading 與 backend dispatch。

以下只是交接協商提案，不會被 Runtime 直接載入：

- `handoff/backend_config_contract/backend_capability_matrix.example.json`
- `handoff/backend_config_contract/backend_sink_config.example.json`

若後端回填 sink 或 capability proposal，必須先轉成正式 source config，經 Probe、Mapping、Layer Import 驗證後才會進 Dashboard。不得把 proposal 直接複製進 runtime JSON。

## 唯一註冊鏈

```text
Runtime policy JSON
  + Router Manifest.active_configs
  -> Source Config
  -> Probe / Scout
  -> Mapping Controller artifact
  -> Runtime Layer Registry
  -> imported_layers
  -> Dashboard
```

各層責任：

| 真相 | Owner |
|---|---|
| Server port、全域 query policy、rendering policy | Runtime JSON |
| Host、port、driver、auth、source capability | Source config |
| 實際 tables、fields、型別、資料格網與 coverage | Probe／Scout observation |
| Query fields、Canonical roles、extension columns | Mapping Controller |
| Source 是否啟用、Layer 是否導入 | Router Manifest |
| Query adapter class | `common_adapter/query/registry.py` |

## SQL source config

MySQL、Hive 或 Spark SQL 類型的 source 放在 `config/sources/database/`。範例：

```json
{
  "schema": "rrkal.adapter.database.v1",
  "role": "database",
  "name": "class_hive",
  "sql_backend": {
    "kind": "hive",
    "driver": "placeholder"
  },
  "connections": {
    "class_hive": {
      "kind": "hive",
      "driver": "placeholder",
      "host": "hive-server.local",
      "port": 10000,
      "user": "hive",
      "password": "env:HIVE_PASSWORD",
      "database": "common_warehouse"
    }
  }
}
```

Source config 只宣告如何抵達來源。實際 table 與欄位由 Schema Inspector 探測；使用者確認的 time、lat、lon、id、value 與其他欄位角色保存於 Mapping artifact，不再複製到 runtime JSON。

## HTTP serving source config

已提供 catalog／query wire contract 的服務可使用 HTTP endpoint adapter。Pipeline Iceberg 範例位於 `config/examples/sources/database/pipeline-iceberg.example.json`：

```json
{
  "schema": "rrkal.source.database.v1",
  "role": "database",
  "name": "pipeline_iceberg",
  "backend": { "kind": "iceberg" },
  "adapter": { "kind": "http_endpoint" },
  "query_policy": {
    "max_in_flight": 2,
    "max_request_in_flight": 3
  },
  "endpoint": {
    "scheme": "http",
    "host": "<host-ip>",
    "port": 30801,
    "base_path": "/api/v1",
    "catalog_paths": ["catalog"],
    "health_paths": ["/healthz"],
    "timeout_seconds": 3
  }
}
```

`backend.kind` 描述資料語意，`adapter.kind` 描述傳輸方式。HTTP serving 的 Pipeline Iceberg 已可使用；這不代表 `SparkReadBackend` 或直接 Hive/Spark SQL driver 已完成。

## Query adapter registry

目前共用註冊介面是：

```python
@query_adapter("mysql")
class MySqlReadBackend:
    ...

@query_adapter("hive")
class HiveReadBackend:
    ...

@query_adapter("spark")
class SparkReadBackend:
    ...
```

MySQL 已實作。Hive 與 Spark 是 explicit unsupported stub；設定檔存在只代表宣告位置存在，不代表可以啟用。啟用前至少需要 driver、schema probe、date／BBOX records query 與錯誤語意測試。

## 啟用與導入

1. 將 source JSON 放入與 `role` 相同的 `config/sources/<role>/`。
2. 在開發者控制頁勾選啟用，讓該路徑進入 `router_manifest.local.json.active_configs`。
3. Probe／Scout 顯示來源實際提供的 tables、fields、coverage 與解析度。
4. Mapping Controller 將選定欄位轉成 Canonical roles 或 extension columns。
5. 在資料圖層導入區勾選 Layer，使其進入 `imported_layers`。
6. Runtime Layer Registry materialize 成 `/api/datasets` 可見圖層。

只修改 source JSON 不等於啟用；只啟用 source 也不等於已導入圖層。

## Stable sink proposal

`backend_sink_config.example.json` 可以用來協商 read-model table 與欄位語意，但目前不是 Runtime schema。接受提案後：

- connection 轉成 source config；
- table 與欄位由 Probe 再驗證；
- 欄位角色轉成 Mapping；
- 啟用與導入仍由 Router Manifest 管理。

既有 sink 欄位語意若必須改變，應新增 `sink_ref`、table 或 dataset identity，不要原地改寫舊契約。密碼與 token 只放環境變數、ignored local config、K8 Secret 或 Airflow Variable。

## Skin / display proposal

Skin 是顯示語意，不是 source query schema。目前 `backend_capability_matrix.example.json` 內的 skin/display 仍為 disabled proposal，不會自動進 Runtime。正式接入前必須另有 schema、Mapping／ViewModel owner 與 UI 驗證，不能因 proposal 有值就宣稱已啟用。

## 驗收

後端交付至少應驗證：

1. Runtime JSON 可通過 `config/schemas/adapter.schema.json`，且不包含 source 欄位。
2. Source JSON 的資料夾與 `role` 一致。
3. Source 被啟用後，Developer Route Status 能反映真實可用性。
4. Probe／Scout 能看到來源實際 tables、fields 或 catalog contract。
5. Mapping artifact 能指出 source field 到 Canonical role／column 的 lineage。
6. Layer 導入後，`/api/datasets`、Dashboard 與 Router Manifest identity 一致。
7. 未完成的 Hive／Spark backend 保持不可用，不因 JSON 存在而被誤啟用。

## 不要混淆的邊界

- Runtime JSON 不保存 source connection、dataset 或 Mapping。
- Source config 不決定 Canonical 欄位語意。
- Probe／Scout 觀察資料事實，不受既有 Mapping 反向過濾。
- Mapping 負責翻譯，不負責建立來源連線。
- Capability proposal 不等於 Runtime capability。
- HTTP Pipeline Iceberg adapter 可用，不等於直接 Spark/Hive backend 可用。
- AIS crawler 的 raw API key 不屬於 Dashboard Runtime config。
