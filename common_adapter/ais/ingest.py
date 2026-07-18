from __future__ import annotations

import copy
import json
import threading
import time
import hashlib
import os
import socket
import subprocess
from contextlib import contextmanager
from datetime import datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from typing import Any

from websocket import WebSocketTimeoutException

from common_adapter.ais.live import _ais_mysql_connection, ais_live_settings, ais_mysql_connection_info
from common_adapter.ais.stream import (
    ais_stream_settings,
    merge_ais_updates,
    normalize_aisstream_message,
    open_aisstream_socket,
)
from common_adapter.db.connect import mysql_connection, mysql_quote, validate_identifier
from common_adapter.query.serialization import json_ready

_WORKER: "AisIngestWorker | None" = None
_WORKER_LOCK = threading.Lock()
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COLLECTOR_CONFIG_PATH = "config/runtime/ais_collector.local.json"
COLLECTOR_PID_FILE = ROOT / "ais_ingest_pid.json"


def ais_ingest_settings(config: dict[str, Any]) -> dict[str, Any]:
    live_settings = config.get("live", {}).get("ais", {})
    return {
        "enabled": bool(live_settings.get("ingest_enabled", True)),
        "reconnect_seconds": max(30, int(live_settings.get("ingest_reconnect_seconds", 30))),
        "status_report_seconds": max(30, int(live_settings.get("ingest_status_report_seconds", 30))),
        "flush_seconds": max(0.25, float(live_settings.get("ingest_flush_seconds", 1.0))),
        "batch_size": max(1, int(live_settings.get("ingest_batch_size", 250))),
        "auto_create_table": bool(live_settings.get("ingest_auto_create_table", True)),
        "meta_table": live_settings.get("ingest_meta_table", "ais_ingest_meta"),
        "data_directory": str(live_settings.get("ingest_data_directory", "")).strip(),
        "snapshot_enabled": bool(
            live_settings.get("snapshot_enabled", live_settings.get("daily_snapshot_enabled", True))
        ),
        "snapshot_table": live_settings.get(
            "snapshot_table",
            live_settings.get("daily_snapshot_table", "ais_hourly_snapshots"),
        ),
        "snapshot_retention_days": max(
            1,
            int(live_settings.get("snapshot_retention_days", live_settings.get("daily_snapshot_retention_days", 31))),
        ),
        "snapshot_interval_hours": max(1, int(live_settings.get("snapshot_interval_hours", 1))),
        "snapshot_window_hours": max(
            1,
            int(live_settings.get("snapshot_window_hours", live_settings.get("daily_snapshot_window_hours", 1))),
        ),
    }


def _windows_command_line_for_pid(pid: int) -> str:
    if os.name != "nt":
        return ""
    command = (
        "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = "
        + str(pid)
        + "\"; if ($p) { $p.CommandLine }"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    return result.stdout.strip()


def _process_is_ais_ingest(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    command_line = _windows_command_line_for_pid(pid).replace("\\", "/").lower()
    return "core.py" in command_line and "ingest-ais" in command_line


def force_exit_previous_ais_ingest_instance() -> None:
    if not COLLECTOR_PID_FILE.exists():
        return
    try:
        raw = json.loads(COLLECTOR_PID_FILE.read_text(encoding="utf-8"))
        previous_pid = int(raw.get("pid") or 0)
    except Exception:
        return
    if previous_pid <= 0 or previous_pid == os.getpid():
        return
    if not _process_is_ais_ingest(previous_pid):
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(previous_pid), "/T", "/F"], check=False, capture_output=True)
    else:
        try:
            os.kill(previous_pid, 9)
        except OSError:
            pass


def write_ais_ingest_pid_file(config: dict[str, Any]) -> None:
    payload = {
        "pid": os.getpid(),
        "role": "ais_ingest",
        "collector_config_path": _display_path(ais_collector_handoff_path(config)),
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    COLLECTOR_PID_FILE.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="ascii")


def ais_collector_handoff_path(config: dict[str, Any]) -> Path:
    live_settings = config.get("live", {}).get("ais", {})
    raw_path = str(live_settings.get("collector_config_path") or DEFAULT_COLLECTOR_CONFIG_PATH)
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return ROOT / path


def _display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def ais_collector_handoff_status(config: dict[str, Any]) -> dict[str, Any]:
    path = ais_collector_handoff_path(config)
    status: dict[str, Any] = {
        "path": _display_path(path),
        "exists": path.exists(),
        "has_api_key": False,
        "provider": "aisstream",
    }
    if not path.exists():
        status["status"] = "missing"
        return status
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        status.update({"status": "invalid", "error_class": type(exc).__name__})
        return status
    status.update(
        {
            "status": "ready" if data.get("api_key") else "missing_api_key",
            "provider": data.get("provider", "aisstream"),
            "has_api_key": bool(data.get("api_key")),
            "written_at": data.get("written_at"),
            "schema": data.get("schema"),
        }
    )
    return status


