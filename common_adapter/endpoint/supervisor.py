from __future__ import annotations

import os
import logging
import socket
import subprocess
import sys
import time
from copy import deepcopy
from pathlib import Path
from threading import Event, RLock, Thread
from typing import Any, Callable

from common_adapter.config.paths import ROOT
from common_adapter.layers.runtime import active_config_files_by_group


LOGGER = logging.getLogger(__name__)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _expand_path(value: Any, root: Path) -> Path:
    text = str(value or "").strip().replace("${APP_ROOT}", str(root))
    path = Path(text)
    return path.resolve() if path.is_absolute() else (root / path).resolve()


def managed_runtime_spec(
    config_ref: str,
    route_config: dict[str, Any],
    *,
    root: Path = ROOT,
) -> dict[str, Any] | None:
    runtime = _mapping(route_config.get("runtime"))
    if str(runtime.get("ownership") or "").strip().lower() != "managed_local":
        return None
    launcher = _mapping(runtime.get("launcher"))
    if str(launcher.get("kind") or "").strip().lower() != "python_flask":
        raise ValueError(f"{config_ref}: managed runtime launcher must be python_flask")
    endpoint = _mapping(route_config.get("endpoint"))
    host = str(endpoint.get("host") or "").strip()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"{config_ref}: managed_local endpoint must use a loopback host")
    try:
        port = int(endpoint.get("port"))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{config_ref}: managed_local endpoint port is required") from exc
    app = str(launcher.get("app") or "").strip()
    if not app:
        raise ValueError(f"{config_ref}: managed runtime Flask app is required")
    working_directory = _expand_path(launcher.get("working_directory") or ".", root)
    python_path = _expand_path(launcher.get("python_path") or working_directory, root)
    if not working_directory.is_dir():
        raise ValueError(f"{config_ref}: managed runtime working directory does not exist: {working_directory}")
    if not python_path.is_dir():
        raise ValueError(f"{config_ref}: managed runtime python path does not exist: {python_path}")
    environment: dict[str, str] = {}
    for key, value in _mapping(launcher.get("environment")).items():
        name = str(key or "").strip()
        if not name:
            continue
        raw_value = str(value or "")
        environment[name] = (
            str(_expand_path(raw_value, root))
            if "${APP_ROOT}" in raw_value
            else raw_value
        )
    try:
        startup_timeout = float(runtime.get("startup_timeout_seconds") or 10)
        monitor_interval = float(runtime.get("monitor_interval_seconds") or 5)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{config_ref}: managed runtime intervals must be numeric") from exc
    return {
        "config_ref": config_ref,
        "name": str(route_config.get("name") or Path(config_ref).stem),
        "host": host,
        "port": port,
        "app": app,
        "working_directory": working_directory,
        "python_path": python_path,
        "environment": environment,
        "startup_timeout_seconds": max(0.2, min(startup_timeout, 60.0)),
        "monitor_interval_seconds": max(0.5, min(monitor_interval, 60.0)),
    }


