from __future__ import annotations

import gzip
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, render_template, request
from flask_sock import Sock

from AisHubProvider import aishub_packet, aishub_settings, probe_aishub
from AisIngestService import (
    ais_api_key_fingerprint,
    ais_collector_handoff_status,
    ais_ingest_should_start,
    ais_sql_locked_packet,
    ais_sql_read_allowed,
    get_ais_ingest_status,
    remove_ais_collector_handoff,
    write_ais_collector_handoff,
)
from AisStreamProvider import (
    ais_stream_settings,
    probe_aisstream,
    setting_secret,
)
from AisLiveService import ais_live_packet, merged_ais_live_packet
from DatabaseConnect import (
    dataset_backend_info,
    mysql_connection,
    parse_bbox,
    query_policy,
    records_range_packet,
    records_packet,
    schema_packet,
)
from DeveloperConfigService import (
    connection_status_from_config,
    delete_managed_config,
    discover_config_files,
    load_layer_mappings,
    load_router_manifest,
    normalize_config_ref,
    read_config_json,
    resolve_config_ref,
    save_router_manifest,
    set_config_group,
    set_config_locked,
    set_config_note,
    set_layer_import,
    set_layer_mapping_enabled,
    spatial_status_from_config,
    summarize_config_file,
    unique_managed_config_path,
    upsert_layer_mapping,
    write_config_json_content,
)
from LayerContractService import build_layer_contracts
from LayerRuntimeService import dataset_layer_id, imported_layer_ids, is_layer_imported, resolve_runtime_dataset
from LodOverlayService import eez_boundary_mvt_tile_packet, eez_geojson_packet, eez_mvt_tile_packet
from RenderCapability import server_render_capability
from SchemaInspector import inspect_relational_routes
from SpatialOverlay import eez_overlay_packet, elapsed_ms, overlay_settings

SERVER_PID_FILE = Path("flask_pid.txt")


def active_websocket_config_path() -> Path | None:
    manifest = load_router_manifest()
    active_refs = set(manifest["active_configs"])
    locked_refs = set(manifest["locked_configs"])
    for path in discover_config_files():
        ref = normalize_config_ref(path)
        if ref not in active_refs:
            continue
        summary = summarize_config_file(path, active_refs, locked_refs)
        if summary.get("group") == "websocket":
            return path
    return None


def dataset_source_config(config: dict[str, Any], dataset_id: str) -> str | None:
    for fragment_path in config.get("__config_fragments", []):
        fragment, error = read_config_json(Path(fragment_path))
        if error or fragment is None:
            continue
        if dataset_id in fragment.get("datasets", {}):
            return normalize_config_ref(fragment_path)
    if dataset_id in config.get("datasets", {}):
        config_path = config.get("__config_path")
        if config_path:
            try:
                return normalize_config_ref(config_path)
            except Exception:
                return str(config_path)
    return None


def ais_settings_config_path(config: dict[str, Any]) -> Path:
    websocket_path = active_websocket_config_path()
    if websocket_path:
        return websocket_path
    config_path = Path(config.get("__config_path") or "config/adapter.local.json")
    if not config_path.is_absolute():
        config_path = Path(__file__).resolve().parent / config_path
    return config_path


def active_config_files_by_group(group: str) -> list[tuple[str, Path, dict[str, Any]]]:
    manifest = load_router_manifest()
    active_refs = set(manifest["active_configs"])
    locked_refs = set(manifest["locked_configs"])
    rows: list[tuple[str, Path, dict[str, Any]]] = []
    for path in discover_config_files():
        ref = normalize_config_ref(path)
        if ref not in active_refs:
            continue
        summary = summarize_config_file(path, active_refs, locked_refs)
        if summary.get("group") != group:
            continue
        data, error = read_config_json(path)
        if error or data is None:
            continue
        rows.append((ref, path, data))
    return rows


def route_provided_layer_rows() -> list[dict[str, Any]]:
    manifest = load_router_manifest()
    imported_layers = imported_layer_ids()
    contracts = build_layer_contracts(
        database_routes=active_config_files_by_group("database"),
        websocket_routes=active_config_files_by_group("websocket"),
        spatial_routes=active_config_files_by_group("spatial"),
    )
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for contract in contracts:
        layer_id = str(contract.get("layer_id") or "").strip().lower()
        if not layer_id or layer_id in seen:
            continue
        seen.add(layer_id)
        rows.append({**contract, "imported": layer_id in imported_layers})
    return rows


def port_is_busy(host: str, port: int) -> bool:
    probe_host = "127.0.0.1" if host in {"0.0.0.0", ""} else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((probe_host, port)) == 0


