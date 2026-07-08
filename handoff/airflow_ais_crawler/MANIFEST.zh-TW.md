# AIS Crawler Bundle Manifest

這份包不是只有 JSON。JSON 只是設定；真正養資料庫的 crawler 本體是 Python 程式。

## 必要程式本體

- `common_adapter/ais/ingest.py`：AISStream websocket 長駐收集器、upsert、snapshot、heartbeat 主體。
- `common_adapter/ais/stream.py`：AISStream websocket 連線、subscription message、AIS message normalize。
- `common_adapter/ais/live.py`：AIS SQL read model 與 MySQL connection helper。
- `common_adapter/db/connect.py`：config loader、MySQL connection、identifier validation。
- `database/registry.py`：backend registry，讓 config loader 能辨識 SQL backend。
- `core.py`：CLI 入口，使用 `ingest-ais` command 啟動 crawler。

## 必要設定

- `config/examples/runtime/adapter.ais_collector.example.json`：crawler 專用最小 adapter config。
- `handoff/airflow_ais_crawler/ais_collector.handoff.example.json`：不含真 key 的 handoff 模板。
- `handoff/airflow_ais_crawler/ais_collector.handoff.json`：若存在，這是實交接檔，可能含真 AISStream API key。

## Windows 本機守護腳本

- `scripts/run_ais_collector.ps1`
- `scripts/install_ais_collector_task.ps1`
- `scripts/start_ais_collector_task.ps1`
- `scripts/status_ais_collector_task.ps1`
- `scripts/stop_ais_collector_task.ps1`

## Python 依賴

- `requirements.txt`

Airflow/K8 若不跑整個 UI，仍至少需要安裝：

- `websocket-client`
- `PyMySQL`
- `cryptography`

## 啟動命令

```bash
python core.py --config config/runtime/adapter.ais_collector.local.json ingest-ais --collector-config config/sources/websocket/ais_collector.local.json
```

## 邊界

這份 bundle 是 upstream feeder，不是小可愛前端。它可以連 AISStream、寫 SQL、維護 `ais_positions`、`ais_hourly_snapshots`、`ais_ingest_meta`。小可愛只消費 SQL，不直接越界取 AISStream。
