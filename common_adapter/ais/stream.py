from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from typing import Any

import websocket
from websocket import WebSocketTimeoutException


DEFAULT_AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
DEFAULT_MESSAGE_TYPES = [
    "PositionReport",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
]


def setting_secret(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    if value.startswith("env:"):
        return os.environ.get(value[4:], "")
    return value


def ais_stream_settings(config: dict[str, Any]) -> dict[str, Any]:
    settings = config.get("live", {}).get("ais", {})
    return {
        "enabled": bool(settings.get("enabled", False)),
        "provider": str(settings.get("provider", "mysql")).lower(),
        "api_key": setting_secret(settings.get("api_key", "")),
        "stream_url": settings.get("stream_url", DEFAULT_AISSTREAM_URL),
        "filter_message_types": settings.get("filter_message_types", DEFAULT_MESSAGE_TYPES),
        "snapshot_interval_ms": int(settings.get("snapshot_interval_ms", 1000)),
        "stream_cache_limit": int(settings.get("stream_cache_limit", 10000)),
    }


def bbox_subscription_boxes(bboxes: list[tuple[float, float, float, float] | None]) -> list[list[list[float]]]:
    boxes = []
    for bbox in bboxes:
        if not bbox:
            boxes.append([[-90.0, -180.0], [90.0, 180.0]])
            continue
        west, south, east, north = bbox
        boxes.append([[float(south), float(west)], [float(north), float(east)]])
    return boxes


def subscription_message(settings: dict[str, Any], bboxes: list[tuple[float, float, float, float] | None]) -> dict[str, Any]:
    return {
        "APIKey": settings["api_key"],
        "BoundingBoxes": bbox_subscription_boxes(bboxes),
        "FilterMessageTypes": settings["filter_message_types"],
    }


def open_aisstream_socket(settings: dict[str, Any], bboxes: list[tuple[float, float, float, float] | None]):
    if not settings["api_key"]:
        raise RuntimeError("AISStream API key is not configured. Set live.ais.api_key or AISSTREAM_API_KEY.")
    upstream = websocket.create_connection(settings["stream_url"], timeout=10)
    upstream.send(json.dumps(subscription_message(settings, bboxes), separators=(",", ":")))
    upstream.settimeout(1)
    return upstream


def probe_aisstream(
    settings: dict[str, Any],
    *,
    bboxes: list[tuple[float, float, float, float] | None] | None = None,
    duration_seconds: float = 12.0,
) -> dict[str, Any]:
    """Run a short upstream health probe without exposing the API key."""
    started_at = time.perf_counter()
    deadline = started_at + max(3.0, min(float(duration_seconds), 30.0))
    bboxes = bboxes or [None]
    raw_messages = 0
    accepted_messages = 0
    dropped_messages = 0
    last_message_type = None
    upstream = None
    try:
        upstream = open_aisstream_socket(settings, bboxes)
        connected_at = time.perf_counter()
        while time.perf_counter() < deadline:
            try:
                raw_message = upstream.recv()
            except WebSocketTimeoutException:
                continue
            if not raw_message:
                continue
            raw_messages += 1
            try:
                packet = json.loads(raw_message)
                last_message_type = packet.get("MessageType") or last_message_type
            except json.JSONDecodeError:
                pass
            row = normalize_aisstream_message(raw_message)
            if row is None:
                dropped_messages += 1
            else:
                accepted_messages += 1
                last_message_type = row.get("message_type") or last_message_type
        if accepted_messages > 0:
            status = "ok"
            diagnosis = "AISStream returned live position frames."
        elif raw_messages > 0:
            status = "no_position_frames"
            diagnosis = "AISStream returned frames, but none were usable position messages."
        else:
            status = "no_frames"
            diagnosis = "AISStream connection stayed open but returned zero frames during the probe window."
        return {
            "status": status,
            "provider": "aisstream",
            "connected": True,
            "duration_seconds": round(time.perf_counter() - connected_at, 3),
            "total_elapsed_seconds": round(time.perf_counter() - started_at, 3),
            "subscription_box_count": len(bboxes),
            "raw_messages": raw_messages,
            "accepted_messages": accepted_messages,
            "dropped_messages": dropped_messages,
            "last_message_type": last_message_type,
            "diagnosis": diagnosis,
        }
    except Exception as exc:
        return {
            "status": "error",
            "provider": "aisstream",
            "connected": False,
            "total_elapsed_seconds": round(time.perf_counter() - started_at, 3),
            "subscription_box_count": len(bboxes),
            "raw_messages": raw_messages,
            "accepted_messages": accepted_messages,
            "dropped_messages": dropped_messages,
            "error": str(exc),
            "diagnosis": "AISStream probe failed before receiving usable live frames.",
        }
    finally:
        if upstream is not None:
            try:
                upstream.close()
            except Exception:
                pass


def _get_path(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def normalize_aisstream_message(raw_message: str) -> dict[str, Any] | None:
    try:
        packet = json.loads(raw_message)
    except json.JSONDecodeError:
        return None

    message_type = packet.get("MessageType")
    message = packet.get("Message") or {}
    metadata = packet.get("MetaData") or packet.get("Metadata") or {}
    payload = message.get(message_type) if isinstance(message, dict) and message_type else None
    if not isinstance(payload, dict):
        payload = message if isinstance(message, dict) else {}

    lat = _finite_float(payload.get("Latitude"))
    lon = _finite_float(payload.get("Longitude"))
    if lat is None:
        lat = _finite_float(metadata.get("latitude") or metadata.get("Latitude"))
    if lon is None:
        lon = _finite_float(metadata.get("longitude") or metadata.get("Longitude"))
    if lat is None or lon is None:
        return None

    mmsi = payload.get("UserID") or metadata.get("MMSI") or metadata.get("mmsi")
    if mmsi is None:
        return None

    event_time = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "mmsi": str(mmsi),
        "event_time": event_time,
        "lat": lat,
        "lon": lon,
        "speed": _finite_float(payload.get("Sog")),
        "course": _finite_float(payload.get("Cog")),
        "heading": _finite_float(payload.get("TrueHeading")),
        "name": payload.get("Name") or metadata.get("ShipName") or metadata.get("ship_name"),
        "source": "aisstream",
        "message_type": message_type,
    }


def streaming_snapshot_packet(
    rows_by_key: dict[str, dict[str, Any]],
    *,
    dropped_messages: int,
    accepted_messages: int,
    started_at: float,
    transport: str = "aisstream_websocket",
) -> dict[str, Any]:
    rows = list(rows_by_key.values())
    return {
        "status": "ok",
        "transport": transport,
        "rows": rows,
        "row_count": len(rows),
        "stream": {
            "accepted_messages": accepted_messages,
            "dropped_messages": dropped_messages,
            "age_seconds": round(time.perf_counter() - started_at, 3),
        },
        "timing": {"query_ms": 0},
    }
