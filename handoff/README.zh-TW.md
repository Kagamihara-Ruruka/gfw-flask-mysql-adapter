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
- `common_adapter/query/registry.py`
- `config/examples/runtime/adapter.ais_collector.example.json`
- `scripts/run_ais_collector.ps1`
- `scripts/install_ais_collector_task.ps1`
- `scripts/start_ais_collector_task.ps1`
- `scripts/status_ais_collector_task.ps1`
- `scripts/stop_ais_collector_task.ps1`

不需要交付前端 UI、GFW、EEZ、Leaflet 或 WebGL 程式。

### Backend / system

目標：理解 source config、Router Manifest、Probe／Mapping 分工、MySQL 到 Hive 的能力邊界，以及未啟用的 skin/display 提案。

請閱讀：

- `handoff/backend_config_contract/README.zh-TW.md`
- `handoff/backend_config_contract/backend_sink_config.example.json`
- `handoff/backend_config_contract/backend_capability_matrix.example.json`
- `config/README.zh-TW.md`
- `config/examples/sources/database/hive.example.json`
- `config/examples/sources/database/pipeline-iceberg.example.json`
- `config/examples/state/router_manifest.example.json`

他需要關心的程式：

- `common_adapter/db/connect.py`
- `common_adapter/query/registry.py`
- `common_adapter/ais/live.py`

不需要交付 AISStream API key，也不需要直接改 crawler。

## 共同邊界

- 小可愛是 consumer，只讀已註冊的 SQL read model、HTTP serving source 與空間服務；AIS 路徑固定只讀 SQL read model。
- AIS crawler 是 upstream feeder，負責連外部 AISStream 並寫入 SQL。
- 後端/系統負責資料庫連線、欄位契約、read model 與未來 Hive/skin 能力矩陣。
- `config/examples/runtime/adapter.example.json` 只描述服務、查詢政策與渲染政策，不承載 source connection 或 dataset 欄位。
- 後端 source 應以 `config/sources/<role>/*.json` 形狀交付，再由 Router Manifest 啟用；資料欄位由 Probe／Scout 探測，Mapping 轉成內部合約。
- `config/runtime/adapter.local.json` 與 `config/runtime/ais_collector.local.json` 是本機 secrets/override，已被 `.gitignore` 忽略。
- `backend_sink.local.json` 類型的檔案目前只是交接協商產物，不是 Runtime 可直接載入的 config。確認後必須轉成 source config 與 Mapping；既有 sink 欄位語意仍不得被 UI、LOD、快取或 crawler 內部改動破壞。
- `ais_collector.handoff.example.json` 不放真 key。
- `ais_collector.handoff.json` 是授權後產生的實交接檔，可以放真 key；不要公開推到公共 repo。

## 目前保留的風險

- `hive` backend 已註冊，但目前是 explicit unsupported stub；只能作為能力矩陣與契約位置，不是可用功能。
- Skin/display 設定目前是 proposed contract，尚未接進 runtime schema；應維持 `enabled: false`。
- AIS runtime 只有 AISStream delta collector 到 SQL read model 這一條路；Kafka 等 broker 只列為未來 upstream 演進方向。
