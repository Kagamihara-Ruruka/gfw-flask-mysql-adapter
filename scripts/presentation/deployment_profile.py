from __future__ import annotations

import datetime as dt
import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROFILE_SCHEMA = "bdde38.presentation.deployment.v1"
DEFAULT_PROFILE_REF = Path("config/presentation/deployment.profile.json")
_SSH_TARGET_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+$")
_KUBERNETES_TARGET_PATTERN = re.compile(
    r"^(?:deployment|pod|statefulset)/[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$"
)
_KUBERNETES_CONTEXT_PATTERN = re.compile(r"^[A-Za-z0-9_.@/-]+$")
_SQL_TABLE_PATTERN = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2}$"
)
_HDFS_URI_PATTERN = re.compile(r"^hdfs:///[A-Za-z0-9_./-]+$")
_AOI_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class DeploymentProfileError(ValueError):
    pass


def _object(document: dict[str, Any], key: str) -> dict[str, Any]:
    value = document.get(key)
    if not isinstance(value, dict):
        raise DeploymentProfileError(f"deployment profile field {key!r} must be an object")
    return value


def _text(document: dict[str, Any], key: str) -> str:
    value = str(document.get(key) or "").strip()
    if not value:
        raise DeploymentProfileError(f"deployment profile field {key!r} is required")
    return value


def _port(document: dict[str, Any], key: str) -> int:
    try:
        value = int(document.get(key))
    except (TypeError, ValueError) as exc:
        raise DeploymentProfileError(f"deployment profile port {key!r} is invalid") from exc
    if value < 1 or value > 65535:
        raise DeploymentProfileError(f"deployment profile port {key!r} is out of range")
    return value


@dataclass(frozen=True)
class DeploymentProfile:
    path: Path
    document: dict[str, Any]
    sha256: str
    profile: str
    managed_by: str
    connectivity_mode: str
    tailscale_required: bool
    required_routes: tuple[str, ...]
    public_ssh_forbidden: bool
    environment: str
    ssh_target: str
    kubernetes_context: str
    namespace: str
    spark_target: str
    expected_yarn_nodes: int
    spark_service_port: int
    spark_lifecycle: str
    remote_bridge_port: int
    local_tunnel_port: int
    host_http_port: int
    host_developer_port: int
    container_http_port: int
    container_developer_port: int
    catalog: str
    data_namespace: str
    table: str
    warehouse: str
    snapshot_id: str
    serving_start: str
    serving_end: str
    distinct_days: int
    aoi_ids: tuple[str, ...]
    resolutions_km: tuple[int, ...]

    @property
    def credential_target(self) -> str:
        return f"BDDE38 Presentation SSH {self.ssh_target}"

    @property
    def ssh_username(self) -> str:
        return self.ssh_target.split("@", 1)[0]

    @property
    def ssh_host(self) -> str:
        return self.ssh_target.split("@", 1)[1]

    @property
    def route_label(self) -> str:
        if self.connectivity_mode == "tailscale_subnet_direct":
            return "Tailscale direct subnet"
        return self.connectivity_mode.replace("_", " ")

    @property
    def urls(self) -> dict[str, str]:
        base = f"http://127.0.0.1:{self.host_http_port}"
        return {
            "official": f"{base}/",
            "dashboard": f"{base}/dashboard/",
            "developer": f"http://127.0.0.1:{self.host_developer_port}/",
            "health": f"{base}/api/health",
        }

    def public_document(self) -> dict[str, Any]:
        return json.loads(json.dumps(self.document))


