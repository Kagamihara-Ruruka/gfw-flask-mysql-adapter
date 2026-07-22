# RRK 0.10.0 Downstream Handoff

Status date: 2026-07-21

Companion translation: [HANDOFF.zh-TW.md](HANDOFF.zh-TW.md)

Runtime overview: [README.md](README.md)

## Current integrated presentation path

PR #4's Spark/PyHive, Kubernetes, and handoff work is retained. The integration branch adds a Docker-first presentation path so a second Windows machine can run the complete website and adapter without discarding the original in-cluster deployment.

```text
Browser -> host :5185/:5186
  -> Docker app :5085/:5086
  -> host.docker.internal:11000
  -> interactive Windows SSH to bigred@192.168.32.201 over Tailscale
  -> remote kubectl port-forward
  -> deployment/dtadm:10000
  -> lake.ocean.gold_map_metric
```

The recommended operator entrypoint is the Tk launcher. The CLI wrappers and
JSON-lines controller invoke the same state machine:

```powershell
.\scripts\presentation\presentation-launcher.cmd
.\scripts\presentation\start-presentation.cmd
.\.venv\Scripts\python.exe .\scripts\presentation\presentationctl.py --json status
.\scripts\presentation\stop-presentation.cmd
```

The launcher can supply SSH through Windows AskPass and optionally store the
credential in Windows Credential Manager. The password never enters the repo,
command line, runtime JSON, or event log. Direct CLI fallback uses a visible
terminal. Startup validates HDFS/YARN/Iceberg, reuses or owns Spark Thrift
explicitly, starts PostGIS, runs the one-shot EEZ bootstrap and persistent
domain-tile prewarm, starts the app, and runs the five-dataset smoke test.
Stop removes only resources owned by this checkout. Shared-cluster mutation is
not part of normal startup.

The Config Browser is a desired-state editor. A save creates a validated
`pending_restart` generation; Query, Registry, Status, Health, and Supervisor
continue using one immutable `RuntimeConfigSnapshot` until
`presentationctl start` applies the generation through a controlled restart.
The Dashboard and Developer surfaces expose the same `runtime_instance_id`,
generation, config-bundle hash, effective backend/source, and runtime
fingerprint. The config-bundle hash covers only the effective runtime config,
Manifest, Mapping, and active source documents. The runtime fingerprint also
binds generation, public ports, image, Compose, and bridge evidence. A smoke
marker is accepted only when all of those values match the live deployment.

The formal Sea1 Gold table was verified on 2026-07-22 for `taiwan` and `northwest_pacific`, from 2022-01-01 through 2024-12-31, at 4/16/32 km. All five metrics exist in `lake.ocean.gold_map_metric`: chlorophyll, fishing hours, ocean productivity, sea temperature, and sustainability pressure. HDFS, YARN with three running NodeManagers, and the shared Spark Thrift service on port 10000 passed the cluster preflight. The repository must not claim 2020-2021 serving coverage unless those years are later materialized and verified.

The Kubernetes ConfigMap, Deployment, NodePort Service, and registry workflow described below remain valid handoff assets. They are not deleted or replaced by the presentation Compose path.

## 1. Executive summary

This repository is ready to hand off as the Flask adapter and browser-application side of a larger cluster system. The original in-cluster path retained from PR #4 is:

```text
Iceberg Gold table on HDFS
  <- Spark 3.5.8 / YARN / Iceberg Hadoop catalog
  <- Spark Thrift Server on dtadm:10000
  <- PyHive inside bdde-flask Pod
  <- Flask dataset APIs and browser UI
  <- NodePort 32080
```

Release `0.10.0` remains the backend checkpoint absorbed from PR #4. The formal Sea1 presentation table exposes five sampled-grid metrics from `lake.ocean.gold_map_metric`, uses the `taiwan` and `northwest_pacific` AOIs, covers 2022-01-01 through 2024-12-31, and supports 4/16/32 km resolutions. Upstream storage is monthly Parquet and Gold is built in monthly batches. The browser-facing runtime and deployment manifests are in this repo; production of the Iceberg Gold table and lifecycle of Spark/Hadoop/YARN belong upstream.

The recommended merger with the other repository is a contract and deployment merge, not a blind source-tree overlay. Preserve the ownership boundaries in section 4 and use the gates in section 11.

## 2. Current checkpoint

