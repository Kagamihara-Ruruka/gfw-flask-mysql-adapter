# RRK 0.10.0 下游交接文件

狀態日期：2026-07-21

English: [HANDOFF.md](HANDOFF.md)

Runtime 總覽：[README.zh-TW.md](README.zh-TW.md)

## 目前整合後的發表路徑

PR #4 的 Spark／PyHive、Kubernetes 與交接成果完整保留。整合分支另外加入 Docker-first 發表路徑，讓另一台 Windows 電腦能執行完整官網與 adapter，不必捨棄原本的叢集內部署。

```text
Browser -> host :5185/:5186
  -> Docker app :5085/:5086
  -> host.docker.internal:11000
  -> 經 Tailscale 互動式 Windows SSH 登入 bigred@192.168.32.201
  -> 遠端 kubectl port-forward
  -> deployment/dtadm:10000
  -> lake.ocean.gold_map_metric
```

建議使用 Tk 啟動器；CLI wrappers 與 JSON Lines controller 使用同一套狀態機：

```powershell
.\scripts\presentation\presentation-launcher.cmd
.\scripts\presentation\start-presentation.cmd
.\.venv\Scripts\python.exe .\scripts\presentation\presentationctl.py --json status
.\scripts\presentation\stop-presentation.cmd
```

Tk 可透過 Windows AskPass 提供 SSH 密碼；只有勾選「記憶密碼」時才存入 Windows Credential Manager。密碼不會進入 repo、命令列、runtime JSON 或事件 log。直接使用 CLI 時則由可見終端負責互動。啟動流程會驗證 HDFS／YARN／Iceberg、明確重用或擁有 Spark Thrift、啟動 PostGIS、執行一次性 EEZ bootstrap 與持久化 domain-tile 預熱、啟動 App，最後執行五資料集 smoke test。停止流程只清理由此 checkout 擁有的資源；正常啟動不會修改共用叢集。

Config Browser 是 Desired State 編輯器。儲存只會建立已驗證的 `pending_restart` generation；在 `presentationctl start` 受控重啟前，Query、Registry、Status、Health 與 Supervisor 都繼續使用同一份 immutable `RuntimeConfigSnapshot`。Dashboard 與 Developer 必須回報相同的 `runtime_instance_id`、generation、config bundle hash、effective backend/source 與 runtime fingerprint。Config bundle hash 只涵蓋 effective runtime config、Manifest、Mapping 與 active source documents；runtime fingerprint 再綁定 generation、公開 ports、image、Compose 與 bridge evidence。所有值都和 live deployment 一致時，smoke marker 才有效。

正式 Sea1 Gold table 已於 2026-07-22 驗證：AOI 為 `taiwan` 與 `northwest_pacific`，日期為 2022-01-01 至 2024-12-31，解析度為 4／16／32 km。`lake.ocean.gold_map_metric` 具有五項指標：葉綠素、捕魚時數、海洋生產力、海表溫度與永續壓力。HDFS、三個運作中的 YARN NodeManager，以及 port 10000 的共用 Spark Thrift 均通過預檢。除非日後完成 materialize 與驗證，Repo 不得宣稱 2020-2021 serving coverage。

下方原有的 Kubernetes ConfigMap、Deployment、NodePort Service 與 registry 流程仍是有效交接資產，不會被發表用 Compose 刪除或取代。

## 1. 交接摘要

此 repo 已可作為大型叢集系統中的 Flask adapter 與 browser application 端交接。PR #4 保留的原始叢集內路徑為：

```text
HDFS 上的 Iceberg Gold table
  <- Spark 3.5.8 / YARN / Iceberg Hadoop catalog
  <- dtadm:10000 的 Spark Thrift Server
  <- bdde-flask Pod 內的 PyHive
  <- Flask dataset APIs 與 browser UI
  <- NodePort 32080
```

`0.10.0` 仍是從 PR #4 吸收的後端 checkpoint。正式 Sea1 發表資料由 `lake.ocean.gold_map_metric` 提供五項 sampled-grid 指標，使用 `taiwan` 與 `northwest_pacific` AOI，日期涵蓋 2022-01-01 至 2024-12-31，並支援 4／16／32 km 解析度。上游儲存使用年月分區 Parquet，Gold 按月建立。Browser runtime 與部署 manifests 在本 repo；Iceberg Gold table 生產，以及 Spark／Hadoop／YARN 生命週期屬 upstream。