def write_ais_collector_handoff(config: dict[str, Any], api_key: str) -> dict[str, Any]:
    """Write the local upstream crawler handoff file.

    This is intentionally separate from the map server config. The frontend
    collects the key, but the handoff belongs to the independent AIS collector.
    K8/Airflow can later replace this local file with a Secret or task variable.
    """
    if not api_key:
        raise ValueError("AIS collector API key is required.")

    path = ais_collector_handoff_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = ais_stream_settings(config)
    live = ais_live_settings(config)
    ingest = ais_ingest_settings(config)
    live_config = config.get("live", {}).get("ais", {})
    connection_ref, connection = ais_mysql_connection_info(config, live)
    payload = {
        "schema": "rrkal.ais.collector_handoff.v1",
        "role": "upstream_ais_collector",
        "provider": "aisstream",
        "api_key": api_key,
        "stream_url": stream.get("stream_url"),
        "filter_message_types": stream.get("filter_message_types"),
        "ingest": {
            "enabled": True,
            "reconnect_seconds": ingest["reconnect_seconds"],
            "status_report_seconds": ingest["status_report_seconds"],
            "flush_seconds": ingest["flush_seconds"],
            "batch_size": ingest["batch_size"],
            "auto_create_table": ingest["auto_create_table"],
            "meta_table": ingest["meta_table"],
            "data_directory": ingest["data_directory"],
            "snapshot_enabled": ingest["snapshot_enabled"],
            "snapshot_table": ingest["snapshot_table"],
            "snapshot_retention_days": ingest["snapshot_retention_days"],
            "snapshot_interval_hours": ingest["snapshot_interval_hours"],
            "snapshot_window_hours": ingest["snapshot_window_hours"],
        },
        "sql": {
            "connection_ref": connection_ref,
            "connection": connection,
            "database": live["database"],
            "table": live["table"],
            "time_column": live["time_column"],
            "static_time_column": live["static_time_column"],
            "received_time_column": live["received_time_column"],
            "lat_column": live["lat_column"],
            "lon_column": live["lon_column"],
            "mmsi_column": live["mmsi_column"],
            "speed_column": live.get("speed_column"),
            "course_column": live.get("course_column"),
            "heading_column": live.get("heading_column"),
            "name_column": live.get("name_column"),
            "source_column": live.get("source_column"),
            "include_sources": live.get("include_sources", []),
            "max_age_minutes": live.get("max_age_minutes", 60),
            "limit": live_config.get("limit", "max"),
        },
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "Local AIS crawler handoff. Do not commit this file. The map remains a SQL consumer.",
        "remote_request_boundary": (
            "AISStream is a persistent websocket source. Do not create repeated upstream "
            "requests faster than the configured reconnect/status intervals."
        ),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    status = ais_collector_handoff_status(config)
    status["status"] = "written"
    return status


def remove_ais_collector_handoff(config: dict[str, Any]) -> dict[str, Any]:
    path = ais_collector_handoff_path(config)
    if path.exists():
        path.unlink()
    return {
        "status": "removed",
        "path": _display_path(path),
        "exists": False,
        "has_api_key": False,
        "provider": "aisstream",
    }


def apply_ais_collector_handoff(config: dict[str, Any]) -> dict[str, Any]:
    path = ais_collector_handoff_path(config)
    if not path.exists():
        return config
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("provider") != "aisstream":
        return config
    ais = config.setdefault("live", {}).setdefault("ais", {})
    ais["enabled"] = True
    ais["provider"] = "aisstream"
    ais["api_key"] = data.get("api_key") or ais.get("api_key", "")
    ais["api_key_fingerprint"] = _api_key_fingerprint(ais["api_key"])
    return config


def ais_ingest_should_start(config: dict[str, Any]) -> bool:
    stream = ais_stream_settings(config)
    ingest = ais_ingest_settings(config)
    return ingest["enabled"] and stream["provider"] == "aisstream" and bool(stream["api_key"])


def _api_key_fingerprint(api_key: str) -> str:
    if not api_key:
        return ""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def ais_api_key_fingerprint(api_key: str) -> str:
    return _api_key_fingerprint(api_key)


def configured_collector_key_fingerprint(config: dict[str, Any]) -> str:
    settings = config.get("live", {}).get("ais", {})
    configured = str(settings.get("api_key_fingerprint") or "").strip()
    if configured:
        return configured
    return _api_key_fingerprint(ais_stream_settings(config)["api_key"])


def _collector_meta_table(config: dict[str, Any]) -> str:
    table = ais_ingest_settings(config)["meta_table"]
    return validate_identifier(table, "live.ais.ingest_meta_table")


def ais_collector_key_gate_status(config: dict[str, Any]) -> dict[str, Any]:
    """Internal account gate between consumer UI and upstream AIS collector.

    This is a deliberate boundary for an unavoidable upstream gap. The map is
    still only a consumer: it may read AIS SQL only when the UI-stored key
    matches the key fingerprint most recently published by the collector into
    SQL. This does not authorize the map to collect, clean, or directly consume
    upstream AISStream data. The raw key is never returned to the browser.
    """
    stream = ais_stream_settings(config)
    live = ais_live_settings(config)
    if stream["provider"] != "aisstream":
        return {
            "status": "unsupported_provider",
            "authorized_sql_read": False,
            "provider": stream["provider"],
            "message": "AIS SQL read is locked for unsupported provider configuration.",
        }
    if not live.get("enabled"):
        return {
            "status": "disabled",
            "authorized_sql_read": False,
            "provider": "aisstream",
            "message": "AIS SQL source is disabled.",
        }
    expected = configured_collector_key_fingerprint(config)
    if not expected:
        return {
            "status": "missing_ui_key_fingerprint",
            "authorized_sql_read": False,
            "provider": "aisstream",
            "message": "AIS collector key fingerprint is not configured in the UI/local config.",
        }

    database = validate_identifier(live["database"], "live.ais.database")
    meta_table = _collector_meta_table(config)
    try:
        with _ais_mysql_connection(config, live, database) as conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT api_key_fingerprint, status, last_seen_at, accepted_messages, written_rows "
                f"FROM {mysql_quote(meta_table)} WHERE service_name = %s LIMIT 1",
                ["aisstream"],
            )
            row = cur.fetchone()
    except Exception as exc:
        return {
            "status": "collector_meta_unavailable",
            "authorized_sql_read": False,
            "provider": "aisstream",
            "meta_table": meta_table,
            "message": "AIS collector metadata is unavailable; SQL read remains locked.",
            "error_class": type(exc).__name__,
        }
    if not row:
        return {
            "status": "collector_not_seen",
            "authorized_sql_read": False,
            "provider": "aisstream",
            "meta_table": meta_table,
            "message": "AIS collector has not published a key heartbeat yet; SQL read remains locked.",
        }

    actual = str(row.get("api_key_fingerprint") or "")
    last_seen = row.get("last_seen_at")
    last_seen_age = None
    if isinstance(last_seen, datetime):
        last_seen_dt = last_seen
        if last_seen_dt.tzinfo is not None:
            last_seen_dt = last_seen_dt.astimezone(timezone.utc).replace(tzinfo=None)
        last_seen_age = max(0.0, (datetime.utcnow() - last_seen_dt).total_seconds())
    key_match = bool(expected and actual and expected == actual)
    return {
        "status": "ok" if key_match else "collector_key_mismatch",
        "authorized_sql_read": key_match,
        "provider": "aisstream",
        "meta_table": meta_table,
        "collector_status": row.get("status"),
        "collector_last_seen_at": json_ready(last_seen),
        "collector_last_seen_age_seconds": None if last_seen_age is None else round(last_seen_age, 3),
        "collector_has_key_fingerprint": bool(actual),
        "ui_has_key_fingerprint": bool(expected),
        "key_match": key_match,
        "accepted_messages": int(row.get("accepted_messages") or 0),
        "written_rows": int(row.get("written_rows") or 0),
        "message": "AIS collector key matches; SQL read is unlocked."
        if key_match
        else "AIS collector key mismatch; SQL read remains locked.",
    }


