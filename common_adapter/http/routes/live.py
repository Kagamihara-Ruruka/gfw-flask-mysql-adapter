from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

from common_adapter.ais.aishub import aishub_packet, aishub_settings, probe_aishub
from common_adapter.ais.ingest import (
    ais_api_key_fingerprint,
    ais_collector_handoff_status,
    ais_ingest_should_start,
    ais_sql_locked_packet,
    ais_sql_read_allowed,
    apply_ais_collector_handoff,
    get_ais_ingest_status,
    remove_ais_collector_handoff,
    write_ais_collector_handoff,
)
from common_adapter.ais.live import ais_live_packet, merged_ais_live_packet
from common_adapter.ais.stream import (
    ais_stream_settings,
    probe_aisstream,
    setting_secret,
)
from common_adapter.db.connect import parse_bbox
from common_adapter.developer.config_service import (
    discover_config_files,
    load_router_manifest,
    normalize_config_ref,
    summarize_config_file,
)

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_AIS_DENSITY_CELLS_PER_TILE = 8


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


def ais_settings_config_path(config: dict[str, Any]) -> Path:
    websocket_path = active_websocket_config_path()
    if websocket_path:
        return websocket_path
    config_path = Path(config.get("__config_path") or "config/runtime/adapter.local.json")
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    return config_path



class LiveRoutes:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    def register(self, app: Flask, sock: Any) -> None:
        config = self.config

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
                        "rendering": {
                            "density_cells_per_tile": max(
                                1,
                                int(settings.get("density_cells_per_tile", DEFAULT_AIS_DENSITY_CELLS_PER_TILE)),
                            ),
                        },
                    }
                )
            except Exception as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400

        @app.get("/api/live/ais/diagnostics")
        def ais_diagnostics():
            try:
                diagnostic_config = apply_ais_collector_handoff(copy.deepcopy(config))
                settings = ais_stream_settings(diagnostic_config)
                if settings["provider"] != "aisstream":
                    if settings["provider"] == "aishub_polling":
                        packet = probe_aishub(diagnostic_config, bbox=parse_bbox(request.args.get("bbox")))
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
                config_path = Path(config.get("__config_path") or "config/runtime/adapter.local.json")
                if not config_path.is_absolute():
                    config_path = ROOT / config_path
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
                config_path = Path(config.get("__config_path") or "config/runtime/adapter.local.json")
                if not config_path.is_absolute():
                    config_path = ROOT / config_path
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



def register_live_routes(app: Flask, sock: Any, config: dict[str, Any]) -> None:
    LiveRoutes(config).register(app, sock)
