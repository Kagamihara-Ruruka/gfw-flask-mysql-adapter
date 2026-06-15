# GFW Flask MySQL Adapter MVP

This project imports a GFW DuckDB table into MySQL and serves it through a Flask API plus a Leaflet dashboard.

```text
DuckDB source -> MySQL -> Flask / PyMySQL API -> HTML / Leaflet dashboard
```

## Project Layout

```text
adapter.py                  # Import pipeline, Flask API, MySQL queries
config/adapter.example.json # Example runtime config
config/adapter.schema.json  # Config schema
benchmarks/                 # Row-scale benchmark notes
templates/index.html        # Dashboard shell
static/app.js               # Map/table client logic
static/styles.css           # Dashboard styles
requirements.txt            # Python dependencies
docker-compose.yml          # Optional local MySQL container
```

## Local Setup

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config\adapter.example.json config\adapter.local.json -Force
```

Start MySQL with Docker:

```powershell
docker compose up -d
```

Default Docker MySQL settings:

```text
host: 127.0.0.1
port: 3307
database: ocean_fishery
user: root
password: fishery123
```

If you use an existing local MySQL instance, update `config/adapter.local.json` accordingly.

## Import Data

```powershell
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace
```

For a small smoke test:

```powershell
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace --row-limit 5000
```

The importer streams rows in chunks to avoid loading the full DuckDB table into memory.

## Run Flask

```powershell
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json serve
```

Open:

```text
http://127.0.0.1:5057
```

When `kill_port_if_busy` is enabled, the server can clean up an existing listener on the configured port before starting. This helps with repeated IDE runs.

## API

```text
GET /api/health
GET /api/datasets
GET /api/datasets/gfw_full/schema
GET /api/datasets/gfw_full/records?date=2024-01-01&bbox=119,21,123,26&zoom=6&lod=1
```

Timing is returned in the response:

```json
{
  "timing": {
    "query_ms": 0,
    "serialize_ms": 0,
    "server_total_ms": 0,
    "api_total_ms": 0
  }
}
```

The client also measures `Fetch to render`, which covers the browser-side time from request start through map/table rendering.

## Query Policy

`query_policy` controls default limits, optional hard limits, and table preview size:

```json
{
  "query_policy": {
    "default_limit": 1000,
    "max_limit": 5000,
    "table_preview_limit": 300,
    "require_time_or_bbox_filter": true
  }
}
```

`max_limit` may be set to `null` to remove the API clamp. This should be used carefully because large browser renders can still be expensive.

## Rendering Strategy

The map uses Leaflet rectangles to draw the fishing grid. Rendering is intentionally viewport-driven:

- The current map bounds are sent as `bbox=west,south,east,north`.
- The selected date and current map bounds both participate in the SQL query.
- The browser only receives rows for the current view instead of pulling a whole day by default.
- The initial map view is centered near Taiwan to avoid a heavy global first render.
- Leaflet vector rendering uses Canvas for better large-layer performance.
- Tooltips are disabled automatically when the rendered row count is high.
- The table is a preview only; the map may render more rows than the table displays.

In short: the map viewport is part of the query, not just a client-side crop.

## LOD Strategy

LOD is based on the current zoom level, but it does not enlarge rendered grid cells.

At close zoom levels, the API returns original rows 1:1:

```text
zoom >= 6 -> original rows, one source row per rendered rectangle
```

At wider zoom levels, the API samples representative original rows by spatial bucket:

```text
zoom = 5  -> sample bucket 0.0625 degrees
zoom = 4  -> sample bucket 0.25 degrees
zoom = 3  -> sample bucket 0.5 degrees
zoom <= 2 -> sample bucket 1.25 degrees
```

The bucket only controls sampling density. Rendered rectangles still use the original grid size and original `grid_id`, `lat`, and `lon`. This keeps the map from implying a lower-resolution grid while still preventing global views from sending too many Leaflet rectangles to the browser.

## Config Notes

Each dataset config includes:

- `duckdb_source_table`: source table in the DuckDB file
- `mysql_table`: target/query table in MySQL
- `time_column`: date/time column
- `lat_column`: latitude column
- `lon_column`: longitude column
- `id_column`: stable row/grid id
- `display_columns`: columns returned to the dashboard
- `metric_columns`: numeric columns used by the UI
- `category_columns`: categorical columns used by the UI

See `config/adapter.schema.json` for the full schema.