def ais_sql_read_allowed(config: dict[str, Any]) -> bool:
    return bool(ais_collector_key_gate_status(config).get("authorized_sql_read"))


def ais_sql_locked_packet(config: dict[str, Any]) -> dict[str, Any]:
    gate = ais_collector_key_gate_status(config)
    return {
        "status": "locked",
        "message": gate.get("message", "AIS SQL read is locked by collector key gate."),
        "rows": [],
        "row_count": 0,
        "key_gate": gate,
        "timing": {"query_ms": 0},
    }


@contextmanager
def _ais_mysql_server_connection(config: dict[str, Any], settings: dict[str, Any]):
    _connection_ref, connection = ais_mysql_connection_info(config, settings)
    with mysql_connection(
        config,
        database=None,
        dict_cursor=True,
        connection=connection,
        use_connection_database=False,
    ) as conn:
        yield conn


def _optional_live_column(live: dict[str, Any], key: str) -> str | None:
    value = live.get(key)
    if not value:
        return None
    return validate_identifier(value, f"live.ais.{key}")


def _ingest_data_directory_option(ingest: dict[str, Any]) -> tuple[str, list[str]]:
    raw_path = str(ingest.get("data_directory") or "").strip()
    if not raw_path:
        return "", []
    path = Path(raw_path)
    if not path.is_absolute():
        path = ROOT / path
    path.mkdir(parents=True, exist_ok=True)
    return " DATA DIRECTORY = %s", [path.as_posix()]


def _ensure_ais_latest_columns(
    cur,
    table: str,
    columns: dict[str, str],
    indexes: dict[str, str],
) -> None:
    cur.execute(f"SHOW COLUMNS FROM {mysql_quote(table)}")
    existing_columns = {
        str((row.get("Field") if isinstance(row, dict) else row[0]) or "")
        for row in cur.fetchall()
    }
    for column, definition in columns.items():
        if column in existing_columns:
            continue
        cur.execute(
            f"ALTER TABLE {mysql_quote(table)} ADD COLUMN {mysql_quote(column)} {definition}"
        )

    cur.execute(f"SHOW INDEX FROM {mysql_quote(table)}")
    existing_indexes = {
        str((row.get("Key_name") if isinstance(row, dict) else row[2]) or "")
        for row in cur.fetchall()
    }
    for index_name, column in indexes.items():
        if index_name in existing_indexes:
            continue
        cur.execute(
            f"ALTER TABLE {mysql_quote(table)} ADD INDEX {mysql_quote(index_name)} "
            f"({mysql_quote(column)})"
        )


