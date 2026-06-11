# GFW MySQL 轉接頭 MVP

這份專案把原本的靜態儀表板流程，改成一條可查詢、可量測、可部署的動態資料管線：

```text
DuckDB 來源資料 -> 匯入 MySQL -> Flask / PyMySQL 轉接頭 -> HTML5 / Leaflet 地圖與表格
```

前端會量測「從網頁送出請求，到資料回來並完成地圖與表格渲染」的總時間。後端會回報 SQL 查詢時間、JSON 序列化時間、Flask API 總時間。

## 為什麼不是直接產生 HTML

雲端資料夾裡的 `gfw_dashboard_FULL.html` 是一份已經把資料塞進去的靜態 HTML。它適合展示 demo，但不適合面對更大的資料集。

本專案採用新的流程：

```text
網頁三件套 -> Flask API -> PyMySQL -> MySQL
```

資料會留在 SQL 後端，前端只拿當下需要的切片資料，不會一次把整張大表塞進 Python 或瀏覽器。

## 檔案結構

真正執行時需要看的檔案很少：

```text
adapter.py                  # 匯入資料、啟動 Flask、查 MySQL、回傳 JSON
config/adapter.example.json # MySQL 位置、資料表欄位、查詢上限、預設啟動設定
config/adapter.schema.json  # 配置檔格式說明，給人類與 IDE 參考
benchmarks/                 # row-scale pipeline 測速報告
templates/index.html        # 網頁 HTML
static/app.js               # 前端請求、地圖、表格、總耗時計算
static/styles.css           # 樣式
```

支援檔案：

```text
requirements.txt
docker-compose.yml
.gitignore
README.md
```

## 最短操作流程

如果資料庫檔案放在下載資料夾，而且檔名是 `完整資料庫gfw_full.duckdb`，第一次驗收可以直接複製下面整段貼到 PowerShell：

```powershell
cd "C:\Users\lyn59\Documents\Codex\2026-06-05\rrkal-o-1-session-code-rrkal\work\gfw_mysql_adapter_mvp"
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config\adapter.example.json config\adapter.local.json -Force
docker compose up -d
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json import --source "C:\Users\lyn59\Downloads\完整資料庫gfw_full.duckdb" --replace
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json serve
```

最後一行會啟動 Flask 伺服器。終端機不要關，接著用瀏覽器打開：

```text
http://127.0.0.1:5057
```

如果資料已經匯入過，只想重新啟動網頁，複製下面這段即可：

```powershell
cd "C:\Users\lyn59\Documents\Codex\2026-06-05\rrkal-o-1-session-code-rrkal\work\gfw_mysql_adapter_mvp"
docker compose up -d
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json serve
```

## IDE 直接按 Run

如果 IDE 只是執行：

```powershell
python adapter.py
```

程式會讀 `config/adapter.local.json` 裡的 `server` 設定，自動等同於：

```powershell
python adapter.py --config config/adapter.local.json serve
```

也就是直接啟動 Flask。匯入資料仍然要用 `import` 指令。

`server` 設定如下：

```json
{
  "server": {
    "default_command": "serve",
    "host": "127.0.0.1",
    "port": 5057,
    "debug": false,
    "kill_port_if_busy": true
  }
}
```

`kill_port_if_busy` 的意思是：如果 IDE 重複按 Run，舊的 Flask 還佔著同一個 port，程式會先把正在 listen 該 port 的舊 process 關掉，再啟動新的 Flask。這是為了避免維護者卡在「port already in use」。

## 安裝套件

