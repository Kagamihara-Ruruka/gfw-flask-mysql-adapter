# Backend / System Config Contract Handoff

## 目的

這份交接給後端/系統負責人。目標是讓他知道：

1. 小可愛目前如何用 JSON 選資料庫、資料集與欄位。
2. MySQL 現在怎麼跑。
3. Hive/Spark 怎麼切，但為什麼目前還不能啟用。
4. 他要回傳什麼樣的欄位/skin 設定給我們。
5. 能力矩陣如何防止未完成能力被誤開。

## 權威檔案

目前 runtime config 權威：

- `config/schemas/adapter.schema.json`
- `config/examples/runtime/adapter.example.json`
- `common_adapter/db/connect.py`
- `database/registry.py`
- `common_adapter/ais/live.py`

提案/交接用能力矩陣：

- `handoff/backend_config_contract/backend_capability_matrix.example.json`
- `handoff/backend_config_contract/backend_sink_config.example.json`

注意：`backend_capability_matrix.example.json` 目前不是 runtime config。它是給後端回填欄位與 skin 設定的協定草案。

`backend_sink_config.example.json` 是後端/系統 owner 要填的 sink 契約模板。它回答「資料最後在哪裡、用哪個 backend、哪張 table、哪些欄位」。正式值可以複製成 `backend_sink.local.json` 或由部署系統掛載，但不要把密碼或真 token commit 進 repo。

## Stable sink rule

後端/系統填好 sink JSON 後，我們把它視為穩定接縫：

- 小可愛可以改 UI、LOD、快取、WebGL、資料集選單與皮膚設定。
- AIS crawler 可以改部署方式、重連策略、批次寫入與健康檢查。
- 只要 sink config 的既有欄位語意不變，以上改動都不應影響後端/系統載入資料。
- 如果後端/系統必須改 table 或欄位語意，請新增 `sink_ref` 或 `dataset_id`，不要原地覆寫舊契約。
- 這個規則讓「資料供給」與「前端消費」分離，避免小可愛變成上游資料流程的一部分。

## 回填協議

我們先提供 JSON shape，後端/系統可以依照自己的實際環境大致改裡面的值後回傳。

如果對方回傳的 shape 與本文件不完全一致，不視為錯誤；那代表我們目前格式還不夠清楚。下一步是根據回傳值判讀對方實際協議，整理出新的 sink config 或 capability matrix patch，再固化成下一版契約。

## 現有 runtime JSON 分層

### `connections`

描述資料庫連線。

```json
{
  "connections": {
    "local_mysql": {
      "kind": "mysql",
      "driver": "pymysql",
      "host": "127.0.0.1",
      "port": 3307,
      "user": "root",
      "password": "env:MYSQL_PASSWORD",
      "database": "common_fishery"
    },
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

### `datasets`

描述某個資料集要用哪個 backend、哪張表、哪些欄位。

```json
{
  "datasets": {
    "gfw_full": {
      "label": "GFW January 2024 grid",
      "backend": "mysql",
      "connection_ref": "local_mysql",
      "table": "gold_grid",
      "time_column": "obs_date",
      "lat_column": "lat",
      "lon_column": "lon",
      "id_column": "grid_id",
      "display_columns": ["obs_date", "grid_id", "lat", "lon", "fish_sum"],
      "metric_columns": ["fish_sum"],
      "category_columns": ["dominant_flag", "dominant_gear"]
    }
  }
}
```

### `live.ais`

描述小可愛如何讀 AIS SQL read model。

```json
{
  "live": {
    "ais": {
      "enabled": true,
      "provider": "mysql",
      "connection_ref": "local_mysql",
      "database": "BDDE38No1",
      "table": "ais_positions",
      "time_column": "event_time",
      "lat_column": "lat",
      "lon_column": "lon",
      "mmsi_column": "mmsi",
      "speed_column": "sog",
      "course_column": "cog",
      "heading_column": "heading",
      "name_column": "vessel_name",
      "source_column": "source",
      "include_sources": ["aisstream"],
      "max_age_minutes": 1440,
      "limit": "max"
    }
  }
}
```

## MySQL 到 Hive/Spark 的切換方式

現有程式已經有 backend registry：

```python
@database_backend("mysql")
class MySqlReadBackend:
    ...

@database_backend("hive")
class HiveReadBackend:
    ...

@database_backend("spark")
class SparkReadBackend:
    ...