與另一個 repo 合併時，建議做「契約與部署整合」，不要直接把兩棵 source tree 無條件覆蓋。請保留第 4 節責任邊界，並以第 11 節作為 release gates。

## 2. 目前 checkpoint

| 項目 | 目前值 |
| --- | --- |
| Application version | `0.10.0`（`common_adapter/__init__.py`） |
| Git checkpoint | 本次 handoff commit 前為 tag `v0.10.0`、branch `codex/rrk-0.10.0` |
| 發表用 Python image | `python:3.11-slim` |
| Spark | `3.5.8-bin-hadoop3` |
| Hadoop | `3.5.0` |
| SQL transport | PyHive over HiveServer2 protocol |
| 發表用 Thrift endpoint | `host.docker.internal:11000`，轉送至 `dtadm:10000`；`auth=NONE`、user `bigred` |
| Iceberg catalog | `lake`，Hadoop catalog |
| Warehouse | `hdfs:///dataset/ocean/warehouse` |
| 主要 table | `lake.ocean.gold_map_metric` |
| Kubernetes namespace | `dt` |
| 發表用 host listeners | `5185` 官網／消費端／API，`5186` 開發者控制面 |
| 發表用 container listeners | `5085` 官網／消費端／API，`5086` 開發者控制面 |
| 保留的 Kubernetes Service | `bdde-flask-service`，NodePort `32080` |
| Container registry | `dkreg.taroko:5000` |
| 目前 image | `dkreg.taroko:5000/bdde-flask:dev` |
| Runtime class / node selector | `gvisor` / `dt=worker` |

本次驗證：

- Python：191/191 通過，另有 43 個 subtests。
- Node：使用 bundled Node runtime 執行 28 個 `*.test.mjs` files，294/294 通過。
- Presentation/controller/launcher/runtime/server 子集 40/40 通過；EEZ/registry/status/developer 子集 33/33 通過。
- 所有 Presentation PowerShell scripts 皆可解析，`docker compose -f compose.presentation.yaml config --quiet` 通過，controller contract 與 dry-run 亦通過。
- Release gate 仍包含 `git diff --check`。
- 2026-07-21 live 驗證已確認 HDFS、三個 YARN workers、Spark Thrift、Iceberg table，以及 Docker／PyHive 路徑上的五項發表指標。
- 2026-07-22 的唯讀 status 檢查正確拒絕舊 Compose instance：它仍使用 schema-v1 smoke marker，且缺少目前的 runtime identity 與持久化 EEZ prewarm evidence。HTTP 可回應不等於發表環境已 ready。

## 3. 已完成能力

### 叢集關鍵路徑

- 由 runtime、source、router manifest、layer mapping 組合設定。
- Hive/PyHive backend：connection reuse、每次 query 建 cursor、序列化共用連線、transport failure 時重連一次。
- Sampled-grid contract，將 Gold rows 轉成 canonical browser packet。
- Viewport bbox 下推成 grid-index 條件。
- AOI 與解析度切換，以及保留完整格網的 LOD fallback。
- 依 mapping semantics 做 namespace 的 snapshot cache，並有程序級 row budget。
- Flask health、catalog、schema、records、range、time-series 與 Spark 相容 routes。
- Leaflet/WebGL、playback/cache/preheat、widgets、telemetry、developer UI。
- 版本化 Kubernetes ConfigMap、Deployment、NodePort Service。

### 依 Profile 決定的能力

- MySQL datasets 與 DuckDB-to-MySQL import。
- 發表用 Compose 必須具備 PostGIS EEZ bootstrap、attribution、vector tiles 與持久化 domain-tile 預熱。
- AISStream-to-SQL collector 與 SQL/WebSocket live read path。
- 作為備援位置的 AISHub settings route。

保留的 `bdde-flask-0.10.0.yaml` 關閉 AIS，也沒有設定 PostGIS；發表用 Compose 則會設定 PostGIS 並獨立驗證 EEZ readiness。不可把某個 Profile 的能力宣告套到另一個 Profile。

## 4. 與另一個 repo 合併時的責任邊界

### 本 repo 應負責

- Flask app、browser UI、adapter APIs。
- Dataset/layer mapping contract 與 canonical response packet。
- PyHive client、request validation、cache identity、rendering behavior。
- Adapter container image build。
- Adapter Deployment/Service/ConfigMap；若部署 repo 接管，必須明確指定 owner。
- Adapter unit/contract tests 與 health endpoints。

### 另一個/upstream repo 應負責