如果不使用最短流程，也可以分步安裝：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config\adapter.example.json config\adapter.local.json -Force
```

目前使用的 Python 套件：

```text
Flask
PyMySQL
duckdb
```

## 啟動 MySQL

如果只是本機驗證，可以直接用本專案附的 Docker MySQL：

```powershell
docker compose up -d
```

預設 MySQL 會開在：

```text
127.0.0.1:3307
database: ocean_fishery
user: root
password: fishery123
```

如果要接現有 MySQL 或未來的 SQL 服務，請改 `config/adapter.local.json`。

## 匯入 DuckDB 到 MySQL

完整匯入：

```powershell
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace
```

小量測試：

```powershell
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json import --source "C:\path\to\gfw_full.duckdb" --replace --row-limit 5000
```

匯入時採用 chunk streaming，不會把整份資料一次讀進 pandas 或 Python 記憶體。這是為了避免未來資料列數更大時 OOM。

## 啟動 Flask 伺服器

```powershell
.\.venv\Scripts\python.exe adapter.py --config config\adapter.local.json serve
```

預設網址由 `config/adapter.local.json` 的 `server.port` 決定。本專案預設是：

```text
http://127.0.0.1:5057
```

## API

健康檢查：

```text
GET /api/health
```

資料集列表：

```text
GET /api/datasets
```

資料表欄位與日期：

```text
GET /api/datasets/gfw_full/schema
```

查詢資料：

```text
GET /api/datasets/gfw_full/records?date=2024-01-01&limit=1000
```

查詢回應會包含：

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

前端會另外計算 `Fetch to render`，也就是從瀏覽器送出請求，到地圖與表格更新完成的總時間。

## 配置檔需要填什麼

配置檔不是資料庫 DDL，而是「資料集語意對照表」。它告訴轉接頭：

- SQL 服務在哪裡
- Flask 預設開在哪個 host / port
- 哪一張表是目前資料集
- 哪個欄位是時間
- 哪個欄位是緯度
- 哪個欄位是經度
- 哪些欄位要送到前端表格
- 每次查詢最多回傳幾筆
- 表格最多預覽幾筆

主要欄位：

```json
{
  "sql_backend": {
    "kind": "mysql",
    "driver": "pymysql"
  },
  "mysql": {
    "host": "127.0.0.1",
    "port": 3307,
    "user": "root",
    "password": "fishery123",
    "database": "ocean_fishery"
  },
  "query_policy": {
    "default_limit": 1000,
    "max_limit": 5000,
    "table_preview_limit": 300,
    "require_time_or_bbox_filter": true
  },
  "server": {
    "default_command": "serve",
    "host": "127.0.0.1",
    "port": 5057,
    "debug": false,
    "kill_port_if_busy": true
  }
}
```

每個 dataset 需要：

- `duckdb_source_table`：匯入時讀的 DuckDB 表。
- `mysql_table`：Flask 查詢時讀的 MySQL 表。
- `time_column`：時間欄位。
- `lat_column`：緯度欄位。
- `lon_column`：經度欄位。
- `id_column`：資料識別欄位。
- `display_columns`：回傳給前端表格的欄位。
- `metric_columns`：數值欄位，未來可拿來做圖表或顏色。
- `category_columns`：分類欄位，未來可拿來做篩選。

嚴格格式請看：

```text
config/adapter.schema.json
```

## 未來部署到 K8s 的理解

未來部署時，可以把 Flask adapter 放在對方的 pod 裡：

```text
HTML/CSS/JS -> Flask pod -> SQL backend driver -> SQL service / lakehouse endpoint
```

目前是 MySQL / PyMySQL。如果未來湖倉提供的是 MySQL protocol，這份轉接頭可以直接改連線位置。

如果未來湖倉提供的是 Trino、Spark SQL、Databricks SQL 或其他協定，就只應該替換 `adapter.py` 裡的 SQL driver 查詢層，前端 API 契約不應該重寫。

## 容量邊界

這份 MVP 有刻意保護資料管線：

- 匯入資料時用 chunk streaming。
- API 每次查詢最多回傳 `query_policy.max_limit` 筆。
- 表格只顯示 `query_policy.table_preview_limit` 筆。
- 查詢預設需要時間或 bbox 條件，避免無意中掃整張大表。
- 大資料集應該留在 MySQL 或湖倉裡，不應該被整包塞進 Python 或前端。

## 已知定位

這是最低交付版本，不追求華麗特效。它要證明的是：

```text
前端可以透過 Flask 轉接頭查 SQL，
資料可以切片回傳，
地圖與表格可以渲染，
而且整條 pipeline 的耗時可以被量測。
```
