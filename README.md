# RRK Common Adapter

Current release: `0.10.0`

Chinese: [README.zh-TW.md](README.zh-TW.md)

Downstream handoff: [HANDOFF.md](HANDOFF.md) / [HANDOFF.zh-TW.md](HANDOFF.zh-TW.md)

RRK Common Adapter is a Flask web application that turns configured SQL data sources into map, timeline, chart, table, and live-AIS experiences. The current cluster path reads Iceberg Gold data through Spark Thrift/PyHive and serves the browser UI and JSON APIs from one Kubernetes Pod.

This README describes the checked-in `0.10.0` code and deployment manifest. Historical release notes and design evidence live under `docs/`, `benchmarks/`, and `handoff/` so the main entry point does not drift into a changelog.

## What works now

- Spark Thrift/PyHive reads from `lake.ocean.gold_map_metric`.
- SST map snapshots support `taiwan` and `northwest_pacific` AOIs at 4, 16, and 32 km.
- Viewport bounds are pushed into global grid-index predicates; large views can degrade to a complete coarser grid instead of returning a truncated fine grid.
- Snapshot identity includes dataset, date, AOI, resolution, and bbox; the process-wide row budget is 800,000 in the cluster manifest.
- A single Flask app exposes the main UI, dataset APIs, Spark compatibility APIs, EEZ overlay routes, rendering capability, and optional AIS routes.
- The frontend includes Leaflet/WebGL rendering, playback scheduling and preheating, widgets, map export, telemetry, and developer configuration screens.
- MySQL, PostGIS/EEZ, AISStream ingest, and DuckDB-to-MySQL import remain supported but are not enabled by the `0.10.0` SST cluster manifest.
- Kubernetes deployment is provided at `deploy/kubernetes/bdde-flask-0.10.0.yaml`; the Service is NodePort `32080` in namespace `dt`.

## Runtime shape

```text
Browser
  -> Flask / NodePort 32080
     -> assembled runtime + source + mapping configuration
     -> PyHive
        -> Spark Thrift Server :10000
           -> Spark 3.5.8 on YARN
              -> Iceberg Hadoop catalog `lake`
                 -> hdfs:///dataset/ocean/warehouse
```

The Kubernetes ConfigMap contains four documents:

- `adapter.local.json`: server, query, rendering, and cache policy.
- `spark_thrift.local.json`: the PyHive connection and Gold table defaults.
- `router_manifest.local.json`: active/locked source selection.
- `layer_mappings.local.json`: dataset/layer roles, AOIs, grid geometry, resolutions, cache identity, and color scale.

An init container copies those files from the read-only ConfigMap volume into a writable `emptyDir` mounted at `/app/config`. Do not remove this step without first making runtime configuration strictly read-only.

## Repository map

| Path | Responsibility |
| --- | --- |
| `adapter.py`, `core.py` | CLI entry point and commands |
| `common_adapter/config/` | Canonical config layout and assembly |
| `common_adapter/db/` | MySQL, Hive/PyHive, Spark helpers, connection lifecycle |
| `common_adapter/query/`, `endpoint/` | Dataset contracts, sampled grids, registries, cache identity |
| `common_adapter/http/` | Flask app factory, routes, and server lifecycle |
| `common_adapter/spatial/` | EEZ/PostGIS bootstrap, LOD, overlays, tile cache |
| `common_adapter/ais/`, `collectors/` | AIS read model and upstream ingest |
| `static/`, `templates/` | Browser application |
| `config/examples/` | Commit-safe examples; no live credentials |
| `deploy/kubernetes/` | Versioned cluster manifests |
| `tests/` | Python and Node contract tests |
| `docs/`, `benchmarks/`, `handoff/` | Deep design, evidence, and specialist handoffs |

## Requirements

- Python 3.10+ (the image uses Python 3.10; the current local Python suite also passes on 3.12)
- Dependencies from `requirements.txt`
- Node.js to run the browser contract suite
- For the current cluster path: Spark Thrift reachable from the Pod at the configured host/port
- Optional by feature: MySQL 8.4, PostGIS 16, AISStream credentials

## Local start

Create a local runtime config from the example; never commit the local file.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