- Source ingestion 與 Iceberg Bronze/Silver/Gold tables 維護。
- Spark、Hadoop、YARN、HDFS、Iceberg platform lifecycle。
- Spark Thrift Server lifecycle、hostname、firewall/network policy、capacity。
- Gold schema quality、partitions、date/AOI coverage、data SLA。
- Shared cluster secrets、registry credentials、namespace、observability platform。

### 必須凍結的共同契約

1. Flask Pod 可連線的 Thrift hostname 與 port。
2. Authentication mode 與 user identity。
3. Iceberg catalog 與完整 table names。
4. Gold 欄位與語意：`event_date`、`grid_id`、`grid_row`、`grid_col`、`resolution_km`、`metric_value`、`display_level`、`data_coverage`。
5. Global-grid geometry：origin `(90, -180)`、每度 24 index units、base resolution 4 km。
6. AOI IDs 與 bounds。
7. 可用解析度與完整 viewport 最大 row count。
8. Date range 與 missing-partition behavior。
9. Health/readiness gates 與 rollback owner。

Upstream table 若變更，先更新 mapping contract 與 tests，不要在前端偷偷補 schema mismatch。

## 5. 設定組合方式

Cluster manifest 在同一個 ConfigMap 內嵌四份 JSON。Init container 會產生：

```text
/app/config/runtime/adapter.local.json
/app/config/sources/database/spark_thrift.local.json
/app/config/state/router_manifest.local.json
/app/config/artifacts/layer_mappings.local.json
```

`router_manifest.local.json` 啟用 database source；`layer_mappings.local.json` 將 source columns 綁定 canonical roles，並匯入 `ocean_sst` layer。由於 developer/runtime config services 可能需要可寫目錄，ConfigMap 會先複製到 `emptyDir`；直接把 ConfigMap 掛到 `/app/config` 會改變行為。

可提交 examples 在 `config/examples/`。`.local.json` 類型 local 檔已忽略。Secrets 應使用環境變數與 Kubernetes Secrets，不得寫入版控 ConfigMap。

## 6. Spark Thrift Server runbook

以下為目前環境提供的交接命令。請在 Spark/Hadoop 主機上以預期 service user 執行。它會用 YARN client deploy mode 啟動 Spark Thrift、使用暫存 Derby metastore，並設定 `lake` Hadoop catalog。

```bash
export SPARK_HOME=/opt/zfs/sys/spark-3.5.8-bin-hadoop3
export HADOOP_HOME=/opt/zfs/sys/hadoop-3.5.0
export HADOOP_CONF_DIR=/opt/zfs/sys/hadoop-3.5.0/etc/hadoop
export YARN_CONF_DIR=/opt/zfs/sys/hadoop-3.5.0/etc/hadoop
export PATH="$SPARK_HOME/bin:$SPARK_HOME/sbin:$HADOOP_HOME/bin:$PATH"

THRIFT_METASTORE_DIR="/tmp/metastore_db_${USER}*thrift*$(date +%s%N)_$$"
LAUNCH_LOG="/tmp/spark-thrift-launch.log"

if ss -lnt | grep -q ':10000 '; then
  echo "10000 already listening; skip start"
  ss -lnt | grep ':10000 '
else
  echo "Starting Spark Thrift Server"
  echo "Derby metastore: $THRIFT_METASTORE_DIR"

  start-thriftserver.sh \
    --master yarn \
    --deploy-mode client \
    --conf spark.submit.deployMode=client \
    --conf spark.hadoop.javax.jdo.option.ConnectionURL="jdbc:derby:;databaseName=${THRIFT_METASTORE_DIR};create=true" \
    --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions \
    --conf spark.sql.catalog.lake=org.apache.iceberg.spark.SparkCatalog \
    --conf spark.sql.catalog.lake.type=hadoop \
    --conf spark.sql.catalog.lake.warehouse=hdfs:///dataset/ocean/warehouse \
    --conf spark.sql.iceberg.locality.enabled=false \
    --hiveconf hive.server2.thrift.bind.host=0.0.0.0 \
    --hiveconf hive.server2.thrift.port=10000 \
    >"$LAUNCH_LOG" 2>&1

  READY=0
  for i in $(seq 1 30); do
    if ss -lnt | grep -q ':10000 '; then
      READY=1
      break
    fi
    echo "waiting for port 10000... ${i}/30"
    sleep 2
  done

  if [ "$READY" -eq 1 ]; then
    PID=$(pgrep -f 'org.apache.spark.sql.hive.thriftserver.HiveThriftServer2' | head -1)
    echo "Spark Thrift Server ready, PID=$PID"
    ss -lnt | grep ':10000 '
  else
    echo "Spark Thrift Server failed to listen on port 10000"
    echo "=== launch log ==="
    cat "$LAUNCH_LOG"
    SERVER_LOG=$(ls -1t /tmp/spark-${USER}-org.apache.spark.sql.hive.thriftserver.HiveThriftServer2-*.out 2>/dev/null | head -1)
    if [ -n "$SERVER_LOG" ]; then
      echo "=== server log: $SERVER_LOG ==="
      tail -n 100 "$SERVER_LOG"
    fi
    exit 1
  fi
fi
```