```

MySQL 是已實作。Hive 與 Spark 是明確 unsupported stub。Spark 在這裡代表未來可能由 Spark SQL / Iceberg read model 接入的邊界，不代表目前已經完成查詢。

若要切到 Hive 或 Spark/Iceberg，後端/系統需要提供：

1. Hive/Trino 或 Spark SQL/Iceberg driver 選型。
2. connection JSON。
3. dataset table/read-model 欄位。
4. `schema_packet()` 查 schema 的實作。
5. `records_packet()` 用 date/bbox/limit/offset 查 viewport 的實作。

Runtime config 切換語意如下：

```json
{
  "datasets": {
    "gfw_full": {
      "backend": "hive",
      "connection_ref": "class_hive",
      "table": "gold_grid",
      "time_column": "obs_date",
      "lat_column": "lat",
      "lon_column": "lon",
      "id_column": "grid_id"
    }
  }
}
```

但在 `HiveReadBackend` 或 `SparkReadBackend` 實作完成前，能力矩陣必須維持：

```json
{
  "database_backend": {
    "hive": {
      "declared": true,
      "implemented": false,
      "enabled": false
    },
    "spark": {
      "declared": true,
      "implemented": false,
      "enabled": false
    }
  }
}
```

這就是能力矩陣的用途：設定可以先存在，但未完成能力不能啟用。

### 用能力矩陣切 Hive/Spark 的實際步驟

1. 後端/系統先在 `backend_sink_config.example.json` 的副本中填好 Hive 或 Spark sink，例如 `hive_class_read_model` 或 `spark_iceberg_read_model`。
2. 後端/系統回傳 dataset 欄位 patch，確認 `time_column`、`lat_column`、`lon_column`、`id_column` 與 read-model table。
3. `backend_capability_matrix.example.json` 中對應 backend 的 `implemented` 仍維持 `false`，直到 read backend 真正實作並通過測試。
4. Driver、`schema_packet()`、`records_packet()`、date/bbox/limit 查詢都通過後，才能把 `implemented` 改為 `true`。
5. 最後一關才是把 `enabled` 改為 `true`，並把 dataset 的 `sink_ref` 或 `connection_ref` 指向該 backend。

換句話說：改 JSON 只是宣告 sink，不等於啟用 Hive、Spark 或 Iceberg。是否啟用由能力矩陣決定。

## 後端需要回傳的原始欄位

後端/系統如果要修正欄位，請回傳這種 shape：

```json
{
  "schema": "rrkal.backend.dataset_contract_patch.v1",
  "dataset_id": "gfw_full",
  "connection_ref": "class_hive",
  "backend": "hive",
  "table": "gold_grid",
  "time_column": "obs_date",
  "lat_column": "lat",
  "lon_column": "lon",
  "id_column": "grid_id",
  "display_columns": [],
  "metric_columns": [],
  "category_columns": [],
  "notes": []
}
```

這份 patch 回來後，我們再決定是否合進 `config/runtime/adapter.local.json` 或新的 schema。

若欄位 patch 會改變既有 sink 語意，請不要覆寫舊 `dataset_id`。請改用新的 `dataset_id`，例如 `gfw_full_hive_v1`，讓前端和舊資料集可以並存。

## Skin/display 設定回傳

Skin 設定是「顯示語意」，不是資料庫查詢語意。它可以描述圖層顏色、alpha、label 欄位、tooltip 欄位、單位等。

目前 skin/display 設定尚未接進 runtime schema。後端可以先回傳，但能力矩陣必須不啟用。

建議回傳 shape：

```json
{
  "schema": "rrkal.backend.dataset_skin_patch.v1",
  "dataset_id": "gfw_full",
  "enabled": false,
  "layer_style": {
    "alpha": 0.58,
    "low_color": "#2d8296",
    "high_color": "#d85a30"
  },
  "tooltip_fields": [],
  "legend": {
    "title": "",
    "unit": ""
  }
}
```

原則：

- 可以先收資料。
- 可以先放進 handoff/proposed config。
- 不要直接放進 `config/examples/runtime/adapter.example.json`，除非 schema 已更新。
- 不要因為有 skin 設定就宣稱該資料集 ready。

## 能力矩陣規則

能力矩陣至少要包含：

- `declared`: 契約或欄位是否已宣告。
- `implemented`: 程式是否已實作。
- `enabled`: runtime 是否啟用。
- `owner`: 誰負責。
- `activation_gate`: 啟用前必須滿足什麼。

啟用條件：

- `declared = true`
- `implemented = true`
- `enabled = true`
- 測試與 schema 都通過

若任一項不滿足，前端或後端都不應啟用該能力。

## 不要混淆的邊界

- `connections` 決定去哪個 database backend。
- `datasets` 決定查哪張 read-model table 和欄位。
- `live.ais` 決定小可愛如何消費 AIS SQL。
- `backend_sink_config` 是後端/系統填值的穩定 sink 接縫，不是前端 UI 設定。
- 能力矩陣決定宣告能力是否能被 runtime 使用；JSON 有值不代表能力已啟用。
- AIS crawler 的 API key 不屬於後端 config patch。
- Skin/display patch 不等於 database schema。
- Hive/Spark config 存在不代表 Hive、Spark 或 Iceberg 已經可用。
