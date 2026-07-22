from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import locale
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import uuid
import webbrowser
from pathlib import Path
from typing import Sequence

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from common_adapter.runtime.config_state import RuntimeConfigStateStore
from common_adapter.db.connect import load_config
from scripts.presentation.deployment_profile import (
    DeploymentProfile,
    DeploymentProfileError,
    load_deployment_profile,
)


EVENT_SCHEMA = "bdde38.presentation.event.v1"
STATE_SCHEMA = "bdde38.presentation.state.v1"
SMOKE_SCHEMA = "bdde38.presentation.smoke.v2"
CONTRACT_SCHEMA = "bdde38.presentation.contract.v2"

STAGES = (
    "preflight",
    "cluster_access",
    "hdfs_yarn",
    "spark_thrift",
    "ssh_tunnel",
    "docker_postgis",
    "spatial_dependencies",
    "docker_app",
    "application_health",
    "smoke_test",
    "ready",
)
EXIT_CODES = {
    0: "success",
    1: "not_ready",
    2: "local_preflight_failed",
    3: "operation_locked",
    10: "ssh_or_cluster_access_failed",
    11: "hdfs_or_yarn_failed",
    12: "spark_thrift_or_iceberg_failed",
    13: "ssh_tunnel_failed",
    20: "docker_compose_failed",
    21: "application_health_failed",
    22: "smoke_test_failed",
    23: "spatial_dependencies_failed",
}
STAGE_EXIT_CODES = {
    "preflight": 2,
    "cluster_access": 10,
    "hdfs_yarn": 11,
    "spark_thrift": 12,
    "ssh_tunnel": 13,
    "docker_postgis": 20,
    "docker_app": 20,
    "spatial_dependencies": 23,
    "application_health": 21,
    "smoke_test": 22,
}
REQUIRED_COMPOSE_SERVICES = frozenset({"app", "postgis"})
EXPECTED_DATASETS = frozenset(
    {
        "pipeline_iceberg.chlor_a",
        "pipeline_iceberg.fishing_hours",
        "pipeline_iceberg.ocean_productivity_score",
        "pipeline_iceberg.sea_temperature",
        "pipeline_iceberg.sustainability_pressure",
    }
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


@dataclasses.dataclass(frozen=True)
class RepositoryLayout:
    root: Path

    @property
    def script_dir(self) -> Path:
        return self.root / "scripts" / "presentation"

    @property
    def runtime_dir(self) -> Path:
        return self.root / ".runtime"

    @property
    def compose_file(self) -> Path:
        return self.root / "compose.presentation.yaml"

    @property
    def deployment_profile(self) -> Path:
        return self.root / "config" / "presentation" / "deployment.profile.json"

    @property
    def spatial_manifest(self) -> Path:
        return (
            self.root
            / "data"
            / "eez"
            / "derived-domain-cache"
            / "domain-tiles"
            / "prewarm-manifest.json"
        )

    def action_script(self, action: str) -> Path:
        return self.script_dir / f"{action}-presentation.ps1"


@dataclasses.dataclass(frozen=True)
class Event:
    command: str
    stage: str
    status: str
    message: str
    details: dict[str, object] = dataclasses.field(default_factory=dict)
    timestamp: str = dataclasses.field(default_factory=utc_now)
    schema: str = EVENT_SCHEMA

    def as_dict(self) -> dict[str, object]:
        return dataclasses.asdict(self)


class Reporter:
    def __init__(
        self,
        *,
        json_lines: bool = False,
        event_log_path: Path | None = None,
    ) -> None:
        self.json_lines = json_lines
        self.event_log_path = event_log_path
        self._log_lock = threading.Lock()

    def emit(
        self,
        command: str,
        stage: str,
        status: str,
        message: str,
        **details: object,
    ) -> Event:
        event = Event(command, stage, status, message, details)
        log_serialized = json.dumps(event.as_dict(), ensure_ascii=False)
        if self.event_log_path is not None:
            with self._log_lock:
                self.event_log_path.parent.mkdir(parents=True, exist_ok=True)
                with self.event_log_path.open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(log_serialized)
                    handle.write("\n")
        if self.json_lines:
            # The Windows launcher can inherit a strict CP950 console. ASCII JSON
            # keeps the event protocol lossless while json.loads restores Unicode.
            print(json.dumps(event.as_dict(), ensure_ascii=True), flush=True)
        else:
            labels = {
                "ok": "OK",
                "failed": "FAIL",
                "running": "RUN",
                "info": "INFO",
                "log": "LOG",
            }
            label = labels.get(status, status.upper())
            self._print_console_safe(f"[{label:<4}] {stage:<18} {message}")
        return event

    @staticmethod
    def _print_console_safe(value: str) -> None:
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        printable = value.encode(encoding, errors="replace").decode(
            encoding,
            errors="replace",
        )
        print(printable, flush=True)


class StateStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._write_lock = threading.Lock()

    def read(self) -> dict[str, object]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {"schema": STATE_SCHEMA, "status": "unknown"}
        return value if isinstance(value, dict) else {"schema": STATE_SCHEMA, "status": "unknown"}

    def write(self, *, command: str, stage: str, status: str, message: str) -> None:
        payload = {
            "schema": STATE_SCHEMA,
            "updated_at": utc_now(),
            "command": command,
            "stage": stage,
            "status": status,
            "message": message,
        }
        with self._write_lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f"{self.path.name}.",
                suffix=".tmp",
                dir=self.path.parent,
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                temporary.unlink(missing_ok=True)


def process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


class OperationLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.acquired = False

    def __enter__(self) -> "OperationLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                descriptor = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                )
            except FileExistsError:
                try:
                    current = json.loads(self.path.read_text(encoding="utf-8"))
                    owner_pid = int(current.get("pid", 0))
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    owner_pid = 0
                if process_exists(owner_pid):
                    raise RuntimeError(
                        f"Another presentation operation is running (PID {owner_pid})."
                    )
                self.path.unlink(missing_ok=True)
                continue

            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump({"pid": os.getpid(), "created_at": utc_now()}, handle)
            self.acquired = True
            return self
        raise RuntimeError("Unable to acquire the presentation operation lock.")

    def __exit__(self, *_: object) -> None:
        if self.acquired:
            self.path.unlink(missing_ok=True)
            self.acquired = False


def locate_powershell() -> str | None:
    return shutil.which("powershell.exe") or shutil.which("pwsh")


class PowerShellAdapter:
    def __init__(
        self,
        layout: RepositoryLayout,
        reporter: Reporter,
        *,
        executable: str | None = None,
    ) -> None:
        self.layout = layout
        self.reporter = reporter
        self.executable = executable or locate_powershell()

    def validate(self, action: str) -> list[str]:
        errors: list[str] = []
        if not self.executable:
            errors.append("PowerShell was not found on PATH.")
        if not self.layout.action_script(action).is_file():
            errors.append(f"Missing action script: {self.layout.action_script(action)}")
        if action in {"start", "stop"} and not self.layout.compose_file.is_file():
            errors.append(f"Missing Compose file: {self.layout.compose_file}")
        if action in {"start", "test"} and not self.layout.deployment_profile.is_file():
            errors.append(f"Missing deployment profile: {self.layout.deployment_profile}")
        return errors

    def command(self, action: str, passthrough: Sequence[str]) -> list[str]:
        if not self.executable:
            raise RuntimeError("PowerShell was not found on PATH.")
        return [
            self.executable,
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.layout.action_script(action)),
            *passthrough,
        ]

    def run(
        self,
        action: str,
        passthrough: Sequence[str],
        *,
        dry_run: bool = False,
        environment: dict[str, str] | None = None,
    ) -> "ScriptResult":
        command = self.command(action, passthrough)
        if dry_run:
            self.reporter.emit(
                action,
                "preflight",
                "info",
                "Dry run; PowerShell was not executed.",
                argv=command,
            )
            return ScriptResult(0, "preflight")

        encoding = locale.getpreferredencoding(False) or "utf-8"
        process = subprocess.Popen(
            command,
            cwd=self.layout.root,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding=encoding,
            errors="replace",
        )
        assert process.stdout is not None
        last_stage = "preflight"
        for raw_line in process.stdout:
            line = raw_line.rstrip("\r\n")
            if not line:
                continue
            stage, status, message, details = parse_output_record(line)
            if stage in STAGES:
                last_stage = stage
            self.reporter.emit(
                action,
                stage,
                status,
                message,
                **details,
            )
        return ScriptResult(process.wait(), last_stage)


