# 目前狀態（2026-07-21）

本檔只保留短版 checkpoint，避免與完整交接文件重複後再次漂移。

- Release：`0.10.0`
- 主要資料路徑：Flask -> PyHive -> Spark Thrift `dtadm:10000` -> `lake.ocean.gold_map_metric`
- UI/API Deployment：namespace `dt`、Service `bdde-flask-service`、NodePort `32080`
- SST：`taiwan` / `northwest_pacific`，4 / 16 / 32 km
- Python tests：2026-07-21 為 55/55 passing
- Node contract tests：合併前須在 Node.js build/CI 環境執行
- 主要風險：mutable `:dev` image、外部 Thrift lifecycle、單 replica、process-local cache

完整狀態、Spark Thrift runbook、NodePort tunnel、合併契約、驗收與 rollback：

- [`../HANDOFF.zh-TW.md`](../HANDOFF.zh-TW.md)
- [`../HANDOFF.md`](../HANDOFF.md)

本目錄其餘文件屬 AIS/backend 等專項 annex，不是目前 release 的唯一 source of truth。