def ensure_ais_latest_store(config: dict[str, Any]) -> dict[str, Any]:
    """Prepare the upstream AIS collector SQL store without starting collection."""
    config = apply_ais_collector_handoff(config)
    ingest = ais_ingest_settings(config)
    live = ais_live_settings(config)
    if not live.get("enabled"):
        return {"status": "disabled", "created": False}
    if not ingest["auto_create_table"]:
        return {"status": "skipped", "created": False}

    table = validate_identifier(live["table"], "live.ais.table")
    database = validate_identifier(live["database"], "live.ais.database")
    time_column = validate_identifier(live["time_column"], "live.ais.time_column")
    static_time_column = validate_identifier(live["static_time_column"], "live.ais.static_time_column")
    received_time_column = validate_identifier(live["received_time_column"], "live.ais.received_time_column")
    lat_column = validate_identifier(live["lat_column"], "live.ais.lat_column")
    lon_column = validate_identifier(live["lon_column"], "live.ais.lon_column")
    mmsi_column = validate_identifier(live["mmsi_column"], "live.ais.mmsi_column")
    speed_column = _optional_live_column(live, "speed_column")
    course_column = _optional_live_column(live, "course_column")
    heading_column = _optional_live_column(live, "heading_column")
    name_column = _optional_live_column(live, "name_column")
    source_column = _optional_live_column(live, "source_column")
    meta_table = _collector_meta_table(config)
    snapshot_table = validate_identifier(ingest["snapshot_table"], "live.ais.snapshot_table")
    data_directory_sql, data_directory_params = _ingest_data_directory_option(ingest)

    columns = [
        f"{mysql_quote(mmsi_column)} VARCHAR(32) NOT NULL PRIMARY KEY",
        f"{mysql_quote(time_column)} DATETIME NULL",
        f"{mysql_quote(static_time_column)} DATETIME NULL",
        f"{mysql_quote(received_time_column)} DATETIME NULL",
        f"{mysql_quote(lat_column)} DOUBLE NULL",
        f"{mysql_quote(lon_column)} DOUBLE NULL",
    ]
    if speed_column:
        columns.append(f"{mysql_quote(speed_column)} DOUBLE NULL")
    if course_column:
        columns.append(f"{mysql_quote(course_column)} DOUBLE NULL")
    if heading_column:
        columns.append(f"{mysql_quote(heading_column)} DOUBLE NULL")
    if name_column:
        columns.append(f"{mysql_quote(name_column)} VARCHAR(255) NULL")
    if source_column:
        columns.append(f"{mysql_quote(source_column)} VARCHAR(64) NULL")

    with _ais_mysql_server_connection(config, live) as server_conn:
        with server_conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS {mysql_quote(database)} "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )

    with _ais_mysql_connection(config, live, database) as conn, conn.cursor() as cur:
        cur.execute(
            f"CREATE TABLE IF NOT EXISTS {mysql_quote(table)} "
            f"({', '.join(columns)}) ENGINE=InnoDB{data_directory_sql} DEFAULT CHARSET=utf8mb4",
            data_directory_params,
        )
        required_columns = {
            static_time_column: "DATETIME NULL",
            received_time_column: "DATETIME NULL",
        }
        if speed_column:
            required_columns[speed_column] = "DOUBLE NULL"
        if course_column:
            required_columns[course_column] = "DOUBLE NULL"
        if heading_column:
            required_columns[heading_column] = "DOUBLE NULL"
        if name_column:
            required_columns[name_column] = "VARCHAR(255) NULL"
        if source_column:
            required_columns[source_column] = "VARCHAR(64) NULL"
        _ensure_ais_latest_columns(
            cur,
            table,
            required_columns,
            {
                "idx_ais_position_time": time_column,
                "idx_ais_received_time": received_time_column,
            },
        )
        cur.execute(
            f"CREATE TABLE IF NOT EXISTS {mysql_quote(meta_table)} ("
            "service_name VARCHAR(64) NOT NULL PRIMARY KEY, "
            "provider VARCHAR(64) NOT NULL, "
            "api_key_fingerprint CHAR(64) NOT NULL, "
            "collector_id VARCHAR(128) NULL, "
            "status VARCHAR(32) NOT NULL, "
            "accepted_messages BIGINT NOT NULL DEFAULT 0, "
            "written_rows BIGINT NOT NULL DEFAULT 0, "
            "skipped_stale_rows BIGINT NOT NULL DEFAULT 0, "
            "dropped_messages BIGINT NOT NULL DEFAULT 0, "
            "last_error TEXT NULL, "
            "last_seen_at DATETIME NOT NULL, "
            "updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
            f") ENGINE=InnoDB{data_directory_sql} DEFAULT CHARSET=utf8mb4",
            data_directory_params,
        )
        if ingest["snapshot_enabled"]:
            snapshot_columns = [
                "snapshot_at DATETIME NOT NULL",
                f"{mysql_quote(mmsi_column)} VARCHAR(32) NOT NULL",
                f"{mysql_quote(time_column)} DATETIME NOT NULL",
                "seconds_before_snapshot INT NOT NULL",
                f"{mysql_quote(lat_column)} DOUBLE NULL",
                f"{mysql_quote(lon_column)} DOUBLE NULL",
            ]
            if speed_column:
                snapshot_columns.append(f"{mysql_quote(speed_column)} DOUBLE NULL")
            if course_column:
                snapshot_columns.append(f"{mysql_quote(course_column)} DOUBLE NULL")
            if heading_column:
                snapshot_columns.append(f"{mysql_quote(heading_column)} DOUBLE NULL")
            if name_column:
                snapshot_columns.append(f"{mysql_quote(name_column)} VARCHAR(255) NULL")
            if source_column:
                snapshot_columns.append(f"{mysql_quote(source_column)} VARCHAR(64) NULL")
            snapshot_columns.extend(
                [
                    "updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
                    f"PRIMARY KEY (snapshot_at, {mysql_quote(mmsi_column)})",
                    f"INDEX idx_snapshot_event_time ({mysql_quote(time_column)})",
                ]
            )
            cur.execute(
                f"CREATE TABLE IF NOT EXISTS {mysql_quote(snapshot_table)} "
                f"({', '.join(snapshot_columns)}) ENGINE=InnoDB{data_directory_sql} DEFAULT CHARSET=utf8mb4",
                data_directory_params,
            )
    return {"status": "ok", "created": True, "database": database, "table": table, "meta_table": meta_table}