@dataclasses.dataclass(frozen=True)
class ScriptResult:
    exit_code: int
    last_stage: str


def parse_output_event(line: str) -> tuple[str, str, str]:
    stage, status, message, _details = parse_output_record(line)
    return stage, status, message


def parse_output_record(line: str) -> tuple[str, str, str, dict[str, object]]:
    if line.startswith("BDDE38_STAGE "):
        parts = line.split(" ", 3)
        if len(parts) == 4:
            _, stage, status, message = parts
            if stage in STAGES and status in {"running", "ok", "failed", "info"}:
                return stage, status, message, {}
    try:
        payload = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        payload = None
    if isinstance(payload, dict):
        eez_status = str(payload.get("status") or "")
        if eez_status.startswith("eez_"):
            labels = {
                "eez_source_check": "Checking the EEZ source cache.",
                "eez_download_start": "Downloading the EEZ source archive.",
                "eez_download_response": "Receiving the EEZ source archive.",
                "eez_download_progress": "Downloading the EEZ source archive.",
                "eez_download_retry": "Retrying the EEZ source download.",
                "eez_extract_start": "Extracting the EEZ GeoPackage.",
                "eez_source_ready": "The EEZ GeoPackage is valid.",
                "eez_postgis_check": "Checking EEZ PostGIS tables.",
                "eez_postgis_import_start": "Importing EEZ geometry into PostGIS.",
                "eez_postgis_ready": "EEZ PostGIS tables are ready.",
                "eez_domain_topology_check": "Preparing the EEZ domain topology.",
                "eez_domain_prewarm_start": "Prewarming persistent EEZ domain tiles.",
                "eez_domain_prewarm_progress": "Prewarming persistent EEZ domain tiles.",
                "eez_domain_prewarm_ready": "Persistent EEZ domain tiles are ready.",
                "eez_runtime_assets_ready": "All EEZ runtime assets are ready.",
            }
            event_status = (
                "ok"
                if eez_status
                in {
                    "eez_source_ready",
                    "eez_postgis_ready",
                    "eez_domain_prewarm_ready",
                    "eez_runtime_assets_ready",
                }
                else "running"
            )
            return (
                "spatial_dependencies",
                event_status,
                labels.get(eez_status, eez_status.replace("_", " ")),
                {"eez": payload},
            )
    return classify_output_stage(line), "log", line, {}


