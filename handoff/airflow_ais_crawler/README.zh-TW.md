# Airflow AIS Crawler Handoff

## 目的

這份交接只處理 AIS 上游收集器。它的任務是：

1. 使用 AISStream API key 連到 AISStream websocket。
2. 將收到的船舶位置資料寫入 SQL。
3. 維護 latest-state table，讓小可愛只消費 SQL，不直接碰 AISStream。
4. 維護 hourly snapshot table，供未來一個月歷史軌跡與時間播放器使用。

這個程式不是前端，不是渲染器，也不是資料清洗總管。

## 操作模型：射後不理

AIS crawler 的交接模型是「設定一次，長駐運作」。Airflow owner 拿到 API key、collector handoff JSON 與 SQL sink 後，應讓它自行維持 websocket、重連、寫入與健康狀態。

小可愛不應依賴 crawler process 是否由同一台機器啟動。只要 sink table 與 meta table 語意不變，小可愛就只查 SQL/read model。

## 最小檔案清單

Airflow owner 只需要看這些：

- `AisIngestService.py`
- `AisStreamProvider.py`
- `AisLiveService.py`
- `DatabaseConnect.py`
- `core.py`
- `config/adapter.ais_collector.example.json`
- `handoff/airflow_ais_crawler/ais_collector.handoff.example.json`
- `handoff/airflow_ais_crawler/ais_collector.handoff.json`（實交接檔，若存在則含真 AISStream API key）
- `scripts/run_ais_collector.ps1`
- `scripts/install_ais_collector_task.ps1`
- `scripts/start_ais_collector_task.ps1`
- `scripts/status_ais_collector_task.ps1`
- `scripts/stop_ais_collector_task.ps1`

## 啟動命令

本機直接跑：

```powershell
Copy-Item config\adapter.ais_collector.example.json config\adapter.ais_collector.local.json
Copy-Item handoff\airflow_ais_crawler\ais_collector.handoff.example.json config\ais_collector.local.json
.\.venv\Scripts\python.exe core.py --config config\adapter.ais_collector.local.json ingest-ais --collector-config config\ais_collector.local.json
```

如果交給 Airflow/K8，核心仍然是同一個 command：

```powershell
python core.py --config config/adapter.ais_collector.local.json ingest-ais --collector-config config/ais_collector.local.json
```

`config/adapter.ais_collector.example.json` 是 crawler 專用的最小 adapter config。上游應複製成 `config/adapter.ais_collector.local.json` 後填入自己的 SQL connection。

`config/ais_collector.local.json` 可以由 Airflow variable、K8 Secret 或 volume mount 產生。不要 commit。

若只拿到兩個 JSON，代表交接包拿錯了。Airflow owner 需要 crawler 本體與 runner；至少要包含 `AisIngestService.py`、`AisStreamProvider.py`、`AisLiveService.py`、`DatabaseConnect.py`、`database/registry.py`、`core.py`、`requirements.txt` 與本 README。

## API key 交付方式

Crawler handoff JSON 的 `api_key` 支援兩種模式：

```json
"api_key": "<REAL_AISSTREAM_API_KEY>"
```

或：

```json
"api_key": "env:AISSTREAM_API_KEY"
```

若使用 `env:`，執行環境必須設定該環境變數。

本 repo 交接時：

- `ais_collector.handoff.example.json` 是無密鑰模板。
- `ais_collector.handoff.json` 是實交接檔，已授權可寫入真 AISStream API key。
- Airflow/K8 owner 可以直接把實交接檔內容轉成 Airflow variable、K8 Secret 或 volume-mounted `config/ais_collector.local.json`。

注意：小可愛前端只保存 API key fingerprint。真正的 API key 屬於 crawler handoff，不屬於前端 rendering path。

## SQL sink

目前建議目標：

- database: `BDDE38No1`
- latest table: `ais_positions`
- meta table: `ais_ingest_meta`
- hourly snapshot table: `ais_hourly_snapshots`

這個 sink 是上游與小可愛之間的穩定接縫。後續即使 crawler 內部改成 Airflow、K8、systemd 或其他守護方式，只要下列 table/column 語意不變，小可愛端就不需要知道 upstream 如何運作。

Latest table 是 upsert 邏輯：

- primary key: `mmsi`
- 只保存每艘船最新一筆狀態。
- 若 incoming event_time 比既有資料舊，會跳過。
- 小可愛 live mode 查這張表。

Hourly snapshot table 是時間播放器資料：

- primary key: `(snapshot_at, mmsi)`
- `snapshot_interval_hours` 預設 1。
- `snapshot_window_hours` 預設 1。
- 對每個小時切片，保存最接近該小時邊界之前的那筆資料。
- `snapshot_retention_days` 預設 31。

Meta table 是內部憑證與健康狀態：

- service_name
- provider
- api_key_fingerprint
- collector_id
- status
- accepted_messages
- written_rows
- skipped_stale_rows
- dropped_messages
- last_error
- last_seen_at

小可愛讀 SQL 前會比對前端設定的 key fingerprint 與 meta table 的 collector fingerprint。這是內部邊界檢查，不是公開 auth 系統。

## 時間與頻率

`ingest_reconnect_seconds` 與 `ingest_status_report_seconds` 目前建議先用 30 秒。

原因：測試期間同一把 AISStream key 可能同時在本機與 Airflow/K8 端使用。不要讓兩台機器同時用過密 reconnect/status loop 打上游服務。

日後若只剩一台正式 collector，可以把 reconnect/status 改成 3 秒等更積極的值。

這不是每 30 秒拉一次資料。AISStream 是 websocket，連上後會持續收資料。這個秒數主要是 reconnect 與 status heartbeat 節流。

## Airflow 建議

這個 collector 是 long-running websocket feeder，不適合用 Airflow 每 30 秒啟一個短任務。

比較合理的方式：

- Airflow/K8 啟動一個 long-running worker。
- Airflow 只負責部署、健康檢查、重啟或排程補償任務。
- 若一定要 DAG，DAG task 應該啟動或檢查 collector，而不是每輪重建 websocket。

## Airflow owner 可以改的欄位

允許改：

- `api_key`
- `stream_url`
- `filter_message_types`
- `ingest.reconnect_seconds`
- `ingest.status_report_seconds`
- `ingest.flush_seconds`
- `ingest.batch_size`
- `ingest.snapshot_retention_days`
- `ingest.snapshot_interval_hours`
- `sql.connection.host`
- `sql.connection.port`
- `sql.connection.user`
- `sql.connection.password`
- `sql.database`
- `sql.table`

不要改：

- `schema`
- `role`
- latest table 的 primary key 語意
- 小可愛前端 config
- 前端渲染策略
- 已交付後的 sink 欄位語意；若必須改，請建立新的 table 或新的 sink_ref，而不是覆寫既有契約。

## 驗收方式

1. Collector 啟動後，SQL 應自動建立 database/table。
2. `ais_ingest_meta` 應出現 `service_name = aisstream` 的 row。
3. `accepted_messages` 應持續增加。
4. `ais_positions` 應逐步累積不同 `mmsi`。
5. `ais_hourly_snapshots` 會依時間切片逐步累積。
6. 小可愛只要查 SQL，不應直接連 AISStream。

## 邊界聲明

AIS crawler 是上游 feeder。它可以連外部 AISStream，可以寫 SQL，但不負責地圖顯示、LOD、EEZ、GFW 或 NASA。小可愛是 consumer，只查 SQL/read model。