| Item | Current value |
| --- | --- |
| Application version | `0.10.0` (`common_adapter/__init__.py`) |
| Git checkpoint | tag `v0.10.0`, branch `codex/rrk-0.10.0` before this handoff commit |
| Presentation Python image | `python:3.11-slim` |
| Spark | `3.5.8-bin-hadoop3` |
| Hadoop | `3.5.0` |
| SQL transport | PyHive over HiveServer2 protocol |
| Presentation Thrift endpoint | `host.docker.internal:11000`, forwarded to `dtadm:10000`; `auth=NONE`, user `bigred` |
| Iceberg catalog | `lake`, Hadoop catalog |
| Warehouse | `hdfs:///dataset/ocean/warehouse` |
| Primary table | `lake.ocean.gold_map_metric` |
| Kubernetes namespace | `dt` |
| Presentation host listeners | `5185` consumer/site/API and `5186` developer control plane |
| Presentation container listeners | `5085` consumer/site/API and `5086` developer control plane |
| Retained Kubernetes Service | `bdde-flask-service`, NodePort `32080` |
| Container registry | `dkreg.taroko:5000` |
| Current image reference | `dkreg.taroko:5000/bdde-flask:dev` |
| Runtime class / node selector | `gvisor` / `dt=worker` |

Validation at handoff:

- Python: 191/191 tests pass, plus 43 subtests.
- Node: 294/294 tests pass across 28 `*.test.mjs` files with the bundled Node runtime.
- The presentation/controller/launcher/runtime/server subset passes 40/40; the EEZ/registry/status/developer subset passes 33/33.
- All Presentation PowerShell scripts parse, `docker compose -f compose.presentation.yaml config --quiet` passes, and controller contract/dry-run checks pass.
- `git diff --check` remains part of the release gate.
- Live validation on 2026-07-21 confirmed HDFS, three YARN workers, Spark Thrift, the Iceberg table, and all five presentation metrics through Docker/PyHive.
- A read-only status check on 2026-07-22 correctly rejected the older live Compose instance: it still had a schema-v1 smoke marker and lacked the current runtime identity and persistent EEZ prewarm evidence. HTTP availability alone is not Presentation readiness.

## 3. What is implemented

### Cluster-critical path

- Config assembly from runtime, source, router manifest, and layer-mapping documents.
- Hive/PyHive backend with connection reuse, per-query cursor creation, serialized access, and one reconnect on transport failure.
- Sampled-grid contract and conversion of Gold rows into canonical browser packets.
- Bbox-to-grid-index predicate pushdown for viewport queries.
- AOI and resolution selection with complete-grid LOD fallback.
- Snapshot cache namespaced by mapping semantics and bounded by a global row budget.
- Flask health, catalog, schema, records, range, time-series, and Spark compatibility routes.
- Leaflet/WebGL map rendering, playback/cache/preheat lifecycle, widgets, telemetry, and developer UI.
- Versioned Kubernetes ConfigMap, Deployment, and NodePort Service.

### Profile-dependent capabilities

- MySQL datasets and DuckDB-to-MySQL import.
- PostGIS-backed EEZ bootstrap, attribution, vector tiles, and persistent
  domain-tile prewarm are required by the Presentation Compose profile.
- AISStream-to-SQL collector and SQL/WebSocket live read path.
- AISHub settings route as a reserved fallback.

The retained `bdde-flask-0.10.0.yaml` disables AIS and does not configure
PostGIS. The Presentation Compose profile does configure PostGIS and proves EEZ
readiness separately. Do not transfer capability claims between profiles.

## 4. Ownership boundary for the repository merge

### This repository should own

- Flask app, browser UI, and adapter APIs.
- Dataset/layer mapping contract and canonical response packet.
- PyHive client behavior, request validation, cache identity, and rendering behavior.
- Adapter container image build.
- Adapter Deployment/Service/ConfigMap unless the deployment repo takes explicit ownership.
- Adapter unit/contract tests and health endpoints.

### The other/upstream repository should own

- Source ingestion and creation/maintenance of Iceberg Bronze/Silver/Gold tables.
- Spark, Hadoop, YARN, HDFS, and Iceberg platform lifecycle.
- Spark Thrift Server lifecycle, host naming, firewall/network policy, and capacity.
- Gold schema quality, partitions, date coverage, AOI coverage, and data SLAs.
- Shared cluster secrets, registry credentials, namespaces, and observability platform.

### Shared contract that must be frozen

1. Reachable Thrift hostname and port from the Flask Pod.
2. Authentication mode and user identity.
3. Iceberg catalog and fully qualified table names.
4. Gold columns and semantics:
   `event_date`, `grid_id`, `grid_row`, `grid_col`, `resolution_km`, `metric_value`, `display_level`, `data_coverage`.
