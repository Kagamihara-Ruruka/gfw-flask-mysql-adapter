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
    "ShipStaticData",
    "StaticDataReport",
]

POSITION_MESSAGE_TYPES = {
    "PositionReport",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
}


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
            diagnosis = "AISStream returned usable live vessel updates."
        elif raw_messages > 0:
            status = "no_position_frames"
            diagnosis = "AISStream returned frames, but none contained a usable vessel update."
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


def _clean_text(value: Any) -> str | None:
    text = str(value or "").strip().strip("@").strip()
    return text or None


def _event_timestamp(metadata: dict[str, Any], received_at: datetime) -> str:
    raw = metadata.get("time_utc") or metadata.get("TimeUtc") or metadata.get("timestamp")
    if isinstance(raw, datetime):
        parsed = raw
    else:
        text = str(raw or "").strip()
        if text.endswith(" UTC"):
            text = text[:-4].strip()
        try:
            parsed = datetime.fromisoformat(text) if text else received_at
        except ValueError:
            parsed = received_at
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.isoformat(timespec="milliseconds")


def _payload_name(message_type: str | None, payload: dict[str, Any]) -> str | None:
    if message_type == "StaticDataReport":
        report_a = payload.get("ReportA") if isinstance(payload.get("ReportA"), dict) else {}
        return _clean_text(report_a.get("Name"))
    return _clean_text(payload.get("Name"))


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

    mmsi = payload.get("UserID") or metadata.get("MMSI") or metadata.get("mmsi")
    if mmsi is None:
        return None

    received_at = datetime.now(timezone.utc)
    source_event_time = _event_timestamp(metadata, received_at)
    row: dict[str, Any] = {
        "mmsi": str(mmsi),
        "source_event_time": source_event_time,
        "received_at": received_at.isoformat(timespec="milliseconds"),
        "source": "aisstream",
        "message_type": message_type,
    }

    has_position = message_type in POSITION_MESSAGE_TYPES
    if has_position:
        lat = _finite_float(payload.get("Latitude"))
        lon = _finite_float(payload.get("Longitude"))
        if lat is None:
            lat = _finite_float(metadata.get("latitude") or metadata.get("Latitude"))
        if lon is None:
            lon = _finite_float(metadata.get("longitude") or metadata.get("Longitude"))
        if (
            lat is not None
            and lon is not None
            and -90.0 <= lat <= 90.0
            and -180.0 <= lon <= 180.0
        ):
            row.update({"position_event_time": source_event_time, "lat": lat, "lon": lon})
            for target, source in (
                ("speed", "Sog"),
                ("course", "Cog"),
                ("heading", "TrueHeading"),
            ):
                value = _finite_float(payload.get(source))
                if value is not None:
                    row[target] = value

    name = _payload_name(message_type, payload) or _clean_text(
        metadata.get("ShipName") or metadata.get("ship_name")
    )
    if name:
        row["static_event_time"] = source_event_time
        row["name"] = name

    if "position_event_time" not in row and "static_event_time" not in row:
        return None
    row["update_kind"] = (
        "mixed"
        if "position_event_time" in row and "static_event_time" in row
        else "position"
        if "position_event_time" in row
        else "static"
    )
    return row


def merge_ais_updates(
    current: dict[str, Any] | None,
    incoming: dict[str, Any],
) -> dict[str, Any]:
    """Merge independent AIS deltas without treating absent fields as nulls."""
    if current is None:
        return dict(incoming)
    if str(current.get("mmsi")) != str(incoming.get("mmsi")):
        raise ValueError("AIS updates can only be merged for the same MMSI")

    merged = dict(current)
    for prefix, fields in (
        ("position", ("lat", "lon", "speed", "course", "heading")),
        ("static", ("name",)),
    ):
        timestamp_key = f"{prefix}_event_time"
        incoming_time = str(incoming.get(timestamp_key) or "")
        current_time = str(merged.get(timestamp_key) or "")
        if not incoming_time or (current_time and incoming_time < current_time):
            continue
        merged[timestamp_key] = incoming_time
        for field in fields:
            if field in incoming:
                merged[field] = incoming[field]

    incoming_received = str(incoming.get("received_at") or "")
    if incoming_received >= str(merged.get("received_at") or ""):
        for field in ("received_at", "source_event_time", "source", "message_type"):
            if field in incoming:
                merged[field] = incoming[field]
    merged["update_kind"] = (
        "mixed"
        if "position_event_time" in merged and "static_event_time" in merged
        else "position"
        if "position_event_time" in merged
        else "static"
    )
    return merged


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