操作注意：

- Port 10000 有 listener 只是 socket check；必須確認 PID 是 `HiveThriftServer2`，並實際執行 query 才算 ready。
- Derby metastore 是暫存路徑，原命名含 literal `*`。只有在目標檔案系統已驗證時才照用；未來 service wrapper 建議改成底線。
- `--deploy-mode client` 代表 launcher host/process 仍是操作上的關鍵元件。
- Hadoop catalog 直接指向 HDFS warehouse；service user 的 Hadoop config 與 HDFS 權限必須正確。
- Capacity、YARN application state、server logs 需由本 repo 以外的監控負責。

有 Beeline 的主機可做 bounded query：

```bash
beeline -u 'jdbc:hive2://dtadm:10000/default' -n bigred \
  -e "SELECT COUNT(*) FROM lake.ocean.gold_map_metric WHERE event_date = DATE '2024-01-01'"
```

若叢集 Spark SQL 不接受此 date literal，改用該環境已驗證語法；重點是證明 catalog access 與 bounded Gold query。

## 7. Build 與 Kubernetes deploy

```bash
docker build -t dkreg.taroko:5000/bdde-flask:dev .
docker push dkreg.taroko:5000/bdde-flask:dev
kubectl apply -f deploy/kubernetes/bdde-flask-0.10.0.yaml
kubectl -n dt rollout status deployment/bdde-flask
kubectl -n dt get pods,svc,endpoints -l app=bdde-flask -o wide
kubectl -n dt logs deployment/bdde-flask -c prepare-config
kubectl -n dt logs deployment/bdde-flask -c bdde-flask --tail=200
```

Readiness 預期：

- Liveness：`GET /api/health`。
- Readiness：Python probe 呼叫 `GET /api/datasets`，要求 `datasets` 與 `layers` 非空。
- Service 無 endpoints 代表 Pod 未 Ready，或 labels/selectors 不一致。
- `ErrImagePull` 應先修 registry/imagePullSecret/image 是否存在，再查應用程式。

正式環境前，將 `:dev` 改成 immutable tag/digest，並在部署 repo 記錄 exact image。

## 8. 本機 NodePort 存取

Windows PowerShell：

```powershell
ssh -N -o ExitOnForwardFailure=yes `
  -L 15081:172.22.128.3:32080 `
  bigred@192.168.32.201
```

保持該 terminal 開啟，再驗證：

```powershell
Invoke-RestMethod http://127.0.0.1:15081/api/health
Invoke-RestMethod http://127.0.0.1:15081/api/spark/health
Invoke-RestMethod http://127.0.0.1:15081/api/datasets
```

UI 為 `http://127.0.0.1:15081/`。SSH 成功但 HTTP 失敗時，先查 Service endpoints 與 Pod logs，不要先改 tunnel。