New-Item -ItemType Directory -Force config\runtime | Out-Null
Copy-Item config\examples\runtime\adapter.example.json config\runtime\adapter.local.json
python adapter.py --config config\runtime\adapter.local.json serve
```

The default example starts the main UI on `http://127.0.0.1:5057` and the developer UI on port `5058`. Pass `--no-developer-server` for the one-process cluster shape.

Useful commands:

```text
python core.py [--config PATH] serve [--host HOST] [--port PORT] [--developer-port PORT] [--no-developer-server]
python core.py [--config PATH] check-dependencies
python core.py [--config PATH] bootstrap-eez
python core.py [--config PATH] import --source FILE --dataset ID [--replace]
python core.py [--config PATH] ingest-ais [--collector-config FILE]
```

## Cluster deploy

The checked-in manifest assumes these cluster-owned dependencies:

- namespace `dt`
- registry `dkreg.taroko:5000` and imagePullSecret `dkreg`
- node label `dt=worker`
- runtime class `gvisor`
- Spark Thrift hostname `dtadm`, port `10000`, user `bigred`, auth `NONE`
- NodePort `32080` available on a reachable worker node

```bash
docker build -t dkreg.taroko:5000/bdde-flask:dev .
docker push dkreg.taroko:5000/bdde-flask:dev
kubectl apply -f deploy/kubernetes/bdde-flask-0.10.0.yaml
kubectl -n dt rollout status deployment/bdde-flask
kubectl -n dt get pod,svc,endpoints -l app=bdde-flask
```

The manifest currently uses the mutable `:dev` image tag. Pin a release tag or digest before merging into a production deployment repository.

To reach the NodePort through the existing jump host from Windows PowerShell:

```powershell
ssh -N -o ExitOnForwardFailure=yes `
  -L 15081:172.22.128.3:32080 `
  bigred@192.168.32.200
```

Then open `http://127.0.0.1:15081/`. The tunnel exposes the Flask NodePort; it does not expose Spark Thrift.

The exact Spark Thrift launch runbook and the downstream repository merge contract are in [HANDOFF.md](HANDOFF.md).

## Primary endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Browser application |
| `GET /api/health` | Flask liveness |
| `GET /api/datasets` | Dataset and layer catalog |
| `GET /api/datasets/<id>/schema` | Dataset schema and capabilities |
| `GET /api/datasets/<id>/records` | Snapshot/viewport records |
| `GET /api/datasets/<id>/records/range` | Range records |
| `GET /api/datasets/<id>/time-series` | Time-series packet |
| `GET /api/spark/health` | Adapter version and Spark route health |
| `GET /api/spark/availability` | Gold availability |
| `GET /api/spark/heatmap` | Gold heatmap compatibility route |
| `GET /api/overlays/eez/...` | Optional EEZ data and MVT tiles |
| `GET /api/live/ais` / `GET /ws/live/ais` | Optional AIS snapshot/live stream |

## Validation

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests\*.test.mjs
git diff --check
```

At the 2026-07-21 handoff checkpoint, the Python suite has 55 passing tests. The Node suite contains 13 files and also passes with the bundled Node runtime. External Spark, HDFS, registry, Kubernetes, and SSH connectivity are integration checks and are not proven by the isolated unit suite.

## Configuration and secret policy

- Commit examples and schemas, not live credentials.
- Local runtime, source, state, mapping, logs, PID files, downloaded data, and AIS handoff secrets are ignored by `.gitignore`.
- Environment indirection uses values such as `env:VARIABLE_NAME`; provide the secret in the deployment platform.
- The checked-in SST manifest contains topology and a username but no password/API token.
- `docker-compose.yml` is a local MySQL/PostGIS convenience stack, not the current Spark cluster deployment.

## Merge notes

The safest merge boundary is contract-first: keep the other repository responsible for Spark/Hadoop/YARN/Iceberg data production and keep this repository responsible for the Flask adapter/UI. Agree on the Thrift endpoint, catalog/table schema, image ownership, namespace, and health gates before combining deployment assets. See [HANDOFF.md](HANDOFF.md) for the detailed checklist, known risks, and rollback procedure.