def windows_pids_listening_on_port(port: int) -> set[int]:
    output = subprocess.check_output(
        ["netstat", "-ano", "-p", "tcp"],
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    pids: set[int] = set()
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        local_address, state, pid_text = parts[1], parts[3].upper(), parts[4]
        if state != "LISTENING" or not local_address.endswith(f":{port}"):
            continue
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid != os.getpid():
            pids.add(pid)
    return pids


def free_configured_port_if_needed(host: str, port: int, *, enabled: bool) -> None:
    if not enabled or not port_is_busy(host, port):
        return
    if sys.platform != "win32":
        raise RuntimeError(f"port {port} is busy; automatic port cleanup is only implemented on Windows")

    pids = windows_pids_listening_on_port(port)
    if not pids:
        raise RuntimeError(f"port {port} is busy, but no listening PID was found")
    for pid in sorted(pids):
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], check=True)
    time.sleep(0.5)
    if port_is_busy(host, port):
        raise RuntimeError(f"port {port} is still busy after killing PID(s): {sorted(pids)}")


def read_server_pid_file() -> dict[str, Any] | None:
    if not SERVER_PID_FILE.exists():
        return None
    raw = SERVER_PID_FILE.read_text(encoding="utf-8", errors="ignore").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    try:
        return {"pid": int(raw)}
    except ValueError:
        return None


def windows_command_line_for_pid(pid: int) -> str:
    script = (
        "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = "
        + str(pid)
        + "\"; if ($p) { $p.CommandLine }"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    return completed.stdout.strip()


def process_looks_like_this_server(pid: int, previous: dict[str, Any]) -> bool:
    if sys.platform != "win32":
        return True
    command_line = windows_command_line_for_pid(pid).replace("\\", "/").lower()
    if not command_line:
        return False
    previous_cwd = str(previous.get("cwd") or Path.cwd()).replace("\\", "/").lower()
    current_cwd = str(Path.cwd()).replace("\\", "/").lower()
    has_entrypoint = "core.py" in command_line
    has_expected_cwd = previous_cwd in command_line or current_cwd in command_line
    has_python = "python" in command_line
    return has_entrypoint and (has_expected_cwd or has_python)


def force_exit_previous_server_instance(*, enabled: bool) -> None:
    if not enabled:
        return
    previous = read_server_pid_file()
    if not previous:
        return
    try:
        previous_pid = int(previous["pid"])
    except (KeyError, TypeError, ValueError):
        return
    if previous_pid <= 0 or previous_pid == os.getpid():
        return
    if not process_looks_like_this_server(previous_pid, previous):
        return
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(previous_pid), "/T", "/F"], check=False, capture_output=True)
        time.sleep(0.5)
        return
    try:
        os.kill(previous_pid, 9)
    except OSError:
        return
    time.sleep(0.5)


def write_server_pid_file(*, host: str, port: int, developer_port: int | None = None) -> None:
    payload = {
        "pid": os.getpid(),
        "cwd": str(Path.cwd()),
        "host": host,
        "port": port,
        "developer_port": developer_port,
        "started_at": int(time.time()),
    }
    SERVER_PID_FILE.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="ascii")


def public_url(host: str, port: int) -> str:
    display_host = "127.0.0.1" if host in {"0.0.0.0", ""} else host
    return f"http://{display_host}:{port}"