## 9. Tests 與驗收

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests\*.test.mjs
python scripts\presentation\presentationctl.py --json contract
python scripts\presentation\presentationctl.py --json start --dry-run
docker compose -f compose.presentation.yaml config --quiet
git diff --check
```

部署後 smoke：

```powershell
python scripts\demo_smoke.py --base-url http://127.0.0.1:15081
python scripts\endpoint_probe_smoke.py
python scripts\playback_contract_smoke.py
```

`endpoint_probe_smoke.py` 使用本機 fixtures，不連部署 base URL；`playback_contract_smoke.py` 只包裝一個 Node contract test，且需要 `node` 在 `PATH`。Argparse 類型 scripts 可先用 `python script.py --help` 確認參數；scripts 可能獨立演進。

驗收至少包含：兩個 AOI、三種解析度、兩個日期、viewport 移動、playback、cache reuse，以及 Thrift 已啟動時的 cold Pod start。

## 10. 已知風險與非目標

| 風險 | 影響 / 行動 |
| --- | --- |
| 可變 `:dev` image | Pod restart 可能跑到不同程式；固定 tag/digest。 |
| Thrift 不在 K8s manifest | Container 可活著但 query 不通；建立有 owner 的 service/runbook/alert。 |
| Thrift 只做 socket readiness | 其他程序可能占用 10000；驗證 process 與 query。 |
| `auth=NONE` 與 topology 在 ConfigMap | 僅能用於可信網路；需要時移到平台政策。 |
| 4 km 大範圍 | 約可到 400k rows；驗證 driver/server memory 與 latency。 |
| Process-local snapshot cache | Restart 會遺失，多 replicas 不共享。 |
| 單 replica | Adapter 無 HA；production 前評估。 |
| EEZ/AIS optional code | 不代表依賴已部署或資料新鮮。 |
| 舊版發表用 instance | 即使 HTTP 可回應，schema-v1 smoke marker 或缺少 runtime identity/prewarm evidence 都不可接受；必須用目前啟動器受控重啟並重跑 smoke。 |
| Local compose passwords/Windows path | 僅供開發，不得直接帶入叢集。 |
| 歷史 manifests | 除非重現舊版，部署只用 0.10.0。 |

本次不包含：provision HDFS/YARN、產生 Gold table、建立 registry credentials、決定 production ingress/TLS、核定 EEZ attribution 法律意義。

## 11. 合併與發佈 checklist

### Merge 前

- [ ] 決定最終 Kubernetes manifests 由哪個 repo 管理。
- [ ] 確認 Pod DNS/routing 可到 `dtadm:10000`。
- [ ] 凍結 Gold schema、partitions、date range、AOIs、resolution contract。
- [ ] 將 mutable image tag 換成 immutable release reference。
- [ ] 確認 `dkreg`、namespace `dt`、`gvisor`、`dt=worker` 存在。
- [ ] 確認 staging 無 local `.local.json`、API key、password、logs、data、PID。
- [ ] 執行 Python 與 Node suites。
- [ ] 將兩份新 architecture/presentation docs 視為證據，不視為 runtime contract。

### Deploy gate

- [ ] Thrift process 與 bounded Gold query 成功。
- [ ] Image pull 成功。
- [ ] Deployment rollout 完成，Service 有 endpoints。
- [ ] NodePort 上 `/api/health`、`/api/spark/health`、`/api/datasets` 成功。
- [ ] Dashboard 與 Developer 回報相同的 runtime instance、generation、fingerprint、effective backend 與 config bundle hash。
- [ ] Smoke evidence 與目前 image、Compose file、config bundle、bridge owner、deployment generation、持久化 EEZ prewarm manifest 完全一致。
- [ ] UI 對兩個 AOI、三種解析度皆可畫 SST。
- [ ] Playback/cache smoke 通過。
- [ ] Logs 無持續 reconnect、OOM、query-resource failure。

### Rollback

1. 保留前一版 immutable image 與 manifest revision。
2. 重新 apply 前版 manifest；只有 ReplicaSet history 確實對應已知 image/config pair 時才使用 `kubectl -n dt rollout undo deployment/bdde-flask`。
3. 重查 Service endpoints 與三個 health/catalog endpoints。
4. Gold schema 不可與 adapter contract 分開 rollback；兩者是同一 compatibility unit。

## 12. 下一位維護者先讀什麼

依序閱讀：

1. `README.zh-TW.md` 或 `README.md`。
2. `deploy/kubernetes/bdde-flask-0.10.0.yaml`。
3. `common_adapter/http/interface.py` 與 `common_adapter/http/routes/`。
4. `common_adapter/db/backends/hive.py`、`common_adapter/db/spark_thrift.py`。
5. `common_adapter/endpoint/runtime.py`、`common_adapter/query/sampled_grid.py`、`common_adapter/query/snapshot_cache.py`。
6. `static/js/runtime/runtime-composition-root.js`、`static/js/services/`、`static/js/playback/`。
7. `tests/test_hive_sampled_grid_backend.py`、`tests/test_spark_thrift_connection.py` 與 Node contract tests。
8. `docs/RRK_ARCHITECTURE_TECHNICAL_DOCUMENT.zh-TW.md` 的深入歷史與 evidence。

`handoff/` 內仍保留 AIS/backend 專項文件；它們是 annex，不是目前叢集 release 的 source of truth。
