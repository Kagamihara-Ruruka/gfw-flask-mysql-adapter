# RRK Common Adapter

目前版本：`0.10.0`

English: [README.md](README.md)

下游交接：[HANDOFF.zh-TW.md](HANDOFF.zh-TW.md) / [HANDOFF.md](HANDOFF.md)

RRK Common Adapter 是 Flask Web 應用，將已設定的 SQL 資料來源轉成地圖、時間軸、圖表、表格與即時 AIS 功能。目前叢集主路徑透過 Spark Thrift/PyHive 讀取 Iceberg Gold 資料，並由單一 Kubernetes Pod 提供瀏覽器 UI 與 JSON API。

本 README 只描述 repo 內 `0.10.0` 的實際程式與部署檔。歷史版本、設計證據與專項交接放在 `docs/`、`benchmarks/`、`handoff/`，避免主 README 再度變成版本日誌而漂移。

## 目前可用能力

- 透過 Spark Thrift/PyHive 讀取 `lake.ocean.gold_map_metric`。
- SST 地圖支援 `taiwan`、`northwest_pacific` AOI 與 4、16、32 km 解析度。
- Viewport bounds 會下推成 global grid index 條件；大範圍若超出列數預算，可退回完整的較粗格網，而不是截斷細格網。
- Snapshot identity 包含 dataset、日期、AOI、解析度與 bbox；叢集 manifest 的程序級 row budget 為 800,000。
- 單一 Flask app 提供主 UI、dataset API、Spark 相容 API、EEZ overlay、render capability 與可選 AIS route。
- 前端已有 Leaflet/WebGL、播放排程與預熱、widgets、地圖匯出、telemetry 與 developer config UI。
- MySQL、PostGIS/EEZ、AISStream ingest、DuckDB-to-MySQL import 仍保留，但 `0.10.0` SST 叢集 manifest 未啟用它們。
- Kubernetes 部署檔為 `deploy/kubernetes/bdde-flask-0.10.0.yaml`；namespace `dt`，NodePort `32080`。

## Runtime 結構

```text
Browser
  -> Flask / NodePort 32080
     -> runtime + source + mapping 組合設定
     -> PyHive
        -> Spark Thrift Server :10000
           -> Spark 3.5.8 on YARN
              -> Iceberg Hadoop catalog `lake`
                 -> hdfs:///dataset/ocean/warehouse
```

Kubernetes ConfigMap 內有四份設定：

- `adapter.local.json`：server、query、rendering、cache policy。
- `spark_thrift.local.json`：PyHive connection 與 Gold table defaults。
- `router_manifest.local.json`：啟用與鎖定的 source。
- `layer_mappings.local.json`：dataset/layer roles、AOI、格網幾何、解析度、cache identity、色階。

Init container 會把唯讀 ConfigMap volume 複製到可寫的 `emptyDir`，再掛載為 `/app/config`。在 runtime config 尚未完全唯讀化前，不要移除這一步。

## Repo 導覽

| 路徑 | 責任 |
| --- | --- |
| `adapter.py`, `core.py` | CLI 入口與 commands |
| `common_adapter/config/` | Canonical config layout 與組合 |
| `common_adapter/db/` | MySQL、Hive/PyHive、Spark helper、connection lifecycle |
| `common_adapter/query/`, `endpoint/` | Dataset contract、sampled grid、registry、cache identity |
| `common_adapter/http/` | Flask app factory、routes、server lifecycle |
| `common_adapter/spatial/` | EEZ/PostGIS bootstrap、LOD、overlay、tile cache |
| `common_adapter/ais/`, `collectors/` | AIS read model 與 upstream ingest |
| `static/`, `templates/` | Browser application |
| `config/examples/` | 可提交範例，不含正式憑證 |
| `deploy/kubernetes/` | 版本化叢集 manifest |
| `tests/` | Python 與 Node contract tests |
| `docs/`, `benchmarks/`, `handoff/` | 深入設計、證據與專項交接 |

## 需求

- Python 3.10+（image 使用 3.10；目前 Python suite 也可在 3.12 通過）
- `requirements.txt` 內套件
- 執行前端 contract tests 時需要 Node.js
- 目前叢集路徑：Pod 必須能連到設定的 Spark Thrift host/port
- 依功能選用：MySQL 8.4、PostGIS 16、AISStream credentials

## 本機啟動

先從範例建立 local runtime config；不要提交 local 檔。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