def register_developer_routes(app: Flask) -> None:
    @app.get("/api/developer/configs")
    def developer_configs():
        try:
            manifest = load_router_manifest()
            active_refs = set(manifest["active_configs"])
            locked_refs = set(manifest["locked_configs"])
            files = [summarize_config_file(path, active_refs, locked_refs) for path in discover_config_files()]
            return jsonify({"manifest": manifest, "configs": files})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/configs/content")
    def developer_config_content():
        try:
            config_ref = request.args.get("path", "")
            path = resolve_config_ref(config_ref)
            if not path.exists():
                return jsonify({"error": "config file not found"}), 404
            data, error = read_config_json(path)
            return jsonify(
                {
                    "path": normalize_config_ref(path),
                    "name": path.name,
                    "parse_ok": error is None,
                    "error": error,
                    "content": path.read_text(encoding="utf-8"),
                    "summary": summarize_config_file(
                        path,
                        set(load_router_manifest()["active_configs"]),
                        set(load_router_manifest()["locked_configs"]),
                    ),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.put("/api/developer/configs/content")
    def developer_config_content_update():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            content = str(payload.get("content") or "")
            return jsonify(write_config_json_content(config_ref, content))
        except json.JSONDecodeError as exc:
            return jsonify({"error": f"invalid JSON: {exc}"}), 400
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/import")
    def developer_config_import():
        try:
            uploaded = request.files.get("config")
            if uploaded is None or not uploaded.filename:
                return jsonify({"error": "missing config file"}), 400
            raw = uploaded.read()
            if len(raw) > 1024 * 1024:
                return jsonify({"error": "config file is larger than 1 MB"}), 400
            text = raw.decode("utf-8-sig")
            parsed = json.loads(text)
            if not isinstance(parsed, dict):
                return jsonify({"error": "config root must be a JSON object"}), 400
            destination = unique_managed_config_path(uploaded.filename)
            destination.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            group = str(request.form.get("group") or "")
            if group:
                set_config_group(str(destination), group)
            manifest = load_router_manifest()
            active_refs = set(manifest["active_configs"])
            locked_refs = set(manifest["locked_configs"])
            return jsonify(
                {
                    "status": "ok",
                    "config": summarize_config_file(destination, active_refs, locked_refs),
                    "message": f"已匯入 {destination.name}",
                }
            )
        except UnicodeDecodeError:
            return jsonify({"error": "config file must be UTF-8 JSON"}), 400
        except json.JSONDecodeError as exc:
            return jsonify({"error": f"invalid JSON: {exc}"}), 400
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/active")
    def developer_config_active():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            active = bool(payload.get("active"))
            path = resolve_config_ref(config_ref)
            if not path.exists():
                return jsonify({"error": "config file not found"}), 404
            if path.name.endswith(".example.json"):
                return jsonify({"error": "example config is demo-only and cannot be activated"}), 400
            summary = summarize_config_file(path, set(), set())
            if summary.get("group") == "demo":
                return jsonify({"error": "demo config cannot be activated as a route"}), 400
            data, error = read_config_json(path)
            if active and (error or data is None):
                return jsonify({"error": f"invalid config JSON: {error}"}), 400
            manifest = load_router_manifest()
            active_refs = set(manifest["active_configs"])
            normalized = normalize_config_ref(path)
            if active:
                active_refs.add(normalized)
            else:
                active_refs.discard(normalized)
            save_router_manifest(
                {
                    "active_configs": sorted(active_refs),
                    "locked_configs": manifest["locked_configs"],
                    "config_notes": manifest.get("config_notes") or {},
                    "config_groups": manifest.get("config_groups") or {},
                }
            )
            updated_manifest = load_router_manifest()
            return jsonify({"status": "ok", "manifest": updated_manifest})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/locked")
    def developer_config_locked():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            locked = bool(payload.get("locked"))
            return jsonify(set_config_locked(config_ref, locked))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/note")
    def developer_config_note():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            note = str(payload.get("note") or "")
            return jsonify(set_config_note(config_ref, note))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/group")
    def developer_config_group():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            group = str(payload.get("group") or "")
            return jsonify(set_config_group(config_ref, group))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.delete("/api/developer/configs")
    def developer_config_delete():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            return jsonify({"status": "ok", **delete_managed_config(config_ref)})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/router-status")
    def developer_router_status():
        try:
            manifest = load_router_manifest()
            active_refs = set(manifest["active_configs"])
            rows: list[dict[str, Any]] = []
            for path in discover_config_files():
                if path.name.endswith(".example.json"):
                    continue
                ref = normalize_config_ref(path)
                if ref not in active_refs:
                    continue
                summary = summarize_config_file(path, active_refs, set(manifest["locked_configs"]))
                if summary.get("group") != "database":
                    continue
                data, error = read_config_json(path)
                if error or data is None:
                    rows.append(
                        {
                            "config_path": ref,
                            "connection_ref": "-",
                            "backend": "unknown",
                            "enabled": ref in active_refs,
                            "connected": False,
                            "detail": error,
                        }
                    )
                    continue
                rows.extend(connection_status_from_config(ref, data, ref in active_refs))
            return jsonify({"manifest": manifest, "rows": rows})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/websocket-status")
    def developer_websocket_status():
        try:
            manifest = load_router_manifest()
            active_refs = set(manifest["active_configs"])
            locked_refs = set(manifest["locked_configs"])
            rows: list[dict[str, Any]] = []
            for path in discover_config_files():
                ref = normalize_config_ref(path)
                if ref not in active_refs:
                    continue
                summary = summarize_config_file(path, active_refs, locked_refs)
                if summary.get("group") != "websocket":
                    continue
                data, error = read_config_json(path)
                provider = "-"
                endpoint = "-"
                configured = False
                enabled = False
                if data:
                    live_ais = data.get("live", {}).get("ais", {}) if isinstance(data.get("live"), dict) else {}
                    provider = str(
                        data.get("provider")
                        or data.get("stream_provider")
                        or live_ais.get("provider")
                        or "websocket"
                    )
                    endpoint = str(
                        data.get("stream_url")
                        or data.get("url")
                        or data.get("endpoint")
                        or live_ais.get("stream_url")
                        or "-"
                    )
                    ingest = data.get("ingest") if isinstance(data.get("ingest"), dict) else {}
                    enabled = bool(ingest.get("enabled", live_ais.get("enabled", True)))
                    configured = bool(provider and endpoint != "-")
                rows.append(
                    {
                        "config_path": ref,
                        "provider": provider,
                        "endpoint": endpoint,
                        "enabled": enabled,
                        "configured": configured and not error,
                        "detail": error or ("設定可用" if configured else "缺少 provider 或 endpoint"),
                    }
                )
            return jsonify({"manifest": manifest, "rows": rows})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/spatial-status")
    def developer_spatial_status():
        try:
            manifest = load_router_manifest()
            active_refs = set(manifest["active_configs"])
            locked_refs = set(manifest["locked_configs"])
            rows: list[dict[str, Any]] = []
            for path in discover_config_files():
                if path.name.endswith(".example.json"):
                    continue
                ref = normalize_config_ref(path)
                if ref not in active_refs:
                    continue
                summary = summarize_config_file(path, active_refs, locked_refs)
                if summary.get("group") != "spatial":
                    continue
                data, error = read_config_json(path)
                if error or data is None:
                    continue
                rows.extend(spatial_status_from_config(ref, data))
            return jsonify({"manifest": manifest, "rows": rows})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-imports")
    def developer_layer_imports():
        try:
            return jsonify({"manifest": load_router_manifest(), "rows": route_provided_layer_rows()})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-imports")
    def developer_layer_imports_update():
        try:
            payload = request.get_json(silent=True) or {}
            layer_id = str(payload.get("layer_id") or "")
            imported = bool(payload.get("imported"))
            result = set_layer_import(layer_id, imported)
            return jsonify({"rows": route_provided_layer_rows(), **result})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/schema-profiles")
    def developer_schema_profiles():
        try:
            return jsonify(
                {
                    "profiles": inspect_relational_routes(active_config_files_by_group("database")),
                    "mappings": load_layer_mappings()["mappings"],
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-mappings")
    def developer_layer_mappings():
        try:
            return jsonify(load_layer_mappings())
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-mappings")
    def developer_layer_mappings_upsert():
        try:
            payload = request.get_json(silent=True) or {}
            result = upsert_layer_mapping(payload)
            return jsonify(
                {
                    **result,
                    "layer_rows": route_provided_layer_rows(),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-mappings/enabled")
    def developer_layer_mappings_enabled():
        try:
            payload = request.get_json(silent=True) or {}
            mapping_id = str(payload.get("mapping_id") or "")
            enabled = bool(payload.get("enabled"))
            result = set_layer_mapping_enabled(mapping_id, enabled)
            return jsonify(
                {
                    **result,
                    "layer_rows": route_provided_layer_rows(),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-contracts")
    def developer_layer_contracts():
        try:
            return jsonify(
                {
                    "contracts": build_layer_contracts(
                        database_routes=active_config_files_by_group("database"),
                        websocket_routes=active_config_files_by_group("websocket"),
                        spatial_routes=active_config_files_by_group("spatial"),
                    )
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400


def create_app(config: dict[str, Any], *, developer_url: str | None = None) -> Flask:
    app = Flask(__name__)
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    sock = Sock(app)

    @app.after_request
    def gzip_json_response(response):
        if request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        accepts_gzip = "gzip" in request.headers.get("Accept-Encoding", "").lower()
        is_json = response.mimetype == "application/json"
        already_encoded = response.headers.get("Content-Encoding")
        if not accepts_gzip or not is_json or already_encoded or response.direct_passthrough:
            return response
        payload = response.get_data()
        if len(payload) < 2048:
            return response
        compressed = gzip.compress(payload, compresslevel=5)
        response.set_data(compressed)
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Vary"] = "Accept-Encoding"
        response.headers["Content-Length"] = str(len(compressed))
        return response

    def get_dataset(dataset_id: str) -> dict[str, Any]:
        if dataset_id not in config["datasets"]:
            raise ValueError(f"unknown dataset: {dataset_id}")
        dataset, _runtime = resolve_runtime_dataset(config, dataset_id, config["datasets"][dataset_id])
        layer_id = dataset_layer_id(dataset_id, dataset)
        if not is_layer_imported(layer_id):
            raise ValueError(f"data layer is not imported: {layer_id}")
        return dataset

    @app.get("/")
    def index():
        return render_template("index.html", developer_url=developer_url)

    @app.get("/favicon.ico")
    def favicon():
        return "", 204

    @app.get("/api/health")
    def health():
        started = time.perf_counter()
        try:
            default_dataset = config["datasets"][config.get("default_dataset")]
            backend_kind, connection_ref, connection = dataset_backend_info(config, default_dataset)
            ok = True
            db_ping_ms = None
            if backend_kind == "mysql":
                database = default_dataset.get("database") or connection["database"]
                with mysql_connection(config, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
                    cur.execute("SELECT 1 AS ok")
                    ok = cur.fetchone()["ok"] == 1
                db_ping_ms = elapsed_ms(started)
            return jsonify(
                {
                    "status": "ok" if ok else "degraded",
                    "backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                    "default_dataset_backend": {"kind": backend_kind, "connection_ref": connection_ref},
                    "datasets": sorted(config["datasets"].keys()),
                    "timing": {"db_ping_ms": db_ping_ms},
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 503

    @app.get("/api/render/capability")
    def render_capability():
        try:
            return jsonify(server_render_capability(config))
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.get("/api/datasets")
    def datasets():
        safe = {}
        policy = query_policy(config)
        imported_layers = imported_layer_ids()
        for dataset_id, dataset in config["datasets"].items():
            runtime_dataset, runtime = resolve_runtime_dataset(config, dataset_id, dataset)
            if runtime["layer_id"] not in imported_layers:
                continue
            backend_kind, connection_ref, _connection = dataset_backend_info(config, runtime_dataset)
            safe[dataset_id] = {
                "label": runtime_dataset.get("label", dataset_id),
                "backend": backend_kind,
                "connection_ref": connection_ref,
                "route_group": "database",
                "layer_id": runtime["layer_id"],
                "source_config": dataset_source_config(config, dataset_id),
                "time_column": runtime_dataset["time_column"],
                "lat_column": runtime_dataset["lat_column"],
                "lon_column": runtime_dataset["lon_column"],
                "display_columns": runtime_dataset["display_columns"],
                "metric_columns": runtime_dataset.get("metric_columns", []),
                "category_columns": runtime_dataset.get("category_columns", []),
                "runtime": runtime,
            }
        configured_default = str(config.get("default_dataset") or "")
        default_dataset = configured_default if configured_default in safe else (next(iter(safe.keys()), None))
        return jsonify(
            {
                "default_dataset": default_dataset,
                "sql_backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                "query_policy": policy,
                "datasets": safe,
                "imported_layers": sorted(imported_layers),
            }
        )

    @app.get("/api/datasets/<dataset_id>/schema")
    def schema(dataset_id: str):
        try:
            dataset = get_dataset(dataset_id)
            runtime = {
                "layer_id": dataset_layer_id(dataset_id, dataset),
                "source": dataset.get("__runtime_source", "legacy_dataset_contract"),
                "mapping_id": dataset.get("__runtime_mapping_id"),
                "config_path": dataset.get("__runtime_config_path"),
            }
            packet = schema_packet(config, dataset)
            packet["dataset_id"] = dataset_id
            packet["runtime"] = runtime
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/datasets/<dataset_id>/records")
    def records(dataset_id: str):
        request_start = time.perf_counter()
        try:
            dataset = get_dataset(dataset_id)
            runtime = {
                "layer_id": dataset_layer_id(dataset_id, dataset),
                "source": dataset.get("__runtime_source", "legacy_dataset_contract"),
                "mapping_id": dataset.get("__runtime_mapping_id"),
                "config_path": dataset.get("__runtime_config_path"),
            }
            packet = records_packet(
                config,
                dataset,
                date_value=request.args.get("date"),
                bbox=parse_bbox(request.args.get("bbox")),
                limit=request.args.get("limit", query_policy(config)["default_limit"]),
                offset=int(request.args.get("offset", "0")),
                column_profile=request.args.get("columns"),
            )
            packet["dataset_id"] = dataset_id
            packet["runtime"] = runtime
            packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/datasets/<dataset_id>/records/range")
    def records_range(dataset_id: str):
        request_start = time.perf_counter()
        try:
            dataset = get_dataset(dataset_id)
            start_date = request.args.get("start") or request.args.get("start_date")
            end_date = request.args.get("end") or request.args.get("end_date")
            if not start_date or not end_date:
                return jsonify({"error": "range records requires start and end"}), 400
            runtime = {
                "layer_id": dataset_layer_id(dataset_id, dataset),
                "source": dataset.get("__runtime_source", "legacy_dataset_contract"),
                "mapping_id": dataset.get("__runtime_mapping_id"),
                "config_path": dataset.get("__runtime_config_path"),
            }
            packet = records_range_packet(
                config,
                dataset,
                start_date=start_date,
                end_date=end_date,
                bbox=parse_bbox(request.args.get("bbox")),
                limit=request.args.get("limit", query_policy(config)["default_limit"]),
                column_profile=request.args.get("columns") or "render",
            )
            packet["dataset_id"] = dataset_id
            packet["runtime"] = runtime
            packet["timing"]["api_total_ms"] = elapsed_ms(request_start)
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/overlays/eez")
    def eez_overlay():
        try:
            zoom_arg = request.args.get("zoom")
            bbox = parse_bbox(request.args.get("bbox"))
            zoom = float(zoom_arg) if zoom_arg else None
            if overlay_settings(config).get("provider") == "postgis":
                packet = eez_geojson_packet(config, bbox=bbox, zoom=zoom)
            else:
                packet = eez_overlay_packet(config, bbox=bbox, zoom=zoom)
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/overlays/eez/tiles/<int:z>/<int:x>/<int:y>.pbf")
    def eez_tile(z: int, x: int, y: int):
        try:
            tile, meta = eez_mvt_tile_packet(config, z=z, x=x, y=y)
            response = Response(tile, mimetype="application/x-protobuf")
            response.headers["Cache-Control"] = "public, max-age=86400"
            response.headers["X-EEZ-Tile-Bytes"] = str(meta["bytes"])
            response.headers["X-EEZ-Tile-MS"] = str(meta["timing"]["tile_ms"])
            response.headers["X-EEZ-LOD"] = str(meta["lod"])
            response.headers["X-EEZ-Cache"] = str(meta["cache"])
            response.headers["X-EEZ-Source-Table"] = str(meta["table"])
            return response
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/overlays/eez/boundary/tiles/<int:z>/<int:x>/<int:y>.pbf")
    def eez_boundary_tile(z: int, x: int, y: int):
        try:
            tile, meta = eez_boundary_mvt_tile_packet(config, z=z, x=x, y=y)
            response = Response(tile, mimetype="application/x-protobuf")
            response.headers["Cache-Control"] = "public, max-age=86400"
            response.headers["X-EEZ-Tile-Bytes"] = str(meta["bytes"])
            response.headers["X-EEZ-Tile-MS"] = str(meta["timing"]["tile_ms"])
            response.headers["X-EEZ-LOD"] = str(meta["lod"])
            response.headers["X-EEZ-Cache"] = str(meta["cache"])
            response.headers["X-EEZ-Source-Table"] = str(meta["table"])
            return response
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/live/ais")
    def ais_live():
        try:
            if aishub_settings(config)["provider"] == "aishub_polling":
                packet = aishub_packet(config, bbox=parse_bbox(request.args.get("bbox")))
                return jsonify(packet)
            if not ais_sql_read_allowed(config):
                return jsonify(ais_sql_locked_packet(config)), 403
            packet = ais_live_packet(config, bbox=parse_bbox(request.args.get("bbox")))
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc), "rows": [], "row_count": 0}), 400

    @app.get("/api/live/ais/ingest/status")
    def ais_ingest_status():
        return jsonify(get_ais_ingest_status(config))

    @app.get("/api/live/ais/settings")
    def ais_settings_get():
        try:
            settings = config.get("live", {}).get("ais", {})
            ingest = get_ais_ingest_status(config)
            handoff = ais_collector_handoff_status(config)
            has_collector_key = bool(settings.get("api_key_fingerprint")) or bool(handoff.get("has_api_key"))
            return jsonify(
                {
                    "status": "ok",
                    "enabled": bool(settings.get("enabled", False)),
                    "provider": settings.get("provider", "mysql"),
                    "has_api_key": has_collector_key,
                    "has_aishub_username": bool(setting_secret(settings.get("aishub_username", ""))),
                    "stream_url": settings.get("stream_url", "wss://stream.aisstream.io/v0/stream"),
                    "aishub_url": settings.get("aishub_url", "https://data.aishub.net/ws.php"),
                    "collector_key_gate": ingest.get("key_gate"),
                    "collector_handoff": handoff,
                    "ingest": ingest,
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.get("/api/live/ais/diagnostics")
    def ais_diagnostics():
        try:
            settings = ais_stream_settings(config)
            if settings["provider"] != "aisstream":
                if settings["provider"] == "aishub_polling":
                    packet = probe_aishub(config, bbox=parse_bbox(request.args.get("bbox")))
                    return jsonify(packet)
                return jsonify(
                    {
                        "status": "not_applicable",
                        "provider": settings["provider"],
                        "diagnosis": "AIS live source is not configured for AISStream.",
                    }
                )
            if not settings["api_key"]:
                return jsonify(
                    {
                        "status": "missing_api_key",
                        "provider": "aisstream",
                        "diagnosis": "AISStream API key is not configured.",
                    }
                )
            bbox_values = request.args.getlist("bbox")
            bboxes = [parse_bbox(value) for value in bbox_values] if bbox_values else [None]
            duration = float(request.args.get("duration_seconds", "12"))
            packet = probe_aisstream(settings, bboxes=bboxes, duration_seconds=duration)
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc), "diagnosis": "AIS diagnostics failed."}), 400

    @app.post("/api/live/ais/aishub/settings")
    def aishub_settings_post():
        # Dormant fallback path: hidden from the MVP UI. Keep the endpoint for
        # later provider experiments, but do not route the main AIS flow here.
        try:
            payload = request.get_json(force=True, silent=False) or {}
            username = str(payload.get("username", "")).strip()
            if len(username) < 3:
                return jsonify({"status": "error", "error": "AISHub username is too short."}), 400
            config_path = ais_settings_config_path(config)
            data = json.loads(config_path.read_text(encoding="utf-8"))
            ais = data.setdefault("live", {}).setdefault("ais", {})
            ais["enabled"] = True
            ais["provider"] = "aishub_polling"
            ais["aishub_username"] = username
            ais["aishub_url"] = ais.get("aishub_url") or "https://data.aishub.net/ws.php"
            config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            config.setdefault("live", {}).setdefault("ais", {}).update(ais)
            return jsonify(
                {
                    "status": "ok",
                    "provider": "aishub_polling",
                    "enabled": True,
                    "has_aishub_username": True,
                    "has_api_key": bool(ais.get("api_key_fingerprint")) or bool(ais_collector_handoff_status(config).get("has_api_key")),
                    "collector_key_gate": get_ais_ingest_status(config).get("key_gate"),
                    "collector_handoff": ais_collector_handoff_status(config),
                    "message": "AISHub username saved to local config.",
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.delete("/api/live/ais/aishub/settings")
    def aishub_settings_delete():
        # Dormant fallback path: hidden from the MVP UI.
        try:
            config_path = ais_settings_config_path(config)
            data = json.loads(config_path.read_text(encoding="utf-8"))
            ais = data.setdefault("live", {}).setdefault("ais", {})
            ais["provider"] = "aisstream" if ais.get("api_key") else "mysql"
            ais["aishub_username"] = ""
            config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            config.setdefault("live", {}).setdefault("ais", {}).update(ais)
            return jsonify(
                {
                    "status": "ok",
                    "provider": ais["provider"],
                    "enabled": True,
                    "has_aishub_username": False,
                    "has_api_key": bool(ais.get("api_key_fingerprint")) or bool(ais_collector_handoff_status(config).get("has_api_key")),
                    "collector_key_gate": get_ais_ingest_status(config).get("key_gate"),
                    "collector_handoff": ais_collector_handoff_status(config),
                    "message": "AISHub username disconnected from local config.",
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.post("/api/live/ais/settings")
    def ais_settings_post():
        try:
            payload = request.get_json(force=True, silent=False) or {}
            api_key = str(payload.get("api_key", "")).strip()
            if len(api_key) < 16:
                return jsonify({"status": "error", "error": "AISStream API key is too short."}), 400
            config_path = Path(config.get("__config_path") or "config/adapter.local.json")
            if not config_path.is_absolute():
                config_path = Path(__file__).resolve().parent / config_path
            data = json.loads(config_path.read_text(encoding="utf-8"))
            ais = data.setdefault("live", {}).setdefault("ais", {})
            ais["enabled"] = True
            ais["provider"] = "aisstream"
            ais["api_key"] = ""
            ais["api_key_fingerprint"] = ais_api_key_fingerprint(api_key)
            ais["stream_url"] = ais.get("stream_url") or "wss://stream.aisstream.io/v0/stream"
            ais["filter_message_types"] = ais.get("filter_message_types") or [
                "PositionReport",
                "StandardClassBPositionReport",
                "ExtendedClassBPositionReport",
            ]
            ais["snapshot_interval_ms"] = int(ais.get("snapshot_interval_ms", 1000))
            ais["stream_cache_limit"] = int(ais.get("stream_cache_limit", 10000))
            config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            config.setdefault("live", {}).setdefault("ais", {}).update(ais)
            handoff = write_ais_collector_handoff(config, api_key)
            return jsonify(
                {
                    "status": "ok",
                    "provider": "aisstream",
                    "enabled": True,
                    "has_api_key": True,
                    "collector_key_gate": get_ais_ingest_status(config).get("key_gate"),
                    "collector_handoff": handoff,
                    "message": "AISStream collector key handed to crawler config.",
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.delete("/api/live/ais/settings")
    def ais_settings_delete():
        try:
            config_path = Path(config.get("__config_path") or "config/adapter.local.json")
            if not config_path.is_absolute():
                config_path = Path(__file__).resolve().parent / config_path
            data = json.loads(config_path.read_text(encoding="utf-8"))
            ais = data.setdefault("live", {}).setdefault("ais", {})
            ais["enabled"] = True
            ais["provider"] = "aisstream"
            ais["api_key"] = ""
            ais["api_key_fingerprint"] = ""
            config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            config.setdefault("live", {}).setdefault("ais", {}).update(ais)
            handoff = remove_ais_collector_handoff(config)
            return jsonify(
                {
                    "status": "ok",
                    "provider": "aisstream",
                    "enabled": True,
                    "has_api_key": False,
                    "collector_key_gate": get_ais_ingest_status(config).get("key_gate"),
                    "collector_handoff": handoff,
                    "message": "AISStream collector key disconnected from crawler config.",
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @sock.route("/ws/live/ais")
    def ais_live_ws(ws):
        interval_ms = max(750, min(int(request.args.get("interval_ms", "3000")), 15000))
        bboxes = [parse_bbox(value) for value in request.args.getlist("bbox")]
        if not bboxes:
            bboxes = [None]
        stream_settings = ais_stream_settings(config)
        if stream_settings["provider"] == "aisstream" and ais_ingest_should_start(config):
            sql_ais_live_ws(ws, bboxes=bboxes, interval_ms=interval_ms, config=config)
            return
        if stream_settings["provider"] == "aishub_polling":
            aishub = aishub_settings(config)
            aishub_live_ws(ws, bboxes=bboxes, interval_ms=aishub["poll_interval_seconds"] * 1000, config=config)
            return
        sql_ais_live_ws(ws, bboxes=bboxes, interval_ms=interval_ms, config=config)

    return app


def create_developer_app(config: dict[str, Any], *, consumer_url: str) -> Flask:
    app = Flask(__name__)
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    @app.after_request
    def no_store_static(response):
        if request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def developer_index():
        embedded = request.args.get("embedded") == "1"
        return render_template("developer.html", consumer_url=consumer_url, embedded=embedded)

    @app.get("/favicon.ico")
    def favicon():
        return "", 204

    register_developer_routes(app)
    return app


def sql_ais_live_ws(
    ws,
    *,
    bboxes: list[tuple[float, float, float, float] | None],
    interval_ms: int,
    config: dict[str, Any],
) -> None:
    while True:
        try:
            if not ais_sql_read_allowed(config):
                packet = ais_sql_locked_packet(config)
                packet["transport"] = "sql_ingest_websocket"
                packet["ingest"] = get_ais_ingest_status(config)
                packet["sent_at_ms"] = int(time.time() * 1000)
                ws.send(json.dumps(packet, ensure_ascii=False))
                time.sleep(interval_ms / 1000)
                continue
            packet = merged_ais_live_packet(config, bboxes=bboxes)
            packet["transport"] = "sql_ingest_websocket"
            packet["ingest"] = get_ais_ingest_status(config)
            packet["sent_at_ms"] = int(time.time() * 1000)
            ws.send(json.dumps(packet, ensure_ascii=False))
            time.sleep(interval_ms / 1000)
        except Exception as exc:
            try:
                ws.send(json.dumps({"status": "error", "error": str(exc), "rows": [], "row_count": 0}))
            except Exception:
                pass
            break


def aishub_live_ws(
    ws,
    *,
    bboxes: list[tuple[float, float, float, float] | None],
    interval_ms: int,
    config: dict[str, Any],
) -> None:
    while True:
        try:
            packets = [aishub_packet(config, bbox=bbox) for bbox in (bboxes or [None])]
            seen: set[str] = set()
            rows: list[dict[str, Any]] = []
            query_ms = 0.0
            raw_messages = 0
            dropped_messages = 0
            for packet in packets:
                query_ms += float(packet.get("timing", {}).get("query_ms", 0))
                raw_messages += int(packet.get("aishub", {}).get("raw_rows", 0))
                dropped_messages += int(packet.get("aishub", {}).get("dropped_rows", 0))
                for row in packet.get("rows", []):
                    key = f"{row.get('mmsi')}|{row.get('event_time')}|{row.get('lat')}|{row.get('lon')}"
                    if key in seen:
                        continue
                    seen.add(key)
                    rows.append(row)
            ws.send(
                json.dumps(
                    {
                        "status": "ok",
                        "transport": "aishub_polling",
                        "rows": rows,
                        "row_count": len(rows),
                        "stream": {
                            "accepted_messages": len(rows),
                            "raw_messages": raw_messages,
                            "dropped_messages": dropped_messages,
                            "poll_interval_seconds": max(180, int(interval_ms / 1000)),
                        },
                        "timing": {"query_ms": query_ms},
                        "sent_at_ms": int(time.time() * 1000),
                    },
                    ensure_ascii=False,
                )
            )
            time.sleep(max(180, int(interval_ms / 1000)))
        except Exception as exc:
            try:
                ws.send(json.dumps({"status": "error", "error": str(exc), "rows": [], "row_count": 0}))
            except Exception:
                pass
            break


def run_server(config: dict[str, Any], *, host: str, port: int, debug: bool, kill_port_if_busy: bool) -> None:
    force_exit_previous_server_instance(enabled=kill_port_if_busy)
    free_configured_port_if_needed(host, port, enabled=kill_port_if_busy)
    write_server_pid_file(host=host, port=port)
    app = create_app(config)
    app.run(host=host, port=port, debug=debug, use_reloader=False)


def run_server_pair(
    config: dict[str, Any],
    *,
    host: str,
    port: int,
    developer_port: int,
    debug: bool,
    kill_port_if_busy: bool,
) -> None:
    force_exit_previous_server_instance(enabled=kill_port_if_busy)
    free_configured_port_if_needed(host, port, enabled=kill_port_if_busy)
    free_configured_port_if_needed(host, developer_port, enabled=kill_port_if_busy)
    write_server_pid_file(host=host, port=port, developer_port=developer_port)

    consumer_url = public_url(host, port)
    developer_url = public_url(host, developer_port)
    developer_app = create_developer_app(config, consumer_url=consumer_url)
    developer_thread = threading.Thread(
        target=lambda: developer_app.run(host=host, port=developer_port, debug=debug, use_reloader=False),
        name="developer-config-server",
        daemon=True,
    )
    developer_thread.start()

    app = create_app(config, developer_url=developer_url)
    app.run(host=host, port=port, debug=debug, use_reloader=False)
