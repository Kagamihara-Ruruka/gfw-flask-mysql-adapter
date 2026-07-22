from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from common_adapter.config.atomic_json import atomic_write_json
from common_adapter.config.paths import ROOT
from common_adapter.endpoint.supervisor import ManagedEndpointSupervisor
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.layers.status import RouteStatusRegistry

from common_adapter.http.interface import create_app, create_developer_app

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
    raise RuntimeError(
        f"port {port} is occupied by a process that this Runtime does not own; "
        "refusing to terminate it"
    )


def server_owner_key(
    config: dict[str, Any],
    *,
    port: int,
    developer_port: int | None,
) -> str:
    identity = config.get("__runtime_identity") if isinstance(config.get("__runtime_identity"), dict) else {}
    payload = "|".join(
        [
            str(ROOT.resolve()).lower(),
            str(identity.get("profile") or config.get("__runtime_profile") or "LOCAL").upper(),
            str(config.get("__config_path") or ""),
            str(port),
            str(developer_port or ""),
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def server_pid_path(config: dict[str, Any], *, port: int, developer_port: int | None) -> Path:
    configured = os.environ.get("BDDE38_CONTROL_DIR")
    directory = Path(configured) if configured else ROOT / ".runtime" / "server-owners"
    if not directory.is_absolute():
        directory = ROOT / directory
    return directory.resolve() / f"flask-{server_owner_key(config, port=port, developer_port=developer_port)[:20]}.json"


def read_server_pid_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    raw = path.read_text(encoding="utf-8", errors="ignore").strip()
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


def process_looks_like_this_server(pid: int, previous: dict[str, Any], *, owner_key: str) -> bool:
    if str(previous.get("owner_key") or "") != owner_key:
        return False
    if sys.platform != "win32":
        return True
    command_line = windows_command_line_for_pid(pid).replace("\\", "/").lower()
    if not command_line:
        return False
    has_entrypoint = "core.py" in command_line
    has_python = "python" in command_line
    return has_entrypoint and has_python


def force_exit_previous_server_instance(
    config: dict[str, Any],
    *,
    port: int,
    developer_port: int | None,
    enabled: bool,
) -> Path:
    path = server_pid_path(config, port=port, developer_port=developer_port)
    if not enabled:
        return path
    previous = read_server_pid_file(path)
    if not previous:
        return path
    try:
        previous_pid = int(previous["pid"])
    except (KeyError, TypeError, ValueError):
        return path
    if previous_pid <= 0 or previous_pid == os.getpid():
        return path
    owner_key = server_owner_key(config, port=port, developer_port=developer_port)
    if not process_looks_like_this_server(previous_pid, previous, owner_key=owner_key):
        return path
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(previous_pid), "/T", "/F"], check=False, capture_output=True)
        time.sleep(0.5)
        return path
    try:
        os.kill(previous_pid, 9)
    except OSError:
        return path
    time.sleep(0.5)
    return path


def write_server_pid_file(
    path: Path,
    config: dict[str, Any],
    *,
    host: str,
    port: int,
    developer_port: int | None = None,
) -> None:
    payload = {
        "schema": "bdde38.server_owner.v1",
        "pid": os.getpid(),
        "cwd": str(Path.cwd()),
        "host": host,
        "port": port,
        "developer_port": developer_port,
        "owner_key": server_owner_key(config, port=port, developer_port=developer_port),
        "runtime_instance_id": (config.get("__runtime_identity") or {}).get("runtime_instance_id"),
        "started_at": int(time.time()),
    }
    atomic_write_json(path, payload, keep_last_known_good=False)


def remove_server_pid_file(path: Path) -> None:
    current = read_server_pid_file(path)
    if current and int(current.get("pid") or -1) == os.getpid():
        path.unlink(missing_ok=True)


def public_url(host: str, port: int) -> str:
    display_host = "127.0.0.1" if host in {"0.0.0.0", ""} else host
    return f"http://{display_host}:{port}"


def public_port(env_name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(env_name) or fallback)
    except ValueError:
        return fallback

def run_server(
    config: dict[str, Any],
    *,
    host: str,
    port: int,
    debug: bool,
    kill_port_if_busy: bool,
    endpoint_supervisor: ManagedEndpointSupervisor | None = None,
) -> None:
    owner_path = force_exit_previous_server_instance(
        config,
        port=port,
        developer_port=None,
        enabled=kill_port_if_busy,
    )
    free_configured_port_if_needed(host, port, enabled=kill_port_if_busy)
    write_server_pid_file(owner_path, config, host=host, port=port)
    layer_registry = RuntimeLayerRegistry(config)
    route_status_registry = RouteStatusRegistry(config, layer_registry)
    unsubscribe_endpoint_status = (
        endpoint_supervisor.subscribe_status_changes(route_status_registry.invalidate)
        if endpoint_supervisor is not None
        else lambda: None
    )
    app = create_app(
        config,
        layer_registry=layer_registry,
        route_status_registry=route_status_registry,
    )
    try:
        app.run(host=host, port=port, debug=debug, use_reloader=False)
    finally:
        unsubscribe_endpoint_status()
        remove_server_pid_file(owner_path)


def run_server_pair(
    config: dict[str, Any],
    *,
    host: str,
    port: int,
    developer_port: int,
    debug: bool,
    kill_port_if_busy: bool,
    endpoint_supervisor: ManagedEndpointSupervisor | None = None,
) -> None:
    owner_path = force_exit_previous_server_instance(
        config,
        port=port,
        developer_port=developer_port,
        enabled=kill_port_if_busy,
    )
    free_configured_port_if_needed(host, port, enabled=kill_port_if_busy)
    free_configured_port_if_needed(host, developer_port, enabled=kill_port_if_busy)
    write_server_pid_file(
        owner_path,
        config,
        host=host,
        port=port,
        developer_port=developer_port,
    )

    consumer_url = public_url(host, public_port("BDDE38_PUBLIC_HTTP_PORT", port))
    consumer_probe_url = public_url(host, port)
    developer_url = public_url(
        host,
        public_port("BDDE38_PUBLIC_DEVELOPER_PORT", developer_port),
    )
    layer_registry = RuntimeLayerRegistry(config)
    route_status_registry = RouteStatusRegistry(config, layer_registry)
    unsubscribe_endpoint_status = (
        endpoint_supervisor.subscribe_status_changes(route_status_registry.invalidate)
        if endpoint_supervisor is not None
        else lambda: None
    )
    developer_app = create_developer_app(
        config,
        consumer_url=consumer_url,
        layer_registry=layer_registry,
        route_status_registry=route_status_registry,
        endpoint_supervisor=endpoint_supervisor,
        consumer_probe_url=consumer_probe_url,
    )
    developer_thread = threading.Thread(
        target=lambda: developer_app.run(host=host, port=developer_port, debug=debug, use_reloader=False),
        name="developer-config-server",
        daemon=True,
    )
    developer_thread.start()

    app = create_app(
        config,
        developer_url=developer_url,
        layer_registry=layer_registry,
        route_status_registry=route_status_registry,
    )
    try:
        app.run(host=host, port=port, debug=debug, use_reloader=False)
    finally:
        unsubscribe_endpoint_status()
        remove_server_pid_file(owner_path)
