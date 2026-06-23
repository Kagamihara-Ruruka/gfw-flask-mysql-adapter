# GFW Flask MySQL Adapter

This is a small local map adapter for exploring ocean datasets with Flask, MySQL, PostGIS, and Leaflet.

The current app renders:

- GFW fishery grid records from MySQL.
- AIS latest vessel positions from a live MySQL table.
- EEZ boundaries from PostGIS vector tiles.
- A Leaflet map with table preview, timing metrics, time playback, fullscreen map mode, layer ordering, and per-layer alpha controls.

It is an experimental local tool. It is not a production GIS system.

## Architecture

```text
core.py
  -> Interface.py              Flask routes and HTTP service
  -> DatabaseConnect.py        MySQL config, import, schema, record queries
  -> AisLiveService.py         AIS live query packet
  -> SpatialOverlay.py         EEZ overlay fallback helpers
  -> LodOverlayService.py      PostGIS / MVT EEZ tile helpers
  -> templates/index.html      Leaflet UI shell
  -> static/js/*               Frontend state, API, layer, and UI modules
```

The frontend is deliberately split by responsibility:

- `static/app.js`: bootstraps the app and wires UI events.
- `static/js/core`: shared state, DOM, map, and geographic helpers.
- `static/js/services`: API client calls.
- `static/js/layers`: GFW, AIS, and EEZ rendering behavior.
- `static/js/ui`: table, playback, and layer selector controls.

## Features

### Data layers

The dataset selector supports these layers:

- `GFW fishery grid`
- `AIS vessel positions`
- `EEZ boundary overlay`

GFW and AIS are mutually exclusive primary data layers, but both can also be turned off. EEZ is an independent overlay.

Layer rows can be drag-reordered in the selector. The order controls map stacking by Leaflet pane z-index. Each layer also has a gear panel with alpha controls. AIS can switch between density-grid and point-dot rendering.

### Map

- Dark UI theme.
- Leaflet base map.
- Fullscreen map button.
- Fullscreen preserves the current geographic bounds instead of showing extra horizontal world copies.
- EEZ uses vector tiles when available.

### Time controls

GFW supports:

- single-day mode
- start/end date range
- replay
- previous/next day
- play/pause
- playback speed

AIS is live viewport mode and does not use the date player.

### Timing panel

The timing drawer reports:

- SQL query time
- serialization time
- API total time
- client fetch-to-render time
- EEZ tile timing
- row count

## Requirements

- Python 3.11+
- MySQL-compatible server
- PostgreSQL + PostGIS for EEZ vector tiles
- Node.js only for local JavaScript syntax checks

Python dependencies are listed in `requirements.txt`.

## Quick Start

From the repo root:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config\adapter.example.json config\adapter.local.json -Force
```

Edit `config\adapter.local.json` for local database settings.

`config\adapter.local.json` is ignored by git. Keep real passwords there or in environment variables.

For AIS, use an environment variable instead of committing a password:

```powershell
$env:RRKAL_AIS_MYSQL_PASSWORD = "your-password"
```

Start the app:

```powershell
.\.venv\Scripts\python.exe core.py --config config\adapter.local.json serve
```

Open:

```text
http://127.0.0.1:5057
```

## Import GFW Data

Import a DuckDB table into MySQL:

```powershell
.\.venv\Scripts\python.exe core.py --config config\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace
```

Import a smaller sample:

```powershell
.\.venv\Scripts\python.exe core.py --config config\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace --row-limit 5000
```

## Docker Compose

The repo includes `docker-compose.yml` for local service support. Adjust ports and passwords in your local config before use.

```powershell
docker compose up -d
```

## API Surface

Health:

```text
GET /api/health
```

Datasets:

```text
GET /api/datasets
GET /api/datasets/<dataset_id>/schema
GET /api/datasets/<dataset_id>/records?date=YYYY-MM-DD&bbox=west,south,east,north&limit=100000
```

EEZ:

```text
GET /api/overlays/eez
GET /api/overlays/eez/tiles/<z>/<x>/<y>.pbf
GET /api/overlays/eez/boundary/tiles/<z>/<x>/<y>.pbf
```

AIS:

```text
GET /api/live/ais?bbox=west,south,east,north
```

## Validation

JavaScript syntax check:

```powershell
Get-ChildItem static\js -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
node --check static\app.js
```

Git whitespace check:

```powershell
git diff --check -- static templates *.py config requirements.txt docker-compose.yml README.md
```

## Notes

- Do not commit `config/adapter.local.json`.
- Do not commit runtime logs, PID files, database files, or downloaded datasets.
- Use environment variables for local secrets.
- This app is designed as a small local exploratory adapter. Keep data access, rendering, and UI behavior separated as the feature set grows.