New-Item -ItemType Directory -Force config\runtime | Out-Null
Copy-Item config\examples\runtime\adapter.example.json config\runtime\adapter.local.json
python adapter.py --config config\runtime\adapter.local.json serve
```

預設範例的主 UI 是 `http://127.0.0.1:5057`，developer UI 是 `5058`。叢集單程序模式使用 `--no-developer-server`。

可用命令：

```text
python core.py [--config PATH] serve [--host HOST] [--port PORT] [--developer-port PORT] [--no-developer-server]
python core.py [--config PATH] check-dependencies
python core.py [--config PATH] bootstrap-eez
python core.py [--config PATH] import --source FILE --dataset ID [--replace]
python core.py [--config PATH] ingest-ais [--collector-config FILE]
```

## 叢集部署

Repo 內 manifest 假設叢集已提供：

- namespace `dt`
- registry `dkreg.taroko:5000` 與 imagePullSecret `dkreg`
- node label `dt=worker`
- runtime class `gvisor`
- Spark Thrift hostname `dtadm`、port `10000`、user `bigred`、auth `NONE`
- 可連線的 worker node 上可使用 NodePort `32080`

```bash
docker build -t dkreg.taroko:5000/bdde-flask:dev .
docker push dkreg.taroko:5000/bdde-flask:dev
kubectl apply -f deploy/kubernetes/bdde-flask-0.10.0.yaml
kubectl -n dt rollout status deployment/bdde-flask
kubectl -n dt get pod,svc,endpoints -l app=bdde-flask
```

目前 manifest 使用可變的 `:dev` image tag。合併到正式部署 repo 前，應改為 release tag 或 digest。

Windows PowerShell 經既有 jump host 連到 NodePort：

```powershell
ssh -N -o ExitOnForwardFailure=yes `
  -L 15081:172.22.128.3:32080 `
  bigred@192.168.32.200
```

接著開啟 `http://127.0.0.1:15081/`。此 tunnel 只暴露 Flask NodePort，不會暴露 Spark Thrift。

Spark Thrift 完整啟動 runbook 與下游 repo 合併契約請見 [HANDOFF.zh-TW.md](HANDOFF.zh-TW.md)。

## 主要 endpoints

| Endpoint | 用途 |
| --- | --- |
| `GET /` | Browser application |
| `GET /api/health` | Flask liveness |
| `GET /api/datasets` | Dataset 與 layer catalog |
| `GET /api/datasets/<id>/schema` | Dataset schema 與 capabilities |
| `GET /api/datasets/<id>/records` | Snapshot/viewport records |
| `GET /api/datasets/<id>/records/range` | Range records |
| `GET /api/datasets/<id>/time-series` | Time-series packet |
| `GET /api/spark/health` | Adapter version 與 Spark route health |
| `GET /api/spark/availability` | Gold availability |
| `GET /api/spark/heatmap` | Gold heatmap 相容 route |
| `GET /api/overlays/eez/...` | 可選 EEZ data 與 MVT tiles |
| `GET /api/live/ais` / `GET /ws/live/ais` | 可選 AIS snapshot/live stream |

## 驗證

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests\*.test.mjs
git diff --check
```

2026-07-21 交接 checkpoint：Python 55 項全部通過；Node suite 有 13 個檔案，也已使用 bundled Node runtime 通過。外部 Spark、HDFS、registry、Kubernetes 與 SSH 連線屬 integration checks，不會由隔離的 unit suite 證明。

## 設定與 secrets 規則

- 只提交 examples 與 schemas，不提交正式 credentials。
- Local runtime/source/state/mapping、logs、PID、下載資料與 AIS handoff secrets 已由 `.gitignore` 排除。
- `env:VARIABLE_NAME` 類型的值會從環境變數解析；secret 應由部署平台提供。
- 目前 SST manifest 有拓撲與 username，但沒有 password/API token。
- `docker-compose.yml` 是本機 MySQL/PostGIS 輔助環境，不是目前 Spark 叢集部署方式。

## 合併提示

建議採 contract-first 邊界：另一個 repo 負責 Spark/Hadoop/YARN/Iceberg 的資料生產，本 repo 負責 Flask adapter/UI。合併部署資產前，先固定 Thrift endpoint、catalog/table schema、image ownership、namespace 與 health gates。詳細 checklist、已知風險與 rollback 請見 [HANDOFF.zh-TW.md](HANDOFF.zh-TW.md)。
