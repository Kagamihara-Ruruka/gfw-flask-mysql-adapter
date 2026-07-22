# Tk Presentation Branch Status

Branch: `dev/tk-version`

This branch is a collaboration checkpoint before the five-dataset storm test. It is not a release tag and must not be merged into `main` on green unit tests alone.

## Start

Requirements:

- Windows 10/11, Python 3.11 or newer, Docker Desktop, OpenSSH, and Tailscale.
- SSH access to `bigred@192.168.32.201`; the jump host must access the `dt` Kubernetes namespace.
- Copy `.env.example` to `.env` and replace all `change-me` values. Never commit `.env`.

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\scripts\presentation\presentation-launcher.cmd
```

The only recommended GUI entry is `scripts/presentation/presentation-launcher.cmd`. Tk delegates all state transitions to `scripts/presentation/presentationctl.py`; it does not implement a second SSH, Kubernetes, Spark, or Docker state machine.

## Current Scope

- Official site, Dashboard, API, and Developer service are packaged in the Presentation Docker image.
- Tk controls preflight, cluster validation, shared Spark Thrift reuse, port forwarding, Compose, health checks, smoke tests, browser launch, status, and owned-resource cleanup.
- The formal Sea1 serving table is `lake.ocean.gold_map_metric` in `hdfs:///dataset/ocean/warehouse`.
- Validated data covers 2022-01-01 through 2024-12-31, both `taiwan` and `northwest_pacific`, 4/16/32 km, and five metrics.
- Runtime identity and desired/effective config state are exposed for Dashboard/Developer consistency checks.
- EEZ preparation is idempotent and includes GPKG validation, PostGIS import, topology, and persistent domain-tile prewarm state.

## Known WIP

- The five-dataset, cross-month storm test has not run against this branch.
- Playback monthly prefetch, cache watermarks, producer cancellation on Pause, and a single pin/eviction owner still require the P0 convergence pass.
- Presentation default spatial resolution still needs to be finalized at 16 km.
- `.env` secret provisioning is manual in this checkpoint; the launcher must not store a plaintext secret in git.
- Temporal interpolation is not part of this checkpoint and must remain disabled until the P0 playback invariants pass.

## Test Data Contract

Presentation queries Spark Thrift/Iceberg records from `lake.ocean.gold_map_metric`. The sampled-grid contract includes event date, AOI, resolution, grid position/bounds, metric value, canonical validity/status, and the five product/metric pairs described in the README. Local spatial tests use a Marine Regions EEZ GPKG and PostGIS. Unit tests use in-repo fixtures and mocks; no production data or credentials are committed.

## Next Milestone

Converge monthly range ownership and cache watermarks, set the Presentation default to 16 km, then run one-month smoke and storm tests for all five datasets across at least one month boundary. Only after drift, compatibility-shim, duplicate-owner, documentation, and clean-clone quick-start checks pass may this branch be promoted as a release candidate.

## 中文摘要

此分支是五表風暴測試前的協作 checkpoint，不是正式發布版。建議唯一入口為 `scripts/presentation/presentation-launcher.cmd`。正式 Sea1 入口是 `192.168.32.201`，Gold 可查範圍為 2022-01-01 至 2024-12-31；目前仍須完成按月預取、水位、Pause 取消、快取 owner、預設 16 km 與五表跨月風暴驗收。任何真實密碼、API key、本機私有路徑與 `.env` 都不得提交。