def classify_output_stage(line: str) -> str:
    normalized = line.casefold()
    if "hdfs" in normalized or "yarn" in normalized:
        return "hdfs_yarn"
    if "spark thrift" in normalized or "iceberg catalog" in normalized:
        return "spark_thrift"
    if "presentation bridge" in normalized or "ssh bridge" in normalized:
        return "cluster_access"
    if "spark tunnel" in normalized or "port-forward" in normalized:
        return "ssh_tunnel"
    if "postgis" in normalized:
        return "docker_postgis"
    if "docker compose" in normalized or "application container" in normalized:
        return "docker_app"
    if "eez" in normalized or "domain tile" in normalized:
        return "spatial_dependencies"
    if "presentation service" in normalized or "/api/health" in normalized:
        return "application_health"
    if normalized.startswith("pass ") or "smoke test" in normalized:
        return "smoke_test"
    if (
        "official site:" in normalized
        or "dashboard:" in normalized
        or "developer:" in normalized
    ):
        return "ready"
    return "preflight"


def tcp_probe(host: str, port: int, timeout: float = 0.75) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_probe(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 400
    except (OSError, urllib.error.URLError, ValueError):
        return False


def json_probe(url: str, timeout: float = 5.0) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.load(response)
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def runtime_identity_probe(http_port: int) -> dict[str, object] | None:
    return json_probe(f"http://127.0.0.1:{http_port}/api/runtime/identity")


def docker_probe(layout: RepositoryLayout) -> tuple[bool, list[str]]:
    docker = shutil.which("docker")
    if not docker:
        return False, []
    result = subprocess.run(
        [
            docker,
            "compose",
            "-f",
            str(layout.compose_file),
            "ps",
            "--status",
            "running",
            "--services",
        ],
        cwd=layout.root,
        capture_output=True,
        text=True,
        check=False,
    )
    services = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return result.returncode == 0, services


def compose_published_ports(
    layout: RepositoryLayout,
    *,
    service: str,
    container_port: int,
) -> list[int]:
    docker = shutil.which("docker")
    if not docker:
        return []
    result = subprocess.run(
        [
            docker,
            "compose",
            "-f",
            str(layout.compose_file),
            "port",
            service,
            str(container_port),
        ],
        cwd=layout.root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []
    ports: set[int] = set()
    for line in result.stdout.splitlines():
        candidate = line.strip().rsplit(":", 1)[-1]
        try:
            ports.add(int(candidate))
        except ValueError:
            continue
    return sorted(ports)


def smoke_state_probe(
    layout: RepositoryLayout,
    *,
    tunnel_port: int,
    http_port: int,
    developer_port: int,
) -> tuple[bool, dict[str, object]]:
    path = layout.runtime_dir / "presentation-smoke-state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False, {"state_path": str(path), "reason": "missing_or_invalid"}
    if not isinstance(state, dict):
        return False, {"state_path": str(path), "reason": "invalid_shape"}

    datasets = state.get("datasets", [])
    smoke_identity = state.get("runtime_identity")
    current_identity = runtime_identity_probe(http_port)
    identity_fields = (
        "runtime_instance_id",
        "runtime_generation",
        "runtime_fingerprint",
        "config_bundle_hash",
        "image_digest",
        "compose_hash",
        "bridge_owner_token",
    )
    identity_matches = (
        isinstance(smoke_identity, dict)
        and isinstance(current_identity, dict)
        and all(smoke_identity.get(field) == current_identity.get(field) for field in identity_fields)
    )
    evidence_ready = isinstance(smoke_identity, dict) and all(
        str(smoke_identity.get(field) or "").strip() not in {"", "missing", "unmanaged"}
        for field in ("config_bundle_hash", "image_digest", "compose_hash", "bridge_owner_token")
    )
    valid = (
        state.get("schema") == SMOKE_SCHEMA
        and state.get("tunnel_port") == tunnel_port
        and state.get("http_port") == http_port
        and state.get("developer_port") == developer_port
        and isinstance(datasets, list)
        and EXPECTED_DATASETS.issubset(set(map(str, datasets)))
        and identity_matches
        and evidence_ready
    )
    details = dict(state)
    details["state_path"] = str(path)
    details["current_runtime_identity"] = current_identity
    if not valid:
        details["reason"] = (
            "runtime_identity_mismatch"
            if not identity_matches
            else "deployment_evidence_missing"
            if not evidence_ready
            else "contract_mismatch"
        )
    return valid, details


def spatial_state_probe(layout: RepositoryLayout) -> tuple[bool, dict[str, object]]:
    path = layout.spatial_manifest
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False, {"manifest_path": str(path), "reason": "missing_or_invalid"}
    if not isinstance(manifest, dict):
        return False, {"manifest_path": str(path), "reason": "invalid_shape"}

    cache_identity = str(manifest.get("cache_identity") or "")
    try:
        expected_tiles = int(manifest.get("tiles") or 0)
    except (TypeError, ValueError):
        expected_tiles = 0
    cache_directory = path.parent / cache_identity
    metadata_paths = (
        list(cache_directory.glob("*/*/*.json"))
        if cache_identity and cache_directory.is_dir()
        else []
    )
    complete_tiles = sum(
        1
        for metadata_path in metadata_paths
        if metadata_path.with_name(f"{metadata_path.stem}.land.wkb").is_file()
        and metadata_path.with_name(f"{metadata_path.stem}.high-seas.wkb").is_file()
    )
    valid = (
        manifest.get("schema") == "rrkal.eez_domain_prewarm.v1"
        and manifest.get("complete") is True
        and bool(cache_identity)
        and bool(manifest.get("source_version"))
        and expected_tiles > 0
        and complete_tiles >= expected_tiles
    )
    details = dict(manifest)
    details.update(
        {
            "manifest_path": str(path),
            "cache_directory": str(cache_directory),
            "complete_tiles": complete_tiles,
        }
    )
    if not valid:
        details["reason"] = "contract_mismatch"
    return valid, details


def status_command(
    layout: RepositoryLayout,
    profile: DeploymentProfile,
    reporter: Reporter,
    state_store: StateStore,
    *,
    tunnel_port: int,
    http_port: int,
    developer_port: int,
) -> int:
    stored = state_store.read()
    reporter.emit(
        "status",
        "preflight",
        "info",
        str(stored.get("message", "No controller state has been recorded.")),
        stored_state=stored,
    )

    docker_command_ok, services = docker_probe(layout)
    missing_services = sorted(REQUIRED_COMPOSE_SERVICES.difference(services))
    published_http_ports = compose_published_ports(
        layout,
        service="app",
        container_port=profile.container_http_port,
    )
    published_developer_ports = compose_published_ports(
        layout,
        service="app",
        container_port=profile.container_developer_port,
    )
    compose_ports_ok = (
        http_port in published_http_ports
        and developer_port in published_developer_ports
    )
    postgis_ok = docker_command_ok and "postgis" in services
    app_ok = docker_command_ok and "app" in services and compose_ports_ok
    tunnel_ok = tcp_probe("127.0.0.1", tunnel_port)
    official_ok = http_probe(f"http://127.0.0.1:{http_port}/")
    dashboard_ok = http_probe(f"http://127.0.0.1:{http_port}/dashboard/")
    runtime_identity = runtime_identity_probe(http_port)
    runtime_ok = runtime_identity is not None
    profile_identity_ok = bool(
        runtime_identity
        and runtime_identity.get("deployment_profile_hash") == profile.sha256
        and runtime_identity.get("deployment_environment") == profile.environment
        and runtime_identity.get("deployment_target") == profile.ssh_target
    )
    developer_ok = http_probe(f"http://127.0.0.1:{developer_port}/")
    spatial_ok, spatial_details = spatial_state_probe(layout)
    smoke_ok, smoke_details = smoke_state_probe(
        layout,
        tunnel_port=tunnel_port,
        http_port=http_port,
        developer_port=developer_port,
    )

    checks = [
        ("ssh_tunnel", tunnel_ok, {"host": "127.0.0.1", "port": tunnel_port}),
        (
            "docker_postgis",
            postgis_ok,
            {
                "running_services": services,
                "required_service": "postgis",
            },
        ),
        ("spatial_dependencies", spatial_ok, spatial_details),
        (
            "docker_app",
            app_ok,
            {
                "running_services": services,
                "required_service": "app",
                "missing_services": missing_services,
                "published_http_ports": published_http_ports,
                "published_developer_ports": published_developer_ports,
                "expected_http_port": http_port,
                "expected_developer_port": developer_port,
            },
        ),
        (
            "application_health",
            official_ok,
            {"component": "official_site", "url": f"http://127.0.0.1:{http_port}/"},
        ),
        (
            "application_health",
            dashboard_ok,
            {"component": "dashboard", "url": f"http://127.0.0.1:{http_port}/dashboard/"},
        ),
        (
            "application_health",
            runtime_ok,
            {
                "component": "runtime_identity",
                "url": f"http://127.0.0.1:{http_port}/api/runtime/identity",
                "runtime_identity": runtime_identity or {},
            },
        ),
        (
            "application_health",
            profile_identity_ok,
            {
                "component": "deployment_profile_identity",
                "expected_profile_hash": profile.sha256,
                "expected_environment": profile.environment,
                "expected_target": profile.ssh_target,
                "actual_profile_hash": (runtime_identity or {}).get("deployment_profile_hash"),
                "actual_environment": (runtime_identity or {}).get("deployment_environment"),
                "actual_target": (runtime_identity or {}).get("deployment_target"),
            },
        ),
        (
            "application_health",
            developer_ok,
            {"component": "developer", "url": f"http://127.0.0.1:{developer_port}/"},
        ),
        ("smoke_test", smoke_ok, smoke_details),
    ]
    for stage, ready, details in checks:
        reporter.emit(
            "status",
            stage,
            "ok" if ready else "failed",
            "Ready." if ready else "Not ready.",
            **details,
        )
    ready = all(check_ready for _, check_ready, _ in checks)
    failed_stage = next(
        (stage for stage, check_ready, _ in checks if not check_ready),
        "ready",
    )
    state_store.write(
        command="status",
        stage="ready" if ready else failed_stage,
        status="ok" if ready else "failed",
        message=(
            "Presentation environment is fully ready."
            if ready
            else "Presentation environment is not fully ready."
        ),
    )
    reporter.emit(
        "status",
        "ready",
        "ok" if ready else "failed",
        "All readiness criteria passed." if ready else "One or more readiness criteria failed.",
    )
    return 0 if ready else 1


def contract_payload(
    layout: RepositoryLayout,
    profile: DeploymentProfile | None = None,
) -> dict[str, object]:
    profile = profile or load_deployment_profile(layout.root)
    controller = "scripts/presentation/presentationctl.py"
    return {
        "schema": CONTRACT_SCHEMA,
        "working_directory": str(layout.root),
        "commands": {
            "start": "scripts/presentation/start-presentation.cmd",
            "controller_start": f"python {controller} --json start --open-browser",
            "controller_stop": f"python {controller} --json stop",
            "controller_status": f"python {controller} --json status",
            "controller_dry_run": f"python {controller} --json start --dry-run",
            "controller_test": f"python {controller} --json test",
        },
        "port_overrides": (
            "start, status, and test accept --tunnel-port, --http-port, and "
            "--developer-port before any PowerShell passthrough arguments"
        ),
        "stages": list(STAGES),
        "deployment_profile": {
            "path": str(profile.path),
            "sha256": profile.sha256,
            "environment": profile.environment,
            "managed_by": profile.managed_by,
        },
        "urls": profile.urls,
        "spark_tunnel": f"127.0.0.1:{profile.local_tunnel_port}",
        "network_topology": {
            "environment": profile.environment,
            "ssh_target": profile.ssh_target,
            "kubernetes_context": profile.kubernetes_context,
            "kubernetes_namespace": profile.namespace,
            "spark_target": profile.spark_target,
            "spark_service_port": profile.spark_service_port,
            "spark_lifecycle": profile.spark_lifecycle,
            "remote_bridge": f"127.0.0.1:{profile.remote_bridge_port}",
            "local_tunnel": f"127.0.0.1:{profile.local_tunnel_port}",
            "container_spark_endpoint": f"host.docker.internal:{profile.local_tunnel_port}",
            "container_http_port": profile.container_http_port,
            "container_developer_port": profile.container_developer_port,
        },
        "data_contract": {
            "catalog": profile.catalog,
            "namespace": profile.data_namespace,
            "table": profile.table,
            "warehouse": profile.warehouse,
            "snapshot_id": profile.snapshot_id,
            "serving_start": profile.serving_start,
            "serving_end": profile.serving_end,
            "distinct_days": profile.distinct_days,
            "aoi_ids": list(profile.aoi_ids),
            "resolutions_km": list(profile.resolutions_km),
        },
        "interactive": {
            "ssh": True,
            "visible_terminal_required": False,
            "expected_password_prompts": (
                "0 through the Tk AskPass credential path; the direct CLI fallback prompts "
                "once after a successful entry and OpenSSH may retry invalid input"
            ),
            "password_storage": (
                "Windows Credential Manager only when the user selects remember; otherwise "
                "a temporary credential is deleted immediately after startup"
            ),
            "direct_cli_fallback_uses_visible_terminal": True,
        },
        "required_compose_services": sorted(REQUIRED_COMPOSE_SERVICES),
        "one_shot_compose_services": ["eez-bootstrap"],
        "expected_datasets": sorted(EXPECTED_DATASETS),
        "ready_criteria": {
            "live": [
                "Compose services app and postgis are running",
                "EEZ source, PostGIS import, topology, and persistent domain-tile manifest are complete",
                f"127.0.0.1:{profile.local_tunnel_port} accepts TCP connections",
                "official site, Dashboard, health endpoint, and developer service respond",
            ],
            "accepted": (
                "live criteria plus a matching presentation-smoke-state.json proving "
                "all five Iceberg datasets were queried"
            ),
        },
        "exit_codes": {str(code): meaning for code, meaning in EXIT_CODES.items()},
        "owned_resources": [
            "Compose project bdde38-presentation",
            "presentation bridge PowerShell process recorded in presentation-bridge.pid",
            "SSH and Kubernetes port forwards created by that bridge",
            "presentation runtime state, PID, transcript, and lock files",
        ],
        "shared_resources": [
            "Sea1 HDFS and YARN workloads",
            "the existing Spark Thrift Server on the formal cluster",
        ],
        "state_files": {
            "controller": str(layout.runtime_dir / "presentation-controller-state.json"),
            "smoke": str(layout.runtime_dir / "presentation-smoke-state.json"),
            "spatial": str(layout.spatial_manifest),
            "runtime_config": str(
                layout.runtime_dir / "presentation" / "runtime-config-state.json"
            ),
            "bridge_pid": str(layout.runtime_dir / "presentation-bridge.pid"),
            "bridge_ready": str(layout.runtime_dir / "presentation-bridge.ready"),
            "bridge_owner_evidence": str(
                layout.runtime_dir / "presentation-bridge-owner.json"
            ),
        },
        "log_files": {
            "controller": str(layout.runtime_dir / "presentation-controller-events.jsonl"),
            "bridge": str(layout.runtime_dir / "presentation-bridge-transcript.txt"),
            "smoke": str(layout.runtime_dir / "presentation-smoke-transcript.txt"),
            "docker": "docker compose -f compose.presentation.yaml logs app postgis",
        },
    }


def normalize_passthrough(values: Sequence[str]) -> list[str]:
    values = list(values)
    return values[1:] if values[:1] == ["--"] else values


def action_command(
    action: str,
    layout: RepositoryLayout,
    profile: DeploymentProfile,
    reporter: Reporter,
    state_store: StateStore,
    *,
    passthrough: Sequence[str],
    dry_run: bool,
    open_browser: bool,
    http_port: int,
) -> int:
    adapter = PowerShellAdapter(layout, reporter)
    runtime_state_store = RuntimeConfigStateStore(
        layout.runtime_dir / "presentation",
        repo_root=layout.root,
    )
    errors = adapter.validate(action)
    if errors:
        for error in errors:
            reporter.emit(action, "preflight", "failed", error)
        state_store.write(
            command=action,
            stage="preflight",
            status="failed",
            message="Presentation preflight failed.",
        )
        return 2

    reporter.emit(action, "preflight", "ok", "Required local files are present.")
    lock = OperationLock(layout.runtime_dir / "presentation-controller.lock")
    try:
        with lock:
            process_environment: dict[str, str] | None = None
            prepared_runtime: dict[str, object] | None = None
            runtime_instance_id: str | None = None
            if action == "start" and not dry_run:
                prepared_runtime = runtime_state_store.prepare_generation(
                    validate=lambda: load_config(
                        layout.root / "config" / "presentation" / "adapter.runtime.json"
                    )
                )
                runtime_instance_id = str(uuid.uuid4())
                process_environment = os.environ.copy()
                process_environment.update(
                    {
                        "BDDE38_CONTROL_DIR": str(layout.runtime_dir / "presentation"),
                        "BDDE38_RUNTIME_GENERATION": str(prepared_runtime["generation"]),
                        "BDDE38_RUNTIME_INSTANCE_ID": runtime_instance_id,
                        "BDDE38_COMPOSE_HASH": file_sha256(layout.compose_file),
                        "BDDE38_DEPLOYMENT_PROFILE": str(profile.path),
                        "BDDE38_DEPLOYMENT_PROFILE_HASH": profile.sha256,
                        "BDDE38_DEPLOYMENT_ENVIRONMENT": profile.environment,
                        "BDDE38_DEPLOYMENT_TARGET": profile.ssh_target,
                    }
                )
                reporter.emit(
                    action,
                    "preflight",
                    "ok",
                    "A controlled runtime generation was prepared.",
                    runtime_generation=prepared_runtime["generation"],
                    runtime_instance_id=runtime_instance_id,
                    applied=prepared_runtime.get("applied") or [],
                )
            state_store.write(
                command=action,
                stage="preflight",
                status="running",
                message=f"Presentation {action} is running.",
            )
            reporter.emit(action, "preflight", "running", f"Running {action} adapter.")
            result = adapter.run(
                action,
                normalize_passthrough(passthrough),
                dry_run=dry_run,
                environment=process_environment,
            )

            if result.exit_code != 0:
                exit_code = (
                    result.exit_code
                    if result.exit_code in EXIT_CODES
                    else STAGE_EXIT_CODES.get(result.last_stage, 1)
                )
                message = f"Presentation {action} failed with exit code {exit_code}."
                reporter.emit(
                    action,
                    result.last_stage,
                    "failed",
                    message,
                    exit_code=exit_code,
                    script_exit_code=result.exit_code,
                )
                state_store.write(
                    command=action,
                    stage=result.last_stage,
                    status="failed",
                    message=message,
                )
                if action == "start" and prepared_runtime is not None:
                    runtime_state_store.mark_failed(result.last_stage, message)
                return exit_code

            if dry_run:
                final_stage = "preflight"
                message = "Dry run completed; no services were changed."
            elif action == "start":
                smoke_skipped = any(
                    value.casefold() == "-skipsmoke"
                    for value in normalize_passthrough(passthrough)
                )
                final_stage = "application_health" if smoke_skipped else "ready"
                message = (
                    "Application started without full smoke acceptance."
                    if smoke_skipped
                    else "Presentation environment is ready."
                )
            elif action == "test":
                final_stage = "smoke_test"
                message = "Full presentation acceptance passed."
            else:
                final_stage = "stopped"
                message = "Presentation environment is stopped."

            if (
                not dry_run
                and action in {"start", "test"}
                and (action == "test" or final_stage == "ready")
            ):
                identity = runtime_identity_probe(http_port)
                if identity is None:
                    message = "Runtime identity is unavailable after acceptance."
                    runtime_state_store.mark_failed("smoke_test", message)
                    reporter.emit(action, "smoke_test", "failed", message)
                    return 22
                if runtime_instance_id and identity.get("runtime_instance_id") != runtime_instance_id:
                    message = "The accepted Runtime instance does not match the prepared generation."
                    runtime_state_store.mark_failed("smoke_test", message)
                    reporter.emit(
                        action,
                        "smoke_test",
                        "failed",
                        message,
                        expected_runtime_instance_id=runtime_instance_id,
                        actual_runtime_instance_id=identity.get("runtime_instance_id"),
                    )
                    return 22
                runtime_state_store.mark_effective(identity)
            reporter.emit(action, final_stage, "ok", message)
            state_store.write(
                command=action,
                stage=final_stage,
                status="ok",
                message=message,
            )
    except RuntimeError as exc:
        reporter.emit(action, "preflight", "failed", str(exc))
        return 3
    if action == "start" and open_browser and not dry_run:
        webbrowser.open(f"http://127.0.0.1:{http_port}/")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Human and GUI-safe controller for the BDDE38 presentation environment."
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit one JSON event per line for a future GUI adapter.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--deployment-profile",
        type=Path,
        default=None,
        help=argparse.SUPPRESS,
    )

    subparsers = parser.add_subparsers(dest="command", required=True)
    start = subparsers.add_parser("start", help="Start the complete presentation environment.")
    start.add_argument("--dry-run", action="store_true")
    start.add_argument("--open-browser", action="store_true")
    start.add_argument("--tunnel-port", type=int, default=None)
    start.add_argument("--http-port", type=int, default=None)
    start.add_argument("--developer-port", type=int, default=None)
    start.add_argument("passthrough", nargs=argparse.REMAINDER)

    stop = subparsers.add_parser("stop", help="Stop resources owned by the presentation environment.")
    stop.add_argument("--dry-run", action="store_true")
    stop.add_argument("passthrough", nargs=argparse.REMAINDER)

    status = subparsers.add_parser("status", help="Probe the current presentation environment.")
    status.add_argument("--tunnel-port", type=int, default=None)
    status.add_argument("--http-port", type=int, default=None)
    status.add_argument("--developer-port", type=int, default=None)

    test = subparsers.add_parser("test", help="Run full five-dataset acceptance checks.")
    test.add_argument("--dry-run", action="store_true")
    test.add_argument("--tunnel-port", type=int, default=None)
    test.add_argument("--http-port", type=int, default=None)
    test.add_argument("--developer-port", type=int, default=None)
    test.add_argument("passthrough", nargs=argparse.REMAINDER)

    subparsers.add_parser("contract", help="Emit the stable Tk integration contract.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    layout = RepositoryLayout(arguments.repo_root.resolve())
    reporter = Reporter(
        json_lines=arguments.json,
        event_log_path=layout.runtime_dir / "presentation-controller-events.jsonl",
    )
    state_store = StateStore(layout.runtime_dir / "presentation-controller-state.json")

    try:
        profile = load_deployment_profile(layout.root, arguments.deployment_profile)
    except DeploymentProfileError as exc:
        reporter.emit("preflight", "preflight", "failed", str(exc))
        state_store.write(
            command="preflight",
            stage="preflight",
            status="failed",
            message=str(exc),
        )
        return 2

    if hasattr(arguments, "tunnel_port"):
        arguments.tunnel_port = arguments.tunnel_port or profile.local_tunnel_port
    if hasattr(arguments, "http_port"):
        arguments.http_port = arguments.http_port or profile.host_http_port
    if hasattr(arguments, "developer_port"):
        arguments.developer_port = (
            arguments.developer_port or profile.host_developer_port
        )

    if arguments.command == "contract":
        reporter.emit(
            "contract",
            "preflight",
            "ok",
            "Presentation integration contract.",
            contract=contract_payload(layout, profile),
        )
        return 0

    if arguments.command == "status":
        return status_command(
            layout,
            profile,
            reporter,
            state_store,
            tunnel_port=arguments.tunnel_port,
            http_port=arguments.http_port,
            developer_port=arguments.developer_port,
        )

    passthrough = normalize_passthrough(getattr(arguments, "passthrough", []))
    if arguments.command == "start":
        passthrough = [
            "-LocalTunnelPort",
            str(arguments.tunnel_port),
            "-HttpPort",
            str(arguments.http_port),
            "-DeveloperPort",
            str(arguments.developer_port),
            "-DeploymentProfilePath",
            str(profile.path),
            *passthrough,
        ]
    elif arguments.command == "test":
        passthrough = [
            "-TunnelPort",
            str(arguments.tunnel_port),
            "-HttpPort",
            str(arguments.http_port),
            "-DeveloperPort",
            str(arguments.developer_port),
            "-DeploymentProfilePath",
            str(profile.path),
            *passthrough,
        ]

    return action_command(
        arguments.command,
        layout,
        profile,
        reporter,
        state_store,
        passthrough=passthrough,
        dry_run=arguments.dry_run,
        open_browser=getattr(arguments, "open_browser", False),
        http_port=getattr(arguments, "http_port", profile.host_http_port),
    )


if __name__ == "__main__":
    raise SystemExit(main())