class ManagedEndpointSupervisor:
    """Starts and monitors Config-declared local endpoint processes."""

    def __init__(
        self,
        config: dict[str, Any],
        *,
        root: Path = ROOT,
        executable: str | None = None,
        popen_factory: Callable[..., subprocess.Popen[Any]] = subprocess.Popen,
        port_probe: Callable[[str, int], bool] | None = None,
    ) -> None:
        self.config = config
        self.root = root.resolve()
        self.executable = executable or sys.executable
        self.popen_factory = popen_factory
        self.port_probe = port_probe or self._port_is_open
        self._lock = RLock()
        self._stop_event = Event()
        self._monitor: Thread | None = None
        self._processes: dict[str, subprocess.Popen[Any]] = {}
        self._streams: dict[str, tuple[Any, Any]] = {}
        self._statuses: dict[str, dict[str, Any]] = {}
        self._status_change_listeners: list[Callable[[], None]] = []

    def subscribe_status_changes(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to endpoint lifecycle changes and return an unsubscribe callback."""
        with self._lock:
            self._status_change_listeners.append(listener)

        def unsubscribe() -> None:
            with self._lock:
                if listener in self._status_change_listeners:
                    self._status_change_listeners.remove(listener)

        return unsubscribe

    def start(self) -> list[dict[str, Any]]:
        statuses = self.ensure_all()
        intervals = [spec["monitor_interval_seconds"] for spec in self._specs()]
        if intervals and (self._monitor is None or not self._monitor.is_alive()):
            self._stop_event.clear()
            self._monitor = Thread(
                target=self._monitor_forever,
                args=(min(intervals),),
                name="managed-endpoint-supervisor",
                daemon=True,
            )
            self._monitor.start()
        return statuses

    def stop(self) -> None:
        self._stop_event.set()
        monitor = self._monitor
        if monitor is not None and monitor.is_alive():
            monitor.join(timeout=2)
        with self._lock:
            for process in self._processes.values():
                if process.poll() is None:
                    process.terminate()
            for process in self._processes.values():
                if process.poll() is None:
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
            for stdout_stream, stderr_stream in self._streams.values():
                stdout_stream.close()
                stderr_stream.close()
            self._processes.clear()
            self._streams.clear()

    def ensure_all(self) -> list[dict[str, Any]]:
        specs = self._specs()
        active_refs = {spec["config_ref"] for spec in specs}
        status_removed = False
        with self._lock:
            stale_refs = set(self._processes) - active_refs
            for config_ref in stale_refs:
                self._stop_owned_process(config_ref)
                status_removed = self._statuses.pop(config_ref, None) is not None or status_removed
        if status_removed:
            self._notify_status_change()
        return [self.ensure(spec) for spec in specs]

    def statuses(self) -> list[dict[str, Any]]:
        with self._lock:
            return deepcopy(sorted(self._statuses.values(), key=lambda row: row["config_ref"]))

    def ensure(self, spec: dict[str, Any]) -> dict[str, Any]:
        config_ref = spec["config_ref"]
        if self.port_probe(spec["host"], spec["port"]):
            with self._lock:
                process = self._processes.get(config_ref)
            return self._record_status(self._status(spec, "ready", process=process))

        launch_error: Exception | None = None
        with self._lock:
            process = self._processes.get(config_ref)
            if process is None or process.poll() is not None:
                self._close_streams(config_ref)
                try:
                    process = self._launch(spec)
                except (OSError, ValueError) as exc:
                    launch_error = exc
                else:
                    self._processes[config_ref] = process
        if launch_error is not None:
            return self._record_status(self._status(spec, "failed", error=str(launch_error)))

        deadline = time.monotonic() + spec["startup_timeout_seconds"]
        while time.monotonic() < deadline and not self._stop_event.is_set():
            if self.port_probe(spec["host"], spec["port"]):
                return self._record_status(self._status(spec, "ready", process=process))
            if process.poll() is not None:
                break
            self._stop_event.wait(0.1)
        error = (
            f"process exited with code {process.returncode}"
            if process.poll() is not None
            else f"startup timeout after {spec['startup_timeout_seconds']:.1f}s"
        )
        return self._record_status(self._status(spec, "failed", process=process, error=error))

    def _record_status(self, status: dict[str, Any]) -> dict[str, Any]:
        config_ref = str(status["config_ref"])
        with self._lock:
            previous = self._statuses.get(config_ref)
            self._statuses[config_ref] = status
            changed = previous != status
        if changed:
            self._notify_status_change()
        return deepcopy(status)

    def _notify_status_change(self) -> None:
        with self._lock:
            listeners = tuple(self._status_change_listeners)
        for listener in listeners:
            try:
                listener()
            except Exception:
                LOGGER.exception("Managed endpoint status listener failed")

    def _specs(self) -> list[dict[str, Any]]:
        routes = [
            *active_config_files_by_group("database", self.config),
            *active_config_files_by_group("endpoint", self.config),
        ]
        specs: list[dict[str, Any]] = []
        for config_ref, _path, route_config in routes:
            spec = managed_runtime_spec(config_ref, route_config, root=self.root)
            if spec is not None:
                specs.append(spec)
        return specs

    def _launch(self, spec: dict[str, Any]) -> subprocess.Popen[Any]:
        logs_directory = self.root / "logs"
        logs_directory.mkdir(parents=True, exist_ok=True)
        token = "".join(character if character.isalnum() else "-" for character in spec["name"]).strip("-")
        stdout_stream = (logs_directory / f"{token}-managed.out.log").open("ab")
        stderr_stream = (logs_directory / f"{token}-managed.err.log").open("ab")
        self._streams[spec["config_ref"]] = (stdout_stream, stderr_stream)
        environment = os.environ.copy()
        environment.update(spec["environment"])
        existing_python_path = environment.get("PYTHONPATH", "")
        environment["PYTHONPATH"] = os.pathsep.join(
            value for value in (str(spec["python_path"]), existing_python_path) if value
        )
        command = [
            self.executable,
            "-m",
            "flask",
            "--app",
            spec["app"],
            "run",
            f"--host={spec['host']}",
            f"--port={spec['port']}",
            "--no-debugger",
            "--no-reload",
        ]
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        return self.popen_factory(
            command,
            cwd=str(spec["working_directory"]),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout_stream,
            stderr=stderr_stream,
            creationflags=creation_flags,
        )

    def _monitor_forever(self, interval: float) -> None:
        while not self._stop_event.wait(interval):
            self.ensure_all()

    def _close_streams(self, config_ref: str) -> None:
        streams = self._streams.pop(config_ref, None)
        if streams is not None:
            streams[0].close()
            streams[1].close()

    def _stop_owned_process(self, config_ref: str) -> None:
        process = self._processes.pop(config_ref, None)
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
        self._close_streams(config_ref)

    @staticmethod
    def _port_is_open(host: str, port: int) -> bool:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return True
        except OSError:
            return False

    @staticmethod
    def _status(
        spec: dict[str, Any],
        state: str,
        *,
        process: subprocess.Popen[Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        return {
            "config_ref": spec["config_ref"],
            "name": spec["name"],
            "ownership": "managed_local",
            "state": state,
            "ready": state == "ready",
            "host": spec["host"],
            "port": spec["port"],
            "pid": process.pid if process is not None else None,
            "error": error,
        }
