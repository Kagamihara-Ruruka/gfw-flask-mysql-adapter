# 專項交接索引

目前 release 的完整交接 source of truth 位於 repo 根目錄：

- 中文：[`HANDOFF.zh-TW.md`](../HANDOFF.zh-TW.md)
- English：[`HANDOFF.md`](../HANDOFF.md)
- Runtime 中文總覽：[`README.zh-TW.md`](../README.zh-TW.md)
- Runtime English overview：[`README.md`](../README.md)

本目錄保留專項 annex；它們不取代根目錄的 release handoff。

## Airflow / AIS crawler annex

- `airflow_ais_crawler/MANIFEST.zh-TW.md`
- `airflow_ais_crawler/README.zh-TW.md`
- `airflow_ais_crawler/ais_collector.handoff.example.json`

用途是將 AISStream 資料持續送入 SQL，再由 adapter 的 AIS read path 消費。含真實 API key 的 `ais_collector.handoff.json` 已由 `.gitignore` 排除，不得推到 GitHub。

## Backend config contract annex

- `backend_config_contract/README.zh-TW.md`
- `backend_config_contract/backend_sink_config.example.json`
- `backend_config_contract/backend_capability_matrix.example.json`
- `../config/schemas/adapter.schema.json`

用途是說明 connection、dataset、mapping 與能力矩陣契約。舊文件若描述 Hive 為 unsupported，請以 `0.10.0` 程式與根目錄 handoff 為準：目前 Spark Thrift/PyHive 已是可用的叢集主路徑。

## 安全邊界

- 只提交 examples/schemas，不提交 local credentials。
- `config/**/*.local.json`、logs、PID、data、AIS secret handoff 都不得進版控。
- SST 叢集 manifest 未啟用 AIS 或 PostGIS；程式存在不代表外部服務已部署。
