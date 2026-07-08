from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from common_adapter.http.interface import create_app, create_developer_app

SERVER_PID_FILE = Path("flask_pid.txt")


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
