from __future__ import annotations

import gzip
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, render_template, request
from flask_sock import Sock
from websocket import WebSocketTimeoutException

from AisHubProvider import aishub_packet, aishub_settings, probe_aishub
from AisStreamProvider import (
    ais_stream_settings,
    normalize_aisstream_message,
    open_aisstream_socket,
    probe_aisstream,
    setting_secret,
    streaming_snapshot_packet,
)
from AisLiveService import ais_live_packet, merged_ais_live_packet
from DatabaseConnect import (
    mysql_connection,
    parse_bbox,
    query_policy,
    records_packet,
    schema_packet,
)
from LodOverlayService import eez_boundary_mvt_tile_packet, eez_geojson_packet, eez_mvt_tile_packet
from SpatialOverlay import eez_overlay_packet, elapsed_ms, overlay_settings


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


def create_app(config: dict[str, Any]) -> Flask:
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
        return config["datasets"][dataset_id]

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/favicon.ico")
    def favicon():
        return "", 204

    @app.get("/api/health")
    def health():
        started = time.perf_counter()
        try:
            with mysql_connection(config, config["mysql"]["database"], dict_cursor=True) as conn, conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                ok = cur.fetchone()["ok"] == 1
            return jsonify(
                {
                    "status": "ok" if ok else "degraded",
                    "backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                    "datasets": sorted(config["datasets"].keys()),
                    "timing": {"db_ping_ms": elapsed_ms(started)},
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 503

    @app.get("/api/datasets")
    def datasets():
        safe = {}
        policy = query_policy(config)
        for dataset_id, dataset in config["datasets"].items():
            safe[dataset_id] = {
                "label": dataset.get("label", dataset_id),
                "time_column": dataset["time_column"],
                "lat_column": dataset["lat_column"],
                "lon_column": dataset["lon_column"],
                "display_columns": dataset["display_columns"],
                "metric_columns": dataset.get("metric_columns", []),
                "category_columns": dataset.get("category_columns", []),
            }
        return jsonify(
            {
                "default_dataset": config.get("default_dataset"),
                "sql_backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                "query_policy": policy,
                "datasets": safe,
            }
        )

    @app.get("/api/datasets/<dataset_id>/schema")
    def schema(dataset_id: str):
        try:
            dataset = get_dataset(dataset_id)
            packet = schema_packet(config, dataset)
            packet["dataset_id"] = dataset_id
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/datasets/<dataset_id>/records")
    def records(dataset_id: str):
        request_start = time.perf_counter()
        try:
            dataset = get_dataset(dataset_id)
            packet = records_packet(
                config,
                dataset,
                date_value=request.args.get("date"),
                bbox=parse_bbox(request.args.get("bbox")),
                limit=int(request.args.get("limit", str(query_policy(config)["default_limit"]))),
                offset=int(request.args.get("offset", "0")),
            )
            packet["dataset_id"] = dataset_id
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
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-EEZ-Tile-Bytes"] = str(meta["bytes"])
            response.headers["X-EEZ-Tile-MS"] = str(meta["timing"]["tile_ms"])
            response.headers["X-EEZ-LOD"] = str(meta["lod"])
            response.headers["X-EEZ-Source-Table"] = str(meta["table"])
            return response
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/overlays/eez/boundary/tiles/<int:z>/<int:x>/<int:y>.pbf")
    def eez_boundary_tile(z: int, x: int, y: int):
        try:
            tile, meta = eez_boundary_mvt_tile_packet(config, z=z, x=x, y=y)
            response = Response(tile, mimetype="application/x-protobuf")
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-EEZ-Tile-Bytes"] = str(meta["bytes"])
            response.headers["X-EEZ-Tile-MS"] = str(meta["timing"]["tile_ms"])
            response.headers["X-EEZ-LOD"] = str(meta["lod"])
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
            packet = ais_live_packet(config, bbox=parse_bbox(request.args.get("bbox")))
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc), "rows": [], "row_count": 0}), 400

    @app.get("/api/live/ais/settings")
    def ais_settings_get():
        try:
            settings = config.get("live", {}).get("ais", {})
            return jsonify(
                {
                    "status": "ok",
                    "enabled": bool(settings.get("enabled", False)),
                    "provider": settings.get("provider", "mysql"),
                    "has_api_key": bool(setting_secret(settings.get("api_key", ""))),
                    "has_aishub_username": bool(setting_secret(settings.get("aishub_username", ""))),
                    "stream_url": settings.get("stream_url", "wss://stream.aisstream.io/v0/stream"),
                    "aishub_url": settings.get("aishub_url", "https://data.aishub.net/ws.php"),
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
        try:
            payload = request.get_json(force=True, silent=False) or {}
            username = str(payload.get("username", "")).strip()
            if len(username) < 3:
                return jsonify({"status": "error", "error": "AISHub username is too short."}), 400
            config_path = Path(config.get("__config_path") or "config/adapter.local.json")
            if not config_path.is_absolute():
                config_path = Path(__file__).resolve().parent / config_path
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
                    "has_api_key": bool(setting_secret(ais.get("api_key", ""))),
                    "message": "AISHub username saved to local config.",
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.delete("/api/live/ais/aishub/settings")
    def aishub_settings_delete():
        try:
            config_path = Path(config.get("__config_path") or "config/adapter.local.json")
            if not config_path.is_absolute():
                config_path = Path(__file__).resolve().parent / config_path
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
                    "has_api_key": bool(setting_secret(ais.get("api_key", ""))),
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
            ais["api_key"] = api_key
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
            return jsonify(
                {
                    "status": "ok",
                    "provider": "aisstream",
                    "enabled": True,
                    "has_api_key": True,
                    "message": "AISStream key saved to local config.",
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
            config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            config.setdefault("live", {}).setdefault("ais", {}).update(ais)
            return jsonify(
                {
                    "status": "ok",
                    "provider": "aisstream",
                    "enabled": True,
                    "has_api_key": False,
                    "message": "AISStream key disconnected from local config.",
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
        if stream_settings["provider"] == "aisstream":
            aisstream_live_ws(ws, bboxes=bboxes, settings=stream_settings)
            return
        if stream_settings["provider"] == "aishub_polling":
            aishub = aishub_settings(config)
            aishub_live_ws(ws, bboxes=bboxes, interval_ms=aishub["poll_interval_seconds"] * 1000, config=config)
            return
        while True:
            try:
                packet = merged_ais_live_packet(config, bboxes=bboxes)
                packet["transport"] = "websocket"
                packet["sent_at_ms"] = int(time.time() * 1000)
                ws.send(json.dumps(packet, ensure_ascii=False))
                time.sleep(interval_ms / 1000)
            except Exception as exc:
                try:
                    ws.send(json.dumps({"status": "error", "error": str(exc), "rows": [], "row_count": 0}))
                except Exception:
                    pass
                break

    return app


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


def aisstream_live_ws(ws, *, bboxes: list[tuple[float, float, float, float] | None], settings: dict[str, Any]) -> None:
    rows_by_key: dict[str, dict[str, Any]] = {}
    dropped_messages = 0
    accepted_messages = 0
    started_at = time.perf_counter()
    last_sent = 0.0
    snapshot_interval = max(0.25, settings["snapshot_interval_ms"] / 1000)
    cache_limit = max(1, settings["stream_cache_limit"])
    try:
        upstream = open_aisstream_socket(settings, bboxes)
    except Exception as exc:
        ws.send(json.dumps({"status": "error", "error": str(exc), "rows": [], "row_count": 0}))
        return

    try:
        ws.send(
            json.dumps(
                {
                    "status": "warming",
                    "transport": "aisstream_websocket",
                    "rows": [],
                    "row_count": 0,
                    "message": "AISStream subscription accepted; waiting for live frames.",
                    "timing": {"query_ms": 0},
                },
                ensure_ascii=False,
            )
        )
        while True:
            try:
                raw_message = upstream.recv()
            except WebSocketTimeoutException:
                raw_message = None

            if raw_message:
                row = normalize_aisstream_message(raw_message)
                if row is None:
                    dropped_messages += 1
                else:
                    accepted_messages += 1
                    key = str(row.get("mmsi"))
                    rows_by_key[key] = row
                    while len(rows_by_key) > cache_limit:
                        oldest_key = next(iter(rows_by_key))
                        rows_by_key.pop(oldest_key, None)

            now = time.perf_counter()
            if now - last_sent >= snapshot_interval:
                packet = streaming_snapshot_packet(
                    rows_by_key,
                    dropped_messages=dropped_messages,
                    accepted_messages=accepted_messages,
                    started_at=started_at,
                )
                packet["sent_at_ms"] = int(time.time() * 1000)
                ws.send(json.dumps(packet, ensure_ascii=False))
                last_sent = now
    except Exception as exc:
        try:
            ws.send(json.dumps({"status": "error", "error": str(exc), "rows": [], "row_count": 0}))
        except Exception:
            pass
    finally:
        upstream.close()


def run_server(config: dict[str, Any], *, host: str, port: int, debug: bool, kill_port_if_busy: bool) -> None:
    free_configured_port_if_needed(host, port, enabled=kill_port_if_busy)
    app = create_app(config)
    app.run(host=host, port=port, debug=debug, use_reloader=False)