def get_ais_ingest_status(config: dict[str, Any] | None = None) -> dict[str, Any]:
    worker = _WORKER
    if worker is None:
        status = {
            "enabled": False,
            "running": False,
            "connected": False,
            "accepted_messages": 0,
            "written_rows": 0,
            "skipped_stale_rows": 0,
            "dropped_messages": 0,
            "last_error": None,
        }
    else:
        status = worker.status()
    if config is not None:
        effective_config = apply_ais_collector_handoff(copy.deepcopy(config))
        status["enabled"] = ais_ingest_should_start(effective_config)
        status["store"] = ais_latest_store_status(effective_config)
        gate = ais_collector_key_gate_status(effective_config)
        status["key_gate"] = gate
        status["handoff"] = ais_collector_handoff_status(effective_config)
        if worker is None:
            collector_status = str(gate.get("collector_status") or "").lower()
            external_running = bool(gate.get("authorized_sql_read")) and collector_status in {"connected", "ingesting", "running"}
            status["runner"] = "external_sql_meta" if external_running else "none"
            if external_running:
                status["running"] = True
                status["connected"] = True
                status["collector_status"] = collector_status
                status["collector_last_seen_at"] = gate.get("collector_last_seen_at")
                status["collector_last_seen_age_seconds"] = gate.get("collector_last_seen_age_seconds")
                status["accepted_messages"] = int(gate.get("accepted_messages") or 0)
                status["written_rows"] = int(gate.get("written_rows") or 0)
        else:
            status["runner"] = "in_process"
    return status


def ais_latest_store_status(config: dict[str, Any]) -> dict[str, Any]:
    settings = ais_live_settings(config)
    if not settings.get("enabled"):
        return {"status": "disabled", "vessel_count": 0}
    try:
        table = validate_identifier(settings["table"], "live.ais.table")
        database = validate_identifier(settings["database"], "live.ais.database")
        time_column = validate_identifier(settings["time_column"], "live.ais.time_column")
        with _ais_mysql_connection(config, settings, database) as conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) AS vessel_count, MAX({mysql_quote(time_column)}) AS latest_event_time "
                f"FROM {mysql_quote(table)}"
            )
            row = cur.fetchone() or {}
        latest = row.get("latest_event_time")
        latest_age_seconds = None
        if isinstance(latest, datetime):
            latest_dt = latest
            if latest_dt.tzinfo is not None:
                latest_dt = latest_dt.astimezone(timezone.utc).replace(tzinfo=None)
            latest_age_seconds = max(0.0, (datetime.utcnow() - latest_dt).total_seconds())
        return {
            "status": "ok",
            "table": table,
            "vessel_count": int(row.get("vessel_count") or 0),
            "latest_event_time": json_ready(latest),
            "latest_age_seconds": None if latest_age_seconds is None else round(latest_age_seconds, 3),
        }
    except Exception as exc:
        return {
            "status": "error",
            "vessel_count": 0,
            "error": str(exc),
        }


def start_ais_ingest_worker(config: dict[str, Any]) -> "AisIngestWorker | None":
    global _WORKER
    config = apply_ais_collector_handoff(config)
    with _WORKER_LOCK:
        if not ais_ingest_should_start(config):
            return None
        if _WORKER is not None and _WORKER.is_alive():
            return _WORKER
        worker = AisIngestWorker(config)
        worker.start()
        _WORKER = worker
        return worker


def run_ais_ingest_forever(config: dict[str, Any]) -> None:
    try:
        force_exit_previous_ais_ingest_instance()
        write_ais_ingest_pid_file(config)
        ingest = ais_ingest_settings(config)
        while True:
            try:
                ensure_ais_latest_store(config)
                print("AIS ingest SQL store ready.", flush=True)
                break
            except Exception as exc:
                print(
                    "AIS ingest waiting for SQL store "
                    f"({type(exc).__name__}: {str(exc)[:180]})",
                    flush=True,
                )
                time.sleep(ingest["reconnect_seconds"])
        waiting_logged = False
        while True:
            worker = start_ais_ingest_worker(config)
            if worker is None:
                if not waiting_logged:
                    handoff = ais_collector_handoff_status(config)
                    print(
                        "AIS ingest waiting for crawler handoff "
                        f"({handoff.get('status')} at {handoff.get('path')})",
                        flush=True,
                    )
                    waiting_logged = True
                time.sleep(3)
                continue
            waiting_logged = False
            while worker.is_alive():
                time.sleep(1)
    except KeyboardInterrupt:
        worker = _WORKER
        if worker is not None:
            worker.stop_event.set()
            worker.join(timeout=5)


