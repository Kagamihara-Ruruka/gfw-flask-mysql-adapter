from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_json(path: str | Path) -> dict[str, Any]:
    config_path = Path(path)
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    with config_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def parse_day(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def iter_days(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def resolve_store_path(config: dict[str, Any], key: str) -> Path:
    store = config.get("store", {})
    root = Path(store.get("root", "D:/RRKAL_tools/nasa_ocean_store"))
    child = store.get(key, key)
    path = root / child
    path.mkdir(parents=True, exist_ok=True)
    return path


def resolve_database_path(config: dict[str, Any]) -> Path:
    sink = config.get("sink", {})
    database_path = Path(sink.get("database_path", "D:/RRKAL_tools/nasa_ocean_store/db/nasa_ocean.duckdb"))
    if not database_path.is_absolute():
        database_path = ROOT / database_path
    database_path.parent.mkdir(parents=True, exist_ok=True)
    return database_path


def asset_id(item: dict[str, Any]) -> str:
    return f"{item['dataset_id']}:{item['date']}:{item['filename']}"


def now_sql() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def duckdb_connect(config: dict[str, Any]) -> duckdb.DuckDBPyConnection:
    return duckdb.connect(str(resolve_database_path(config)))


def init_database(config: dict[str, Any]) -> Path:
    sink = config.get("sink", {})
    assets_table = sink.get("assets_table", "nasa_ocean_assets")
    schema_table = sink.get("schema_table", "nasa_ocean_schema_snapshots")
    tile_stats_table = sink.get("tile_stats_table", "nasa_ocean_tile_stats")
    database_path = resolve_database_path(config)
    con = duckdb.connect(str(database_path))
    try:
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {assets_table} (
              asset_id VARCHAR PRIMARY KEY,
              dataset_id VARCHAR NOT NULL,
              product VARCHAR NOT NULL,
              variable VARCHAR NOT NULL,
              date DATE NOT NULL,
              filename VARCHAR NOT NULL,
              download_url VARCHAR NOT NULL,
              raw_path VARCHAR,
              zarr_path VARCHAR,
              raw_bytes BIGINT,
              status VARCHAR NOT NULL,
              schema_json VARCHAR,
              error_message VARCHAR,
              listed_at TIMESTAMP,
              downloaded_at TIMESTAMP,
              zarr_written_at TIMESTAMP,
              ingested_at TIMESTAMP
            )
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {schema_table} (
              asset_id VARCHAR,
              inspected_at TIMESTAMP NOT NULL,
              path VARCHAR NOT NULL,
              dims_json VARCHAR NOT NULL,
              data_vars_json VARCHAR NOT NULL,
              coords_json VARCHAR NOT NULL,
              variables_json VARCHAR NOT NULL,
              attrs_json VARCHAR NOT NULL
            )
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {tile_stats_table} (
              asset_id VARCHAR NOT NULL,
              dataset_id VARCHAR NOT NULL,
              product VARCHAR NOT NULL,
              variable VARCHAR NOT NULL,
              date DATE NOT NULL,
              tile_degrees DOUBLE NOT NULL,
              tile_x INTEGER NOT NULL,
              tile_y INTEGER NOT NULL,
              west DOUBLE NOT NULL,
              south DOUBLE NOT NULL,
              east DOUBLE NOT NULL,
              north DOUBLE NOT NULL,
              count_valid BIGINT NOT NULL,
              avg_value DOUBLE,
              min_value DOUBLE,
              max_value DOUBLE,
              source_path VARCHAR NOT NULL,
              zarr_path VARCHAR,
              created_at TIMESTAMP NOT NULL
            )
            """
        )
        con.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{assets_table}_date_dataset ON {assets_table}(date, dataset_id)"
        )
        con.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{tile_stats_table}_query ON {tile_stats_table}(date, dataset_id, tile_degrees, tile_x, tile_y)"
        )
    finally:
        con.close()
    return database_path


def command_init_db(args: argparse.Namespace) -> int:
    config = load_json(args.collector_config)
    database_path = init_database(config)
    print(json.dumps({"status": "database_ready", "path": str(database_path)}, ensure_ascii=False))
    return 0


def command_ingest_manifest(args: argparse.Namespace) -> int:
    config = load_json(args.collector_config)
    database_path = init_database(config)
    assets_table = config.get("sink", {}).get("assets_table", "nasa_ocean_assets")
    manifest = load_json(args.manifest)
    rows = []
    listed_at = now_sql()
    for item in manifest["files"]:
        rows.append(
            (
                asset_id(item),
                item["dataset_id"],
                item["product"],
                item["variable"],
                item["date"],
                item["filename"],
                item["download_url"],
                "listed",
                listed_at,
            )
        )
    con = duckdb.connect(str(database_path))
    try:
        if args.replace:
            con.execute(f"DELETE FROM {assets_table}")
        insert_prefix = "INSERT INTO" if args.replace else "INSERT OR IGNORE INTO"
        con.executemany(
            f"""
            {insert_prefix} {assets_table}
              (asset_id, dataset_id, product, variable, date, filename, download_url, status, listed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        summary = con.execute(
            f"""
            SELECT dataset_id, COUNT(*) AS files, MIN(date) AS min_date, MAX(date) AS max_date
            FROM {assets_table}
            GROUP BY dataset_id
            ORDER BY dataset_id
            """
        ).fetchall()
    finally:
        con.close()
    print(
        json.dumps(
            {
                "status": "manifest_ingested",
                "database": str(database_path),
                "assets": len(rows),
                "summary": [
                    {"dataset_id": row[0], "files": row[1], "min_date": str(row[2]), "max_date": str(row[3])}
                    for row in summary
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _post_file_search(config: dict[str, Any], day: date, search: str | None = None) -> list[str]:
    source = config["source"]
    params = {
        "sensor": source.get("sensor", "aqua"),
        "sdate": day.isoformat(),
        "edate": day.isoformat(),
        "dtype": source.get("dtype", "L3m"),
        "results_as_file": "1",
        "output_format": "txt",
    }
    if search:
        params["search"] = search
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(source["file_search_url"], data=data, method="POST")
    with urllib.request.urlopen(req, timeout=int(source.get("timeout_seconds", 60))) as response:
        text = response.read().decode("utf-8", errors="strict")
    return [line.strip() for line in text.splitlines() if line.strip()]


def filter_product_filenames(config: dict[str, Any], filenames: list[str], product: dict[str, Any]) -> list[str]:
    source = config["source"]
    filenames = [name.strip() for name in filenames if name.strip()]
    if source.get("exclude_nrt", True):
        filenames = [name for name in filenames if ".NRT." not in name and not name.endswith(".NRT.nc")]
    canonical = product.get("canonical_contains")
    if canonical:
        filenames = [name for name in filenames if all(token in name for token in canonical)]
    return sorted(set(filenames))


def file_search(config: dict[str, Any], day: date, product: dict[str, Any]) -> list[str]:
    pattern = product["search"].format(date=day.strftime("%Y%m%d"))
    return filter_product_filenames(config, _post_file_search(config, day, pattern), product)


def file_search_day(config: dict[str, Any], day: date) -> dict[str, list[str]]:
    filenames = _post_file_search(config, day)
    return {
        product["dataset_id"]: filter_product_filenames(config, filenames, product)
        for product in config["source"]["products"]
    }


def command_list(args: argparse.Namespace) -> int:
    config = load_json(args.collector_config)
    source = config["source"]
    start = parse_day(args.start_date or source["start_date"])
    end = parse_day(args.end_date or source["end_date"])
    manifest_dir = resolve_store_path(config, "manifest_dir")
    limit_days = args.limit_days
    manifest: list[dict[str, Any]] = []

    for index, day in enumerate(iter_days(start, end), start=1):
        if limit_days is not None and index > limit_days:
            break
        day_files = file_search_day(config, day) if source.get("list_strategy", "day_all") == "day_all" else None
        for product in source["products"]:
            filenames = day_files[product["dataset_id"]] if day_files is not None else file_search(config, day, product)
            for filename in filenames:
                manifest.append(
                    {
                        "date": day.isoformat(),
                        "dataset_id": product["dataset_id"],
                        "product": product["product"],
                        "variable": product["variable"],
                        "filename": filename,
                        "download_url": source["download_base_url"].rstrip("/") + "/" + filename,
                    }
                )
            print(
                json.dumps(
                    {
                        "status": "listed",
                        "date": day.isoformat(),
                        "dataset_id": product["dataset_id"],
                        "files": len(filenames),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    output = Path(args.output) if args.output else manifest_dir / f"nasa_ocean_manifest_{start}_{end}.json"
    if not output.is_absolute():
        output = ROOT / output
    write_json(output, {"start_date": start.isoformat(), "end_date": end.isoformat(), "files": manifest})
    print(json.dumps({"status": "manifest_written", "path": str(output), "files": len(manifest)}, ensure_ascii=False))
    return 0


def earthdata_opener(config: dict[str, Any]) -> urllib.request.OpenerDirector:
    token = os.environ.get(config["source"].get("earthdata_token_env", "EARTHDATA_TOKEN"))
    if token:
        class BearerTokenHandler(urllib.request.BaseHandler):
            def http_request(self, req):
                req.add_unredirected_header("Authorization", f"Bearer {token}")
                return req

            https_request = http_request

        return urllib.request.build_opener(BearerTokenHandler(), urllib.request.HTTPCookieProcessor())

    username = os.environ.get(config["source"].get("earthdata_username_env", "EARTHDATA_USERNAME"))
    password = os.environ.get(config["source"].get("earthdata_password_env", "EARTHDATA_PASSWORD"))
    if not username or not password:
        raise RuntimeError("Earthdata credentials are required for download; set EARTHDATA_USERNAME/EARTHDATA_PASSWORD or EARTHDATA_TOKEN.")
    password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    password_mgr.add_password(None, "https://urs.earthdata.nasa.gov", username, password)
    handlers = [
        urllib.request.HTTPBasicAuthHandler(password_mgr),
        urllib.request.HTTPCookieProcessor(),
    ]
    return urllib.request.build_opener(*handlers)


def looks_like_netcdf(path: Path) -> bool:
    head = path.read_bytes()[:16]
    return head.startswith(b"CDF") or head.startswith(b"\x89HDF\r\n\x1a\n")


def reject_bad_download(path: Path) -> None:
    if looks_like_netcdf(path):
        return
    head = path.read_bytes()[:256].decode("utf-8", errors="replace")
    try:
        path.unlink()
    except OSError:
        pass
    if "Access denied" in head or "Earthdata" in head or "<!DOCTYPE html" in head:
        raise RuntimeError("download did not return a NetCDF/HDF file; Earthdata authentication or OB.DAAC authorization is not complete.")
    raise RuntimeError("download did not return a NetCDF/HDF file; refusing to mark asset as downloaded.")


def earthdata_credentials(config: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    source = config["source"]
    token = os.environ.get(source.get("earthdata_token_env", "EARTHDATA_TOKEN"))
    username = os.environ.get(source.get("earthdata_username_env", "EARTHDATA_USERNAME"))
    password = os.environ.get(source.get("earthdata_password_env", "EARTHDATA_PASSWORD"))
    return username, password, token


def curl_download(config: dict[str, Any], item: dict[str, Any], target: Path, timeout_seconds: int) -> None:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl.exe is required for stable Earthdata downloads but was not found on PATH.")
    username, password, token = earthdata_credentials(config)
    cookie_dir = resolve_store_path(config, "auth_dir")
    cookie_jar = cookie_dir / "earthdata_cookies.txt"
    headers: list[str] = []
    with tempfile.TemporaryDirectory(prefix="rrkal_earthdata_") as temp_dir:
        netrc_path = Path(temp_dir) / "earthdata.netrc"
        if token:
            headers.extend(["--header", f"Authorization: Bearer {token}"])
        else:
            if not username or not password:
                raise RuntimeError("Earthdata credentials are required for download; set EARTHDATA_USERNAME/EARTHDATA_PASSWORD or EARTHDATA_TOKEN.")
            netrc_path.write_text(
                f"machine urs.earthdata.nasa.gov login {username} password {password}\n",
                encoding="utf-8",
                newline="\n",
            )
        partial = target.with_suffix(target.suffix + ".part")
        if partial.exists():
            partial.unlink()
        command = [
            curl,
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "60",
            "--max-time",
            str(timeout_seconds),
            "--cookie",
            str(cookie_jar),
            "--cookie-jar",
            str(cookie_jar),
            "--output",
            str(partial),
        ]
        if token:
            command.extend(headers)
        else:
            command.extend(["--netrc-file", str(netrc_path)])
        command.append(item["download_url"])
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        if result.returncode != 0:
            if partial.exists():
                partial.unlink()
            stderr = (result.stderr or "").strip().splitlines()
            detail = stderr[-1] if stderr else f"curl exit {result.returncode}"
            raise RuntimeError(f"download failed via curl: {detail}")
        partial.replace(target)


def raw_target_for_item(config: dict[str, Any], item: dict[str, Any]) -> Path:
    raw_dir = resolve_store_path(config, "raw_dir")
    return raw_dir / item["dataset_id"] / item["date"][:4] / item["filename"]


def mark_asset_downloaded(config: dict[str, Any], item: dict[str, Any], target: Path) -> None:
    database_path = init_database(config)
    assets_table = config.get("sink", {}).get("assets_table", "nasa_ocean_assets")
    con = duckdb.connect(str(database_path))
    try:
        con.execute(
            f"""
            UPDATE {assets_table}
            SET raw_path = ?,
                raw_bytes = ?,
                status = CASE
                    WHEN status IN ('tile_stats_ingested', 'zarr_written') THEN status
                    ELSE ?
                END,
                downloaded_at = ?
            WHERE asset_id = ?
            """,
            (str(target), target.stat().st_size, "downloaded", now_sql(), asset_id(item)),
        )
    finally:
        con.close()


def download_one_item(
    config: dict[str, Any],
    opener: urllib.request.OpenerDirector,
    item: dict[str, Any],
    *,
    replace: bool,
    timeout_seconds: int,
) -> tuple[Path, bool]:
    target = raw_target_for_item(config, item)
    if target.exists() and target.stat().st_size > 0 and not replace:
        reject_bad_download(target)
        mark_asset_downloaded(config, item, target)
        return target, False
    target.parent.mkdir(parents=True, exist_ok=True)
    if config.get("source", {}).get("download_method", "curl") == "curl":
        curl_download(config, item, target, timeout_seconds)
    else:
        try:
            with opener.open(item["download_url"], timeout=timeout_seconds) as response, target.open("wb") as fh:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"download failed HTTP {exc.code}: {item['filename']}") from exc
    reject_bad_download(target)
    mark_asset_downloaded(config, item, target)
    return target, True


def command_download(args: argparse.Namespace) -> int:
    config = load_json(args.collector_config)
    opener = earthdata_opener(config)
    manifest = load_json(args.manifest)
    max_files = args.max_files
    downloaded = 0
    for item in manifest["files"]:
        if max_files is not None and downloaded >= max_files:
            break
        target, wrote = download_one_item(config, opener, item, replace=args.replace, timeout_seconds=args.timeout_seconds)
        if wrote:
            downloaded += 1
            status = "downloaded"
        else:
            status = "exists"
        print(json.dumps({"status": status, "path": str(target), "bytes": target.stat().st_size}, ensure_ascii=False), flush=True)
    print(json.dumps({"status": "download_complete", "downloaded": downloaded}, ensure_ascii=False))
    return 0


def get_asset_status(config: dict[str, Any], item: dict[str, Any]) -> str | None:
    database_path = init_database(config)
    assets_table = config.get("sink", {}).get("assets_table", "nasa_ocean_assets")
    con = duckdb.connect(str(database_path))
    try:
        row = con.execute(
            f"SELECT status FROM {assets_table} WHERE asset_id = ? LIMIT 1",
            (asset_id(item),),
        ).fetchone()
    finally:
        con.close()
    return row[0] if row else None


def zarr_target_for_raw(config: dict[str, Any], source_path: Path) -> Path:
    zarr_dir = resolve_store_path(config, "zarr_dir")
    return zarr_dir / (source_path.stem + ".zarr")


def command_pipeline(args: argparse.Namespace) -> int:
    config = load_json(args.collector_config)
    database_path = init_database(config)
    manifest = load_json(args.manifest)
    files = manifest.get("files", [])
    if args.max_files is not None:
        files = files[: args.max_files]

    command_ingest_manifest(
        argparse.Namespace(
            collector_config=args.collector_config,
            manifest=args.manifest,
            replace=args.replace_manifest,
        )
    )
    opener = earthdata_opener(config)

    counters = {
        "total": len(files),
        "downloaded": 0,
        "raw_exists": 0,
        "zarr_written": 0,
        "zarr_exists": 0,
        "grid_ingested": 0,
        "skipped_done": 0,
        "errors": 0,
    }
    print(
        json.dumps(
            {
                "status": "pipeline_started",
                "database": str(database_path),
                "files": len(files),
                "replace": args.replace,
                "tile_degrees": args.tile_degrees,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    for index, item in enumerate(files, start=1):
        current_asset_id = asset_id(item)
        asset_start = time.perf_counter()
        try:
            status = get_asset_status(config, item)
            if status == "tile_stats_ingested" and not args.replace:
                counters["skipped_done"] += 1
                print(
                    json.dumps(
                        {
                            "status": "pipeline_skip_done",
                            "index": index,
                            "total": counters["total"],
                            "asset_id": current_asset_id,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                continue

            raw_path, wrote_raw = download_one_item(
                config,
                opener,
                item,
                replace=args.replace,
                timeout_seconds=args.timeout_seconds,
            )
            counters["downloaded" if wrote_raw else "raw_exists"] += 1

            zarr_path = zarr_target_for_raw(config, raw_path)
            if args.skip_zarr:
                zarr_status = "zarr_skipped"
            elif zarr_path.exists() and not args.replace:
                counters["zarr_exists"] += 1
                zarr_status = "zarr_exists"
            else:
                command_to_zarr(
                    argparse.Namespace(
                        collector_config=args.collector_config,
                        path=str(raw_path),
                        output=str(zarr_path),
                    )
                )
                counters["zarr_written"] += 1
                zarr_status = "zarr_written"

            command_ingest_grid(
                argparse.Namespace(
                    collector_config=args.collector_config,
                    path=str(raw_path),
                    variable=item.get("variable"),
                    tile_degrees=args.tile_degrees,
                    replace=True,
                )
            )
            counters["grid_ingested"] += 1
            print(
                json.dumps(
                    {
                        "status": "pipeline_asset_complete",
                        "index": index,
                        "total": counters["total"],
                        "asset_id": current_asset_id,
                        "raw": "downloaded" if wrote_raw else "exists",
                        "zarr": zarr_status,
                        "elapsed_seconds": round(time.perf_counter() - asset_start, 3),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as exc:
            counters["errors"] += 1
            print(
                json.dumps(
                    {
                        "status": "pipeline_asset_error",
                        "index": index,
                        "total": counters["total"],
                        "asset_id": current_asset_id,
                        "error": str(exc),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            if args.stop_on_error or counters["errors"] >= args.max_errors:
                raise

    print(json.dumps({"status": "pipeline_complete", **counters}, ensure_ascii=False), flush=True)
    return 0


def command_inspect(args: argparse.Namespace) -> int:
    import xarray as xr

    path = Path(args.path)
    dataset = xr.open_dataset(path, chunks={})
    try:
        variables = {}
        for name, var in dataset.variables.items():
            variables[name] = {
                "dims": list(var.dims),
                "shape": list(var.shape),
                "dtype": str(var.dtype),
                "attrs": {key: str(value) for key, value in var.attrs.items()},
            }
        packet = {
            "path": str(path),
            "dims": {key: int(value) for key, value in dataset.sizes.items()},
            "data_vars": list(dataset.data_vars),
            "coords": list(dataset.coords),
            "variables": variables,
            "attrs": {key: str(value) for key, value in dataset.attrs.items()},
        }
        print(json.dumps(packet, ensure_ascii=False, indent=2))
    finally:
        dataset.close()
    return 0


def command_to_zarr(args: argparse.Namespace) -> int:
    import xarray as xr

    config = load_json(args.collector_config)
    database_path = init_database(config)
    assets_table = config.get("sink", {}).get("assets_table", "nasa_ocean_assets")
    zarr_dir = resolve_store_path(config, "zarr_dir")
    source_path = Path(args.path)
    if not source_path.exists():
        raise FileNotFoundError(source_path)
    dataset = xr.open_dataset(source_path, chunks="auto")
    try:
        output = Path(args.output) if args.output else zarr_dir / (source_path.stem + ".zarr")
        if not output.is_absolute():
            output = ROOT / output
        dataset.to_zarr(output, mode="w")
        con = duckdb.connect(str(database_path))
        try:
            con.execute(
                f"""
                UPDATE {assets_table}
                SET zarr_path = ?, status = ?, zarr_written_at = ?
                WHERE filename = ?
                """,
                (str(output), "zarr_written", now_sql(), source_path.name),
            )
        finally:
            con.close()
        print(json.dumps({"status": "zarr_written", "path": str(output)}, ensure_ascii=False))
    finally:
        dataset.close()
    return 0


def lat_lon_names(dataset) -> tuple[str, str]:
    lat_candidates = ["lat", "latitude", "Latitude"]
    lon_candidates = ["lon", "longitude", "Longitude"]
    lat_name = next((name for name in lat_candidates if name in dataset.coords or name in dataset.variables), None)
    lon_name = next((name for name in lon_candidates if name in dataset.coords or name in dataset.variables), None)
    if not lat_name or not lon_name:
        raise ValueError("cannot locate latitude/longitude coordinates in dataset")
    return lat_name, lon_name


def infer_asset_from_db(config: dict[str, Any], source_path: Path) -> dict[str, Any]:
    database_path = init_database(config)
    assets_table = config.get("sink", {}).get("assets_table", "nasa_ocean_assets")
    con = duckdb.connect(str(database_path))
    try:
        row = con.execute(
            f"""
            SELECT asset_id, dataset_id, product, variable, date, zarr_path
            FROM {assets_table}
            WHERE filename = ?
            LIMIT 1
            """,
            (source_path.name,),
        ).fetchone()
    finally:
        con.close()
    if not row:
        raise ValueError(f"source file is not registered in NASA asset DB: {source_path.name}")
    return {
        "asset_id": row[0],
        "dataset_id": row[1],
        "product": row[2],
        "variable": row[3],
        "date": str(row[4]),
        "zarr_path": row[5],
    }


def command_ingest_grid(args: argparse.Namespace) -> int:
    import numpy as np
    import xarray as xr

    config = load_json(args.collector_config)
    database_path = init_database(config)
    sink = config.get("sink", {})
    assets_table = sink.get("assets_table", "nasa_ocean_assets")
    schema_table = sink.get("schema_table", "nasa_ocean_schema_snapshots")
    tile_stats_table = sink.get("tile_stats_table", "nasa_ocean_tile_stats")
    tile_degrees = float(args.tile_degrees or sink.get("default_tile_degrees", 4.0))
    source_path = Path(args.path)
    if not source_path.exists():
        raise FileNotFoundError(source_path)

    asset = infer_asset_from_db(config, source_path)
    dataset = xr.open_dataset(source_path, chunks={})
    try:
        lat_name, lon_name = lat_lon_names(dataset)
        variable_name = args.variable or asset["variable"]
        if variable_name not in dataset:
            raise ValueError(f"variable {variable_name!r} not found in {source_path}")
        data = dataset[variable_name]
        if data.ndim != 2:
            raise ValueError(f"expected 2D grid for {variable_name}, got dims={data.dims}")

        lat = np.asarray(dataset[lat_name].values, dtype=float)
        lon = np.asarray(dataset[lon_name].values, dtype=float)
        values = np.asarray(data.values, dtype=float)
        if values.shape != (lat.size, lon.size):
            # OceanColor files are usually lat x lon. Try transpose only when dims reveal lon/lat order.
            if values.shape == (lon.size, lat.size):
                values = values.T
            else:
                raise ValueError(f"grid shape {values.shape} does not match lat/lon {lat.size}x{lon.size}")

        finite = np.isfinite(values)
        valid_row_index, valid_col_index = np.where(finite)
        valid_values = values[valid_row_index, valid_col_index]
        if valid_values.size == 0:
            raise ValueError(f"no finite values found in {source_path}")

        tile_count_x = int(np.ceil(360.0 / tile_degrees))
        tile_count_y = int(np.ceil(180.0 / tile_degrees))
        lat_tile_index = np.floor((lat + 90.0) / tile_degrees).astype(np.int64)
        lon_tile_index = np.floor((lon + 180.0) / tile_degrees).astype(np.int64)
        lat_tile_index = np.clip(lat_tile_index, 0, tile_count_y - 1)
        lon_tile_index = np.clip(lon_tile_index, 0, tile_count_x - 1)
        tile_ids = lat_tile_index[valid_row_index] * tile_count_x + lon_tile_index[valid_col_index]
        tile_total = tile_count_x * tile_count_y

        counts = np.bincount(tile_ids, minlength=tile_total)
        sums = np.bincount(tile_ids, weights=valid_values, minlength=tile_total)
        mins = np.full(tile_total, np.inf, dtype=float)
        maxs = np.full(tile_total, -np.inf, dtype=float)
        np.minimum.at(mins, tile_ids, valid_values)
        np.maximum.at(maxs, tile_ids, valid_values)

        rows = []
        created_at = now_sql()
        for tile_id in np.flatnonzero(counts):
            count = int(counts[tile_id])
            tile_y = int(tile_id // tile_count_x)
            tile_x = int(tile_id % tile_count_x)
            west = -180.0 + tile_x * tile_degrees
            south = -90.0 + tile_y * tile_degrees
            east = min(west + tile_degrees, 180.0)
            north = min(south + tile_degrees, 90.0)
            rows.append(
                (
                    asset["asset_id"],
                    asset["dataset_id"],
                    asset["product"],
                    variable_name,
                    asset["date"],
                    tile_degrees,
                    tile_x,
                    tile_y,
                    float(west),
                    float(south),
                    float(east),
                    float(north),
                    count,
                    float(sums[tile_id] / count),
                    float(mins[tile_id]),
                    float(maxs[tile_id]),
                    str(source_path),
                    asset.get("zarr_path"),
                    created_at,
                )
            )
        variables = {}
        for name, var in dataset.variables.items():
            variables[name] = {
                "dims": list(var.dims),
                "shape": list(var.shape),
                "dtype": str(var.dtype),
                "attrs": {key: str(value) for key, value in var.attrs.items()},
            }
        schema_packet = {
            "dims": {key: int(value) for key, value in dataset.sizes.items()},
            "data_vars": list(dataset.data_vars),
            "coords": list(dataset.coords),
            "variables": variables,
            "attrs": {key: str(value) for key, value in dataset.attrs.items()},
        }
    finally:
        dataset.close()

    con = duckdb.connect(str(database_path))
    try:
        if args.replace:
            con.execute(f"DELETE FROM {tile_stats_table} WHERE asset_id = ?", (asset["asset_id"],))
            con.execute(f"DELETE FROM {schema_table} WHERE asset_id = ?", (asset["asset_id"],))
        con.execute(
            f"""
            INSERT INTO {schema_table}
              (asset_id, inspected_at, path, dims_json, data_vars_json, coords_json, variables_json, attrs_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                asset["asset_id"],
                created_at,
                str(source_path),
                json.dumps(schema_packet["dims"], ensure_ascii=False),
                json.dumps(schema_packet["data_vars"], ensure_ascii=False),
                json.dumps(schema_packet["coords"], ensure_ascii=False),
                json.dumps(schema_packet["variables"], ensure_ascii=False),
                json.dumps(schema_packet["attrs"], ensure_ascii=False),
            ),
        )
        con.executemany(
            f"""
            INSERT INTO {tile_stats_table}
              (asset_id, dataset_id, product, variable, date, tile_degrees, tile_x, tile_y,
               west, south, east, north, count_valid, avg_value, min_value, max_value,
               source_path, zarr_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        con.execute(
            f"""
            UPDATE {assets_table}
            SET status = ?, schema_json = ?, raw_path = ?, raw_bytes = ?, ingested_at = ?
            WHERE asset_id = ?
            """,
            (
                "tile_stats_ingested",
                json.dumps(schema_packet["dims"], ensure_ascii=False),
                str(source_path),
                source_path.stat().st_size,
                created_at,
                asset["asset_id"],
            ),
        )
    finally:
        con.close()

    print(
        json.dumps(
            {
                "status": "grid_ingested",
                "database": str(database_path),
                "asset_id": asset["asset_id"],
                "tile_degrees": tile_degrees,
                "tile_rows": len(rows),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reusable NASA OceanColor collector.")
    parser.add_argument("--collector-config", default="config/nasa_ocean_collector.example.json")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init-db", help="Initialize the NASA array read-model database.")
    init_parser.set_defaults(func=command_init_db)

    ingest_manifest_parser = subparsers.add_parser("ingest-manifest", help="Ingest a NASA manifest into the asset database.")
    ingest_manifest_parser.add_argument("--manifest", required=True)
    ingest_manifest_parser.add_argument("--replace", action="store_true")
    ingest_manifest_parser.set_defaults(func=command_ingest_manifest)

    list_parser = subparsers.add_parser("list", help="List NASA OceanColor files into a manifest.")
    list_parser.add_argument("--start-date", default=None)
    list_parser.add_argument("--end-date", default=None)
    list_parser.add_argument("--limit-days", type=int, default=None)
    list_parser.add_argument("--output", default=None)
    list_parser.set_defaults(func=command_list)

    download_parser = subparsers.add_parser("download", help="Download files from a manifest using Earthdata credentials.")
    download_parser.add_argument("--manifest", required=True)
    download_parser.add_argument("--max-files", type=int, default=None)
    download_parser.add_argument("--timeout-seconds", type=int, default=300)
    download_parser.add_argument("--replace", action="store_true")
    download_parser.set_defaults(func=command_download)

    pipeline_parser = subparsers.add_parser("pipeline", help="Run resumable download -> zarr -> tile-stat ingestion from a manifest.")
    pipeline_parser.add_argument("--manifest", required=True)
    pipeline_parser.add_argument("--max-files", type=int, default=None)
    pipeline_parser.add_argument("--timeout-seconds", type=int, default=300)
    pipeline_parser.add_argument("--tile-degrees", type=float, default=None)
    pipeline_parser.add_argument("--replace", action="store_true")
    pipeline_parser.add_argument("--replace-manifest", action="store_true")
    pipeline_parser.add_argument("--skip-zarr", action="store_true")
    pipeline_parser.add_argument("--stop-on-error", action="store_true")
    pipeline_parser.add_argument("--max-errors", type=int, default=25)
    pipeline_parser.set_defaults(func=command_pipeline)

    inspect_parser = subparsers.add_parser("inspect", help="Inspect a local NetCDF/HDF science grid file.")
    inspect_parser.add_argument("--path", required=True)
    inspect_parser.set_defaults(func=command_inspect)

    zarr_parser = subparsers.add_parser("to-zarr", help="Convert one local science grid file to Zarr.")
    zarr_parser.add_argument("--path", required=True)
    zarr_parser.add_argument("--output", default=None)
    zarr_parser.set_defaults(func=command_to_zarr)

    ingest_grid_parser = subparsers.add_parser("ingest-grid", help="Ingest one local NASA grid into tile-stat read model tables.")
    ingest_grid_parser.add_argument("--path", required=True)
    ingest_grid_parser.add_argument("--variable", default=None)
    ingest_grid_parser.add_argument("--tile-degrees", type=float, default=None)
    ingest_grid_parser.add_argument("--replace", action="store_true")
    ingest_grid_parser.set_defaults(func=command_ingest_grid)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