5. Global-grid geometry: origin `(90, -180)`, 24 index units per degree, 4 km base resolution.
6. AOI identifiers and bounds.
7. Available resolutions and maximum complete viewport row count.
8. Date range and missing-partition behavior.
9. Health/readiness gates and rollback owner.

If the upstream table changes, update the mapping contract and tests first. Do not hide a schema mismatch in frontend code.

## 5. Configuration assembly

The cluster manifest embeds four JSON files in one ConfigMap. The init container materializes them as:

```text
/app/config/runtime/adapter.local.json
/app/config/sources/database/spark_thrift.local.json
/app/config/state/router_manifest.local.json
/app/config/artifacts/layer_mappings.local.json
```

`router_manifest.local.json` activates the database source. `layer_mappings.local.json` binds source columns to canonical roles and imports layer `ocean_sst`. The config files are copied to `emptyDir` because developer/runtime config services can require a writable tree; mounting the ConfigMap directly at `/app/config` changes that behavior.

Commit-safe examples are under `config/examples/`. Local files ending in `.local.json` are ignored. Secrets should use environment indirection and Kubernetes Secrets, never a checked-in ConfigMap.

## 6. Spark Thrift Server runbook

The following is the handoff command supplied for the current environment. Run it on the Spark/Hadoop host as the intended service user. It launches Spark Thrift in YARN client deploy mode, uses an ephemeral local Derby metastore, and configures the `lake` Hadoop catalog.

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

Operational cautions:

- A listener on port 10000 is only a socket check. Confirm the PID is `HiveThriftServer2` and execute a query before declaring readiness.
- The Derby metastore path is ephemeral and the supplied name contains literal `*` characters. Preserve it only if this has been verified on the target filesystem; a safer future service wrapper can use underscores.
- `--deploy-mode client` means the launcher host/process remains operationally important.
- The Hadoop catalog points directly at the HDFS warehouse; access permissions and Hadoop configs must be valid for the service user.
- Capacity, YARN application state, and server logs need monitoring outside this repository.

Suggested verification from a host with Beeline:

```bash
beeline -u 'jdbc:hive2://dtadm:10000/default' -n bigred \
  -e "SELECT COUNT(*) FROM lake.ocean.gold_map_metric WHERE event_date = DATE '2024-01-01'"
```

If the Spark SQL dialect rejects the quoted date form, use the verified literal syntax for the cluster; the purpose is to prove catalog access and one bounded Gold query.

## 7. Build and Kubernetes deploy

```bash
docker build -t dkreg.taroko:5000/bdde-flask:dev .
docker push dkreg.taroko:5000/bdde-flask:dev
kubectl apply -f deploy/kubernetes/bdde-flask-0.10.0.yaml
kubectl -n dt rollout status deployment/bdde-flask
kubectl -n dt get pods,svc,endpoints -l app=bdde-flask -o wide
kubectl -n dt logs deployment/bdde-flask -c prepare-config
kubectl -n dt logs deployment/bdde-flask -c bdde-flask --tail=200
```

Expected readiness behavior:

- Liveness: `GET /api/health`.
- Readiness: Python probe calls `GET /api/datasets` and requires non-empty `datasets` and `layers`.
- A Service without endpoints means the Pod is not Ready or labels/selectors do not match.
- `ErrImagePull` means registry/imagePullSecret/image existence must be fixed before application debugging.

Before production, change `:dev` to an immutable tag/digest and record the exact image in the deployment repo.

## 8. Local NodePort access

From Windows PowerShell:

```powershell
ssh -N -o ExitOnForwardFailure=yes `
  -L 15081:172.22.128.3:32080 `
  bigred@192.168.32.201
```

Keep that terminal open, then verify:

```powershell
Invoke-RestMethod http://127.0.0.1:15081/api/health
Invoke-RestMethod http://127.0.0.1:15081/api/spark/health
Invoke-RestMethod http://127.0.0.1:15081/api/datasets
```

Open `http://127.0.0.1:15081/` for the UI. If SSH succeeds but HTTP fails, check Service endpoints and the Pod logs before changing the tunnel.

