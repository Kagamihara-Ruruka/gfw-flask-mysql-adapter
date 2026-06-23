from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_AISHUB_URL = "https://data.aishub.net/ws.php"
AISHUB_POLL_INTERVAL_SECONDS = 180


def setting_secret(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    if value.startswith("env:"):
        return os.environ.get(value[4:], "")
    return value


def aishub_settings(config: dict[str, Any]) -> dict[str, Any]:
    settings = config.get("live", {}).get("ais", {})
    return {
        "enabled": bool(settings.get("enabled", False)),
        "provider": str(settings.get("provider", "mysql")).lower(),
        "username": setting_secret(settings.get("aishub_username", "")),
        "api_url": settings.get("aishub_url", DEFAULT_AISHUB_URL),
        "poll_interval_seconds": AISHUB_POLL_INTERVAL_SECONDS,
        "max_age_minutes": max(1, int(settings.get("max_age_minutes", 60))),
    }


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _aishub_coordinate(value: Any) -> float | None:
    number = _finite_float(value)
    if number is None:
        return None
    if abs(number) > 1800:
        return number / 600000.0
    return number


def _aishub_time(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if text.isdigit():
            return datetime.fromtimestamp(int(text), tz=timezone.utc).isoformat(timespec="seconds")
        return text
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat(timespec="seconds")
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_aishub_row(row: dict[str, Any]) -> dict[str, Any] | None:
    lat = _aishub_coordinate(row.get("LATITUDE"))
    lon = _aishub_coordinate(row.get("LONGITUDE"))
    mmsi = row.get("MMSI")
    if lat is None or lon is None or mmsi in (None, ""):
        return None
    return {
        "mmsi": str(mmsi),
        "event_time": _aishub_time(row.get("TIME") or row.get("TSTAMP")),
        "lat": lat,
        "lon": lon,
        "speed": _finite_float(row.get("SOG")),
        "course": _finite_float(row.get("COG")),
        "heading": _finite_float(row.get("HEADING")),
        "name": row.get("NAME") or None,
        "source": "aishub",
        "message_type": "AISHubPosition",
    }


def _response_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("data", "rows", "vessels"):
            value = payload.get(key)
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
        if "MMSI" in payload:
            return [payload]
    return []


def fetch_aishub_rows(
    settings: dict[str, Any],
    *,
    bbox: tuple[float, float, float, float] | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not settings["username"]:
        raise RuntimeError("AISHub username is not configured.")
    params: dict[str, Any] = {
        "username": settings["username"],
        "format": 1,
        "output": "json",
        "compress": 0,
        "interval": settings["max_age_minutes"],
    }
    if bbox:
        west, south, east, north = bbox
        params.update({"latmin": south, "latmax": north, "lonmin": west, "lonmax": east})
    url = f"{settings['api_url']}?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": "RRKAL-local-map/0.1"})
    with urlopen(request, timeout=20) as response:
        raw = response.read()
        status_code = getattr(response, "status", 200)
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return [], {"http_status": status_code, "raw_bytes": len(raw), "empty_response": True}
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"AISHub returned non-JSON response: {text[:160]}") from exc
    if isinstance(payload, dict) and any(key.lower() == "error" for key in payload.keys()):
        raise RuntimeError(f"AISHub error response: {payload}")
    rows = []
    dropped = 0
    for raw_row in _response_rows(payload):
        row = normalize_aishub_row(raw_row)
        if row is None:
            dropped += 1
        else:
            rows.append(row)
    return rows, {
        "http_status": status_code,
        "raw_bytes": len(raw),
        "raw_rows": len(_response_rows(payload)),
        "dropped_rows": dropped,
        "empty_response": False,
    }


def aishub_packet(
    config: dict[str, Any],
    *,
    bbox: tuple[float, float, float, float] | None,
) -> dict[str, Any]:
    settings = aishub_settings(config)
    started = time.perf_counter()
    rows, meta = fetch_aishub_rows(settings, bbox=bbox)
    return {
        "status": "ok",
        "transport": "aishub_polling",
        "rows": rows,
        "row_count": len(rows),
        "source_filter": {"provider": "aishub"},
        "aishub": meta,
        "timing": {"query_ms": round((time.perf_counter() - started) * 1000, 3)},
    }


def probe_aishub(
    config: dict[str, Any],
    *,
    bbox: tuple[float, float, float, float] | None,
) -> dict[str, Any]:
    started = time.perf_counter()
    settings = aishub_settings(config)
    if not settings["username"]:
        return {
            "status": "missing_username",
            "provider": "aishub",
            "connected": False,
            "diagnosis": "AISHub username is not configured.",
        }
    try:
        rows, meta = fetch_aishub_rows(settings, bbox=bbox)
        status = "ok" if rows else "empty"
        diagnosis = "AISHub returned vessel rows." if rows else "AISHub returned no vessel rows for this probe."
        return {
            "status": status,
            "provider": "aishub",
            "connected": True,
            "accepted_messages": len(rows),
            "raw_messages": int(meta.get("raw_rows", 0)),
            "dropped_messages": int(meta.get("dropped_rows", 0)),
            "total_elapsed_seconds": round(time.perf_counter() - started, 3),
            "diagnosis": diagnosis,
            "meta": meta,
        }
    except Exception as exc:
        return {
            "status": "error",
            "provider": "aishub",
            "connected": False,
            "accepted_messages": 0,
            "raw_messages": 0,
            "dropped_messages": 0,
            "total_elapsed_seconds": round(time.perf_counter() - started, 3),
            "error": str(exc),
            "diagnosis": "AISHub probe failed.",
        }
