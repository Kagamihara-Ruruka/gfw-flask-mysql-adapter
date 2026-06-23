from __future__ import annotations

import gzip
import os
import socket
import subprocess
import sys
import time
from typing import Any

from flask import Flask, Response, jsonify, render_template, request

from AisLiveService import ais_live_packet
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
            packet = ais_live_packet(config, bbox=parse_bbox(request.args.get("bbox")))
            return jsonify(packet)
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc), "rows": [], "row_count": 0}), 400

    return app


def run_server(config: dict[str, Any], *, host: str, port: int, debug: bool, kill_port_if_busy: bool) -> None:
    free_configured_port_if_needed(host, port, enabled=kill_port_if_busy)
    app = create_app(config)
    app.run(host=host, port=port, debug=debug, use_reloader=False)