## 9. Tests and acceptance commands

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests\*.test.mjs
python scripts\presentation\presentationctl.py --json contract
python scripts\presentation\presentationctl.py --json start --dry-run
docker compose -f compose.presentation.yaml config --quiet
git diff --check
```

Cluster smoke after deployment:

```powershell
python scripts\demo_smoke.py --base-url http://127.0.0.1:15081
python scripts\endpoint_probe_smoke.py
python scripts\playback_contract_smoke.py
```

`endpoint_probe_smoke.py` uses local fixtures rather than the deployed base URL. `playback_contract_smoke.py` wraps one Node contract test and requires `node` on `PATH`. Confirm CLI arguments for argparse-based scripts with `python script.py --help`; scripts evolve independently of this document.

Acceptance should cover both AOIs, all three resolutions, at least two dates, viewport movement, playback, cache reuse, and a cold Pod start while Thrift is already available.

## 10. Known risks and non-goals

| Risk | Impact / action |
| --- | --- |
| Mutable `:dev` image | A restart can run different code; pin tag/digest. |
| Thrift is outside Kubernetes manifest | Deployment can be healthy at container level but unable to query; add an owned service/runbook and alerting. |
| Socket-only Thrift readiness | Wrong process can occupy 10000; verify process and query. |
| `auth=NONE` and topology in ConfigMap | Accept only on trusted network; move auth/topology policy to platform configuration if required. |
| Large 4 km views | Up to about 400k rows; validate driver/server memory and response latency. |
| Process-local snapshot cache | Cache is lost on restart and not shared across replicas. |
| Single replica | No adapter HA; assess before production. |
| Optional EEZ/AIS code | Not proof of deployed dependencies or data freshness. |
| Older live Presentation instance | A schema-v1 smoke marker or missing runtime identity/prewarm evidence is not acceptable even when HTTP responds; restart through the current launcher and rerun smoke. |
| Local compose passwords/Windows path | Development-only; do not import into cluster deployment. |
| Historical manifests | Use 0.10.0 only unless intentionally reproducing an older release. |

Out of scope for this handoff: provisioning HDFS/YARN, generating the Gold table, creating registry credentials, choosing a production ingress/TLS solution, and approving legal meaning of EEZ attribution.

## 11. Merge and release checklist

### Before merge

- [ ] Decide which repo owns the final Kubernetes manifests.
- [ ] Confirm Pod DNS/routing to `dtadm:10000`.
- [ ] Freeze Gold schema, partitions, date range, AOIs, and resolution contract.
- [ ] Replace mutable image tag with immutable release reference.
- [ ] Confirm `dkreg`, namespace `dt`, `gvisor`, and `dt=worker` exist.
- [ ] Confirm no local `.local.json`, API key, password, logs, data, or PID files are staged.
- [ ] Run Python and Node suites.
- [ ] Review the two new architecture/presentation documents as evidence, not runtime contracts.

### Deploy gate

- [ ] Thrift process and a bounded Gold query succeed.
- [ ] Image pull succeeds.
- [ ] Deployment rollout completes and Service has endpoints.
- [ ] `/api/health`, `/api/spark/health`, and `/api/datasets` succeed through NodePort.
- [ ] Dashboard and Developer report the same runtime instance, generation, fingerprint, effective backend, and config bundle hash.
- [ ] Smoke evidence matches the current image, Compose file, config bundle, bridge owner, deployment generation, and persistent EEZ prewarm manifest.
- [ ] UI renders SST for both AOIs and all resolutions.
- [ ] Playback and cache behavior pass smoke checks.
- [ ] Logs show no repeated reconnect, OOM, or query-resource failure.

### Rollback

1. Retain the previous immutable image and manifest revision.
2. Reapply the previous manifest or use `kubectl -n dt rollout undo deployment/bdde-flask` only when ReplicaSet history corresponds to a known image/config pair.
3. Recheck Service endpoints and the three health/catalog endpoints.
4. Do not roll back the Gold schema independently of the adapter contract; treat them as one compatibility unit.

## 12. First files for the next maintainer

Read in this order:

1. `README.md` or `README.zh-TW.md`.
2. `deploy/kubernetes/bdde-flask-0.10.0.yaml`.
3. `common_adapter/http/interface.py` and `common_adapter/http/routes/`.
4. `common_adapter/db/backends/hive.py` and `common_adapter/db/spark_thrift.py`.
5. `common_adapter/endpoint/runtime.py`, `common_adapter/query/sampled_grid.py`, and `common_adapter/query/snapshot_cache.py`.
6. `static/js/runtime/runtime-composition-root.js`, `static/js/services/`, and `static/js/playback/`.
7. `tests/test_hive_sampled_grid_backend.py`, `tests/test_spark_thrift_connection.py`, and the Node contract tests.
8. `docs/RRK_ARCHITECTURE_TECHNICAL_DOCUMENT.zh-TW.md` for deeper history and evidence.

Specialist AIS/backend notes remain under `handoff/`; they are annexes, not the current cluster release source of truth.