def load_deployment_profile(
    repo_root: str | Path,
    path: str | Path | None = None,
) -> DeploymentProfile:
    root = Path(repo_root).resolve()
    profile_path = Path(path) if path is not None else root / DEFAULT_PROFILE_REF
    if not profile_path.is_absolute():
        profile_path = root / profile_path
    profile_path = profile_path.resolve()
    try:
        raw = profile_path.read_bytes()
        document = json.loads(raw.decode("utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DeploymentProfileError(f"cannot load deployment profile: {profile_path}") from exc
    if not isinstance(document, dict):
        raise DeploymentProfileError("deployment profile root must be an object")
    if document.get("schema") != PROFILE_SCHEMA:
        raise DeploymentProfileError(
            f"deployment profile schema must be {PROFILE_SCHEMA!r}"
        )
    if _text(document, "profile").upper() != "PRESENTATION":
        raise DeploymentProfileError("formal deployment profile must be PRESENTATION")
    if _text(document, "managed_by") != "presentationctl":
        raise DeploymentProfileError("formal deployment profile must be managed by presentationctl")

    connectivity = _object(document, "connectivity")
    connectivity_mode = _text(connectivity, "mode")
    if connectivity_mode != "tailscale_subnet_direct":
        raise DeploymentProfileError("formal presentation profile must use Tailscale direct subnet mode")
    tailscale_required = bool(connectivity.get("tailscale_required"))
    public_ssh_forbidden = bool(connectivity.get("public_ssh_forbidden"))
    if not tailscale_required or not public_ssh_forbidden:
        raise DeploymentProfileError(
            "formal presentation profile must require Tailscale and forbid public SSH"
        )
    required_routes = tuple(str(value).strip() for value in connectivity.get("required_routes") or ())
    if not required_routes:
        raise DeploymentProfileError("connectivity.required_routes must not be empty")
    try:
        parsed_required_routes = tuple(ipaddress.ip_network(value, strict=False) for value in required_routes)
    except ValueError as exc:
        raise DeploymentProfileError("connectivity.required_routes contains an invalid CIDR") from exc

    cluster = _object(document, "cluster")
    ports = _object(document, "ports")
    data = _object(document, "data")
    ssh_target = _text(cluster, "ssh_target")
    spark_target = _text(cluster, "spark_target")
    if not _SSH_TARGET_PATTERN.fullmatch(ssh_target):
        raise DeploymentProfileError("deployment profile SSH target is invalid")
    try:
        ssh_host = ipaddress.ip_address(ssh_target.split("@", 1)[1])
    except ValueError as exc:
        raise DeploymentProfileError("deployment profile SSH host must be an IP address") from exc
    if not any(ssh_host in route for route in parsed_required_routes):
        raise DeploymentProfileError("deployment profile SSH target is outside required Tailscale routes")
    if not _KUBERNETES_TARGET_PATTERN.fullmatch(spark_target):
        raise DeploymentProfileError("deployment profile Spark target is invalid")
    kubernetes_context = _text(cluster, "kubernetes_context")
    if not _KUBERNETES_CONTEXT_PATTERN.fullmatch(kubernetes_context):
        raise DeploymentProfileError("deployment profile Kubernetes context is invalid")
    spark_lifecycle = _text(cluster, "spark_lifecycle")
    if spark_lifecycle != "reuse_required":
        raise DeploymentProfileError(
            "formal presentation profile must require reuse of Spark Thrift"
        )

    expected_yarn_nodes = int(cluster.get("expected_yarn_nodes") or 0)
    if expected_yarn_nodes < 1:
        raise DeploymentProfileError("expected_yarn_nodes must be positive")
    port_values = {
        "remote_bridge": _port(ports, "remote_bridge"),
        "local_tunnel": _port(ports, "local_tunnel"),
        "host_http": _port(ports, "host_http"),
        "host_developer": _port(ports, "host_developer"),
        "container_http": _port(ports, "container_http"),
        "container_developer": _port(ports, "container_developer"),
    }
    if len({port_values["local_tunnel"], port_values["host_http"], port_values["host_developer"]}) != 3:
        raise DeploymentProfileError("local tunnel and public service ports must differ")

    serving_start = _text(data, "serving_start")
    serving_end = _text(data, "serving_end")
    try:
        start_date = dt.date.fromisoformat(serving_start)
        end_date = dt.date.fromisoformat(serving_end)
    except ValueError as exc:
        raise DeploymentProfileError("serving date range must use ISO dates") from exc
    distinct_days = int(data.get("distinct_days") or 0)
    if end_date < start_date or distinct_days != (end_date - start_date).days + 1:
        raise DeploymentProfileError("serving date range and distinct_days disagree")
    aoi_ids = tuple(str(value).strip() for value in data.get("aoi_ids") or ())
    resolutions = tuple(int(value) for value in data.get("resolutions_km") or ())
    if not aoi_ids or not all(aoi_ids):
        raise DeploymentProfileError("at least one AOI is required")
    if any(not _AOI_PATTERN.fullmatch(value) for value in aoi_ids):
        raise DeploymentProfileError("deployment profile contains an invalid AOI")
    if not resolutions or any(value <= 0 for value in resolutions):
        raise DeploymentProfileError("at least one positive resolution is required")
    table = _text(data, "table")
    warehouse = _text(data, "warehouse")
    if not _SQL_TABLE_PATTERN.fullmatch(table):
        raise DeploymentProfileError("deployment profile Gold table is invalid")
    if not _HDFS_URI_PATTERN.fullmatch(warehouse):
        raise DeploymentProfileError("deployment profile warehouse URI is invalid")

    return DeploymentProfile(
        path=profile_path,
        document=document,
        sha256=hashlib.sha256(raw).hexdigest(),
        profile=_text(document, "profile").upper(),
        managed_by=_text(document, "managed_by"),
        connectivity_mode=connectivity_mode,
        tailscale_required=tailscale_required,
        required_routes=required_routes,
        public_ssh_forbidden=public_ssh_forbidden,
        environment=_text(cluster, "environment"),
        ssh_target=ssh_target,
        kubernetes_context=kubernetes_context,
        namespace=_text(cluster, "namespace"),
        spark_target=spark_target,
        expected_yarn_nodes=expected_yarn_nodes,
        spark_service_port=_port(cluster, "spark_service_port"),
        spark_lifecycle=spark_lifecycle,
        remote_bridge_port=port_values["remote_bridge"],
        local_tunnel_port=port_values["local_tunnel"],
        host_http_port=port_values["host_http"],
        host_developer_port=port_values["host_developer"],
        container_http_port=port_values["container_http"],
        container_developer_port=port_values["container_developer"],
        catalog=_text(data, "catalog"),
        data_namespace=_text(data, "namespace"),
        table=table,
        warehouse=warehouse,
        snapshot_id=_text(data, "snapshot_id"),
        serving_start=serving_start,
        serving_end=serving_end,
        distinct_days=distinct_days,
        aoi_ids=aoi_ids,
        resolutions_km=resolutions,
    )