def _mysql_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        result = value
    else:
        text = str(value or "").strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        result = datetime.fromisoformat(text) if text else datetime.now(timezone.utc)
    if result.tzinfo is not None:
        result = result.astimezone(timezone.utc).replace(tzinfo=None)
    return result


def _ceil_snapshot_at(event_time: datetime, interval_hours: int) -> tuple[datetime, int] | None:
    interval_seconds = max(1, interval_hours) * 3600
    if event_time.tzinfo is not None:
        event_time = event_time.astimezone(timezone.utc).replace(tzinfo=None)
    day_start = event_time.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = int((event_time - day_start).total_seconds())
    if elapsed % interval_seconds == 0 and event_time.microsecond == 0:
        offset = elapsed
    else:
        offset = ((elapsed // interval_seconds) + 1) * interval_seconds
    snapshot_at = day_start + timedelta(seconds=offset)
    seconds_before = int((snapshot_at - event_time).total_seconds())
    if seconds_before < 0:
        return None
    return snapshot_at, seconds_before


class AisIngestWorker(threading.Thread):
    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(name="aisstream-sql-ingest", daemon=True)
        self.config = config
        self.ingest = ais_ingest_settings(config)
        self.stream = ais_stream_settings(config)
        self.live = ais_live_settings(config)
        self.collector_id = f"{socket.gethostname()}:{os.getpid()}"
        self.stop_event = threading.Event()
        self.connected = False
        self.accepted_messages = 0
        self.written_rows = 0
        self.skipped_stale_rows = 0
        self.dropped_messages = 0
        self.last_error: str | None = None
        self.last_write_at: float | None = None
        self.last_connected_at: float | None = None
        self.last_meta_touch_at: float | None = None
        self.last_snapshot_retention_at: float | None = None
        self.snapshot_written_rows = 0
        self.snapshot_skipped_rows = 0

    def status(self) -> dict[str, Any]:
        return {
            "enabled": True,
            "running": self.is_alive(),
            "connected": self.connected,
            "accepted_messages": self.accepted_messages,
            "written_rows": self.written_rows,
            "skipped_stale_rows": self.skipped_stale_rows,
            "snapshot_written_rows": self.snapshot_written_rows,
            "snapshot_skipped_rows": self.snapshot_skipped_rows,
            "dropped_messages": self.dropped_messages,
            "last_error": self.last_error,
            "last_write_age_seconds": None if self.last_write_at is None else round(time.time() - self.last_write_at, 3),
            "connected_age_seconds": None
            if self.last_connected_at is None
            else round(time.time() - self.last_connected_at, 3),
        }

    def run(self) -> None:
        while not self.stop_event.is_set():
            upstream = None
            try:
                self._ensure_latest_table()
                self._touch_collector_meta("starting", force=True)
                upstream = open_aisstream_socket(self.stream, [None])
                self.connected = True
                self.last_connected_at = time.time()
                self.last_error = None
                self._touch_collector_meta("connected", force=True)
                self._consume(upstream)
            except Exception as exc:
                self.connected = False
                self.last_error = str(exc)
                self._touch_collector_meta("error", force=True)
                self.stop_event.wait(self.ingest["reconnect_seconds"])
            finally:
                self.connected = False
                if upstream is not None:
                    try:
                        upstream.close()
                    except Exception:
                        pass
        self._touch_collector_meta("stopped", force=True)

    def _consume(self, upstream) -> None:
        buffer: dict[str, dict[str, Any]] = {}
        last_flush = time.perf_counter()
        while not self.stop_event.is_set():
            try:
                raw_message = upstream.recv()
            except WebSocketTimeoutException:
                raw_message = None
            if raw_message:
                row = normalize_aisstream_message(raw_message)
                if row is None:
                    self.dropped_messages += 1
                else:
                    self.accepted_messages += 1
                    key = str(row["mmsi"])
                    buffer[key] = merge_ais_updates(buffer.get(key), row)
            now = time.perf_counter()
            should_flush_by_time = buffer and now - last_flush >= self.ingest["flush_seconds"]
            should_flush_by_size = len(buffer) >= self.ingest["batch_size"]
            if should_flush_by_time or should_flush_by_size:
                rows = list(buffer.values())
                self._upsert_latest_rows(rows)
                self._upsert_snapshot_rows(rows)
                buffer.clear()
                last_flush = now
                self._touch_collector_meta("ingesting")

    def _ensure_latest_table(self) -> None:
        ensure_ais_latest_store(self.config)

    def _optional_column(self, key: str) -> str | None:
        value = self.live.get(key)
        if not value:
            return None
        return validate_identifier(value, f"live.ais.{key}")

    def _insert_row_values(self, row: dict[str, Any]) -> tuple[list[str], list[Any]]:
        pairs: list[tuple[str, Any]] = [(self.live["mmsi_column"], str(row["mmsi"]))]
        if row.get("position_event_time"):
            pairs.extend(
                [
                    (self.live["time_column"], _mysql_datetime(row["position_event_time"])),
                    (self.live["lat_column"], row.get("lat")),
                    (self.live["lon_column"], row.get("lon")),
                ]
            )
        if row.get("static_event_time"):
            pairs.append(
                (self.live["static_time_column"], _mysql_datetime(row["static_event_time"]))
            )
        if row.get("received_at"):
            pairs.append(
                (self.live["received_time_column"], _mysql_datetime(row["received_at"]))
            )
        optional_mapping = [
            ("speed_column", "speed"),
            ("course_column", "course"),
            ("heading_column", "heading"),
            ("name_column", "name"),
            ("source_column", "source"),
        ]
        for column_key, row_key in optional_mapping:
            column = self.live.get(column_key)
            if column and row_key in row:
                pairs.append((column, row[row_key]))
        return [column for column, _value in pairs], [value for _column, value in pairs]

    def _eligible_updates(
        self,
        row: dict[str, Any],
        existing: dict[str, Any],
    ) -> dict[str, Any]:
        updates: dict[str, Any] = {}
        incoming_position = row.get("position_event_time")
        current_position = existing.get("position_event_time")
        if incoming_position and (
            current_position is None
            or _mysql_datetime(incoming_position) >= _mysql_datetime(current_position)
        ):
            updates[self.live["time_column"]] = _mysql_datetime(incoming_position)
            for column_key, row_key in (
                ("lat_column", "lat"),
                ("lon_column", "lon"),
                ("speed_column", "speed"),
                ("course_column", "course"),
                ("heading_column", "heading"),
            ):
                column = self.live.get(column_key)
                if column and row_key in row:
                    updates[column] = row[row_key]

        incoming_static = row.get("static_event_time")
        current_static = existing.get("static_event_time")
        if incoming_static and (
            current_static is None
            or _mysql_datetime(incoming_static) >= _mysql_datetime(current_static)
        ):
            updates[self.live["static_time_column"]] = _mysql_datetime(incoming_static)
            name_column = self.live.get("name_column")
            if name_column and "name" in row:
                updates[name_column] = row["name"]

        if updates:
            if row.get("received_at"):
                updates[self.live["received_time_column"]] = _mysql_datetime(row["received_at"])
            source_column = self.live.get("source_column")
            if source_column and "source" in row:
                updates[source_column] = row["source"]
        return updates

    def _upsert_latest_rows(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        table = validate_identifier(self.live["table"], "live.ais.table")
        database = validate_identifier(self.live["database"], "live.ais.database")
        mmsi_column = validate_identifier(self.live["mmsi_column"], "live.ais.mmsi_column")
        time_column = validate_identifier(self.live["time_column"], "live.ais.time_column")
        static_time_column = validate_identifier(
            self.live["static_time_column"], "live.ais.static_time_column"
        )
        with _ais_mysql_connection(self.config, self.live, database) as conn, conn.cursor() as cur:
            written = 0
            skipped = 0
            for row in rows:
                cur.execute(
                    f"SELECT {mysql_quote(time_column)} AS position_event_time, "
                    f"{mysql_quote(static_time_column)} AS static_event_time "
                    f"FROM {mysql_quote(table)} WHERE {mysql_quote(mmsi_column)} = %s LIMIT 1",
                    [str(row["mmsi"])],
                )
                existing = cur.fetchone()
                if existing:
                    updates = self._eligible_updates(row, existing)
                    if not updates:
                        skipped += 1
                        continue
                    cur.execute(
                        f"UPDATE {mysql_quote(table)} SET "
                        + ", ".join(f"{mysql_quote(column)} = %s" for column in updates)
                        + f" WHERE {mysql_quote(mmsi_column)} = %s",
                        [*updates.values(), str(row["mmsi"])],
                    )
                    written += 1
                    continue

                columns, values = self._insert_row_values(row)
                if len(columns) == 1:
                    skipped += 1
                    continue
                placeholders = ", ".join(["%s"] * len(columns))
                cur.execute(
                    f"INSERT INTO {mysql_quote(table)} "
                    f"({', '.join(mysql_quote(column) for column in columns)}) "
                    f"VALUES ({placeholders})",
                    values,
                )
                written += 1
            self.written_rows += written
            self.skipped_stale_rows += skipped
            if written:
                self.last_write_at = time.time()

    def _snapshot_values(self, row: dict[str, Any]) -> tuple[list[str], list[Any]] | None:
        if not row.get("position_event_time") or "lat" not in row or "lon" not in row:
            return None
        event_time = _mysql_datetime(row["position_event_time"])
        target = _ceil_snapshot_at(event_time, self.ingest["snapshot_interval_hours"])
        if target is None:
            return None
        snapshot_at, seconds_before = target
        if seconds_before > self.ingest["snapshot_window_hours"] * 3600:
            return None
        columns = [
            "snapshot_at",
            self.live["mmsi_column"],
            self.live["time_column"],
            "seconds_before_snapshot",
            self.live["lat_column"],
            self.live["lon_column"],
        ]
        values: list[Any] = [
            snapshot_at,
            str(row["mmsi"]),
            event_time,
            seconds_before,
            row.get("lat"),
            row.get("lon"),
        ]
        optional_mapping = [
            ("speed_column", "speed"),
            ("course_column", "course"),
            ("heading_column", "heading"),
            ("name_column", "name"),
            ("source_column", "source"),
        ]
        for column_key, row_key in optional_mapping:
            column = self.live.get(column_key)
            if not column or row_key not in row:
                continue
            columns.append(column)
            values.append(row[row_key])
        return columns, values

    def _upsert_snapshot_rows(self, rows: list[dict[str, Any]]) -> None:
        if not rows or not self.ingest["snapshot_enabled"]:
            return
        table = validate_identifier(self.ingest["snapshot_table"], "live.ais.snapshot_table")
        database = validate_identifier(self.live["database"], "live.ais.database")
        mmsi_column = validate_identifier(self.live["mmsi_column"], "live.ais.mmsi_column")
        with _ais_mysql_connection(self.config, self.live, database) as conn, conn.cursor() as cur:
            written = 0
            skipped = 0
            for row in rows:
                snapshot = self._snapshot_values(row)
                if snapshot is None:
                    skipped += 1
                    continue
                columns, values = snapshot
                value_by_column = dict(zip(columns, values))
                snapshot_at = value_by_column["snapshot_at"]
                mmsi = value_by_column[mmsi_column]
                seconds_before = value_by_column["seconds_before_snapshot"]
                update_pairs = [
                    f"{mysql_quote(column)} = %s"
                    for column in columns
                    if column not in {"snapshot_at", mmsi_column}
                ]
                update_values = [
                    value
                    for column, value in zip(columns, values)
                    if column not in {"snapshot_at", mmsi_column}
                ]
                cur.execute(
                    f"UPDATE {mysql_quote(table)} SET {', '.join(update_pairs)} "
                    "WHERE snapshot_at = %s "
                    f"AND {mysql_quote(mmsi_column)} = %s "
                    "AND seconds_before_snapshot > %s",
                    [*update_values, snapshot_at, mmsi, seconds_before],
                )
                if cur.rowcount > 0:
                    written += 1
                    continue
                cur.execute(
                    f"SELECT 1 FROM {mysql_quote(table)} "
                    f"WHERE snapshot_at = %s AND {mysql_quote(mmsi_column)} = %s LIMIT 1",
                    [snapshot_at, mmsi],
                )
                if cur.fetchone():
                    skipped += 1
                    continue
                placeholders = ", ".join(["%s"] * len(columns))
                cur.execute(
                    f"INSERT INTO {mysql_quote(table)} "
                    f"({', '.join(mysql_quote(column) for column in columns)}) "
                    f"VALUES ({placeholders})",
                    values,
                )
                written += 1
            self.snapshot_written_rows += written
            self.snapshot_skipped_rows += skipped
            self._prune_old_snapshots(cur, table)

    def _prune_old_snapshots(self, cur, table: str) -> None:
        now_ts = time.time()
        if self.last_snapshot_retention_at is not None and now_ts - self.last_snapshot_retention_at < 3600:
            return
        cur.execute(
            f"DELETE FROM {mysql_quote(table)} WHERE snapshot_at < (UTC_TIMESTAMP() - INTERVAL %s DAY)",
            [self.ingest["snapshot_retention_days"]],
        )
        self.last_snapshot_retention_at = now_ts

    def _touch_collector_meta(self, status: str, *, force: bool = False) -> None:
        now_ts = time.time()
        if not force and self.last_meta_touch_at is not None:
            if now_ts - self.last_meta_touch_at < self.ingest["status_report_seconds"]:
                return
        try:
            database = validate_identifier(self.live["database"], "live.ais.database")
            meta_table = _collector_meta_table(self.config)
            now = datetime.utcnow()
            last_error = (self.last_error or "")[:2000]
            with _ais_mysql_connection(self.config, self.live, database) as conn, conn.cursor() as cur:
                cur.execute(
                    f"INSERT INTO {mysql_quote(meta_table)} "
                    "(service_name, provider, api_key_fingerprint, collector_id, status, "
                    "accepted_messages, written_rows, skipped_stale_rows, dropped_messages, last_error, last_seen_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                    "ON DUPLICATE KEY UPDATE "
                    "provider = VALUES(provider), "
                    "api_key_fingerprint = VALUES(api_key_fingerprint), "
                    "collector_id = VALUES(collector_id), "
                    "status = VALUES(status), "
                    "accepted_messages = VALUES(accepted_messages), "
                    "written_rows = VALUES(written_rows), "
                    "skipped_stale_rows = VALUES(skipped_stale_rows), "
                    "dropped_messages = VALUES(dropped_messages), "
                    "last_error = VALUES(last_error), "
                    "last_seen_at = VALUES(last_seen_at)",
                    [
                        "aisstream",
                        "aisstream",
                        _api_key_fingerprint(self.stream["api_key"]),
                        self.collector_id,
                        status,
                        self.accepted_messages,
                        self.written_rows,
                        self.skipped_stale_rows,
                        self.dropped_messages,
                        last_error,
                        now,
                    ],
                )
            self.last_meta_touch_at = now_ts
        except Exception:
            # The collector must not die just because its status heartbeat failed.
            return
