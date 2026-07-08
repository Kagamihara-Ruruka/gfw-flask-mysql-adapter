# Upstream Handoff Index

這個目錄是給上游交接用的最小入口，不要求上游閱讀整個前端專案。

## 交接對象

### Airflow / crawler

目標：把 AISStream 資料持續送進 SQL，養出可被小可愛消費的 AIS 資料庫。

請閱讀：

- `handoff/airflow_ais_crawler/MANIFEST.zh-TW.md`
- `handoff/airflow_ais_crawler/README.zh-TW.md`
- `handoff/airflow_ais_crawler/ais_collector.handoff.example.json`
- `handoff/airflow_ais_crawler/ais_collector.handoff.json`（實交接檔，若存在則含真 AISStream API key）

他需要關心的程式：

- `core.py` 的 `ingest-ais` command
- `common_adapter/ais/ingest.py`
- `common_adapter/ais/stream.py`
- `common_adapter/ais/live.py`
- `common_adapter/db/connect.py`
- `database/registry.py`
- `config/examples/runtime/adapter.ais_collector.example.json`
- `scripts/run_ais_collector.ps1`
- `scripts/install_ais_collector_task.ps1`
- `scripts/start_ais_collector_task.ps1`
- `scripts/status_ais_collector_task.ps1`
- `scripts/stop_ais_collector_task.ps1`

不需要交付前端 UI、GFW、EEZ、Leaflet 或 WebGL 程式。

### Backend / system

目標：理解資料庫 JSON 契約、connection/dataset 欄位、MySQL 到 Hive 的能力矩陣切換方式，以及未啟用的 skin/display 設定回傳語意。

請閱讀：

- `handoff/backend_config_contract/README.zh-TW.md`
- `handoff/backend_config_contract/backend_sink_config.example.json`
- `handoff/backend_config_contract/backend_capability_matrix.example.json`
- `config/schemas/adapter.schema.json`
- `config/examples/runtime/adapter.example.json`

他需要關心的程式：

- `common_adapter/db/connect.py`
- `database/registry.py`
- `common_adapter/ais/live.py`

不需要交付 AISStream API key，也不需要直接改 crawler。

## 共同邊界

- 小可愛是 consumer，只讀 SQL/read model。
- AIS crawler 是 upstream feeder，負責連外部 AISStream 並寫入 SQL。
- 後端/系統負責資料庫連線、欄位契約、read model 與未來 Hive/skin 能力矩陣。
- `config/examples/runtime/adapter.example.json` 是模板，不放真密碼。
- `config/runtime/adapter.local.json` 與 `config/sources/websocket/ais_collector.local.json` 是本機 secrets/override，已被 `.gitignore` 忽略。
- `backend_sink.local.json` 類型的後端交付檔是穩定 sink 契約。後端/系統填好後，我們後續改小可愛 UI、LOD、快取或 crawler 內部實作，都不應改既有 sink 欄位語意。
- `ais_collector.handoff.example.json` 不放真 key。
- `ais_collector.handoff.json` 是授權後產生的實交接檔，可以放真 key；不要公開推到公共 repo。

## 目前保留的風險

- `hive` backend 已註冊，但目前是 explicit unsupported stub；只能作為能力矩陣與契約位置，不是可用功能。
- Skin/display 設定目前是 proposed contract，尚未接進 runtime schema；應維持 `enabled: false`。
- AISHub polling 是備援思路，目前 MVP 不啟用。
