from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

DEFAULT_ENDPOINT_PROBE_TIMEOUT_SECONDS = 3.0
MAX_ENDPOINT_PROBE_BYTES = 128 * 1024
DEFAULT_ENDPOINT_CATALOG_PATHS = ("/catalog", "/api/v1/catalog")
DEFAULT_ENDPOINT_HEALTH_PATHS = ("/health", "/api/v1/health")
DEFAULT_ENDPOINT_DISCOVERY_PATHS = ("/openapi.json", "/docs")


@dataclass(frozen=True)
class EndpointProbeTarget:
    base_url: str
    base_path: str
    catalog_paths: tuple[str, ...]
    health_paths: tuple[str, ...]
    discovery_paths: tuple[str, ...]
    timeout_seconds: float
    headers: dict[str, str]


@dataclass(frozen=True)
class EndpointProbeAttempt:
    url: str
    path: str
    ok: bool
    reachable: bool
    status_code: int | None
    json_body: Any | None
    detail: str


def _as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_tuple(value: Any, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if isinstance(value, str) and value.strip():
        return (value.strip(),)
    if isinstance(value, list):
        return tuple(str(item).strip() for item in value if str(item).strip())
    return fallback


def _clean_base_url(value: Any) -> str:
    text = str(value or "").strip()
    if _is_placeholder(text):
        return ""
    return text.rstrip("/")


def _is_placeholder(value: str) -> bool:
    text = str(value or "").strip()
    return not text or (text.startswith("<") and text.endswith(">"))


def _clean_path(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text if text.startswith("/") else f"/{text}"


def _endpoint_config(data: dict[str, Any]) -> dict[str, Any]:
    endpoint = data.get("endpoint")
    if isinstance(endpoint, dict):
        return endpoint
    if isinstance(endpoint, str):
        return {"base_url": endpoint}
    http = data.get("http")
    if isinstance(http, dict):
        return http
    return {}


def _base_url_from_host_port(data: dict[str, Any], endpoint: dict[str, Any]) -> str:
    scheme = str(endpoint.get("scheme") or data.get("scheme") or "http").strip() or "http"
    host = str(endpoint.get("host") or data.get("host") or "").strip()
    port = endpoint.get("port", data.get("port"))
    if _is_placeholder(host):
        return ""
    if port in (None, ""):
        return f"{scheme}://{host}".rstrip("/")
    port_text = str(port).strip()
    if not port_text.isdigit():
        return ""
    return f"{scheme}://{host}:{int(port_text)}".rstrip("/")


def _base_url(data: dict[str, Any], endpoint: dict[str, Any]) -> str:
    direct = (
        endpoint.get("base_url")
        or endpoint.get("url")
        or endpoint.get("uri")
        or data.get("base_url")
        or data.get("url")
        or data.get("uri")
    )
    if direct:
        return _clean_base_url(direct)
    return _base_url_from_host_port(data, endpoint)


def _timeout_seconds(endpoint: dict[str, Any]) -> float:
    try:
        timeout = float(endpoint.get("timeout_seconds") or DEFAULT_ENDPOINT_PROBE_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        timeout = DEFAULT_ENDPOINT_PROBE_TIMEOUT_SECONDS
    return max(0.2, min(timeout, 30.0))


def _auth_headers(data: dict[str, Any], endpoint: dict[str, Any]) -> dict[str, str]:
    auth = _as_mapping(endpoint.get("auth")) or _as_mapping(data.get("auth"))
    auth_type = str(auth.get("type") or "none").strip().lower()
    if auth_type in {"", "none", "noauth"}:
        return {}
    if auth_type == "bearer":
        token = str(auth.get("token") or os.getenv(str(auth.get("token_env") or "")) or "").strip()
        return {"Authorization": f"Bearer {token}"} if token else {}
    if auth_type in {"header", "api_key", "apikey"}:
        header_name = str(auth.get("header") or auth.get("header_name") or "Authorization").strip()
        value = str(auth.get("value") or os.getenv(str(auth.get("value_env") or "")) or "").strip()
        return {header_name: value} if header_name and value else {}
    return {}


def endpoint_probe_target(data: dict[str, Any]) -> EndpointProbeTarget | None:
    endpoint = _endpoint_config(data)
    base_url = _base_url(data, endpoint)
    if not base_url:
        return None
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    base_path = _clean_path(endpoint.get("base_path") or data.get("base_path"))
    return EndpointProbeTarget(
        base_url=base_url,
        base_path=base_path,
        catalog_paths=_as_tuple(endpoint.get("catalog_paths") or endpoint.get("catalog_endpoint"), DEFAULT_ENDPOINT_CATALOG_PATHS),
        health_paths=_as_tuple(endpoint.get("health_paths") or endpoint.get("health_endpoint"), DEFAULT_ENDPOINT_HEALTH_PATHS),
        discovery_paths=_as_tuple(endpoint.get("discovery_paths"), DEFAULT_ENDPOINT_DISCOVERY_PATHS),
        timeout_seconds=_timeout_seconds(endpoint),
        headers=_auth_headers(data, endpoint),
    )


def _join_endpoint_url(target: EndpointProbeTarget, path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    base = target.base_url
    if target.base_path and not path.startswith(target.base_path + "/") and path != target.base_path:
        base = f"{base}{target.base_path}"
    return f"{base.rstrip('/')}/{path.lstrip('/')}"


def _fetch_json(target: EndpointProbeTarget, path: str) -> EndpointProbeAttempt:
    url = _join_endpoint_url(target, path)
    headers = {"Accept": "application/json", **target.headers}
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=target.timeout_seconds) as response:
            raw = response.read(MAX_ENDPOINT_PROBE_BYTES + 1)
            status_code = int(response.status)
            content_type = str(response.headers.get("Content-Type") or "")
    except HTTPError as exc:
        return EndpointProbeAttempt(
            url=url,
            path=path,
            ok=False,
            reachable=True,
            status_code=int(exc.code),
            json_body=None,
            detail=f"HTTP {exc.code}",
        )
    except (URLError, TimeoutError, OSError) as exc:
        return EndpointProbeAttempt(
            url=url,
            path=path,
            ok=False,
            reachable=False,
            status_code=None,
            json_body=None,
            detail=str(exc),
        )

    if len(raw) > MAX_ENDPOINT_PROBE_BYTES:
        return EndpointProbeAttempt(
            url=url,
            path=path,
            ok=False,
            reachable=True,
            status_code=status_code,
            json_body=None,
            detail="probe response is too large",
        )

    text = raw.decode("utf-8", errors="replace")
    body = None
    json_ok = False
    if "json" in content_type.lower() or text.strip().startswith(("{", "[")):
        try:
            body = json.loads(text)
            json_ok = True
        except json.JSONDecodeError:
            json_ok = False
    return EndpointProbeAttempt(
        url=url,
        path=path,
        ok=200 <= status_code < 300 and json_ok,
        reachable=True,
        status_code=status_code,
        json_body=body,
        detail="json response" if json_ok else f"HTTP {status_code}, non-json response",
    )


class EndpointProbe:
    """Probe external HTTP endpoint configs without binding them to UI-specific schema."""

    def status_from_config(self, config_ref: str, data: dict[str, Any], active: bool) -> list[dict[str, Any]]:
        target = endpoint_probe_target(data)
        if target is None:
            return [
                {
                    "config_path": config_ref,
                    "endpoint_ref": str(data.get("name") or data.get("id") or "endpoint"),
                    "base_url": "-",
                    "enabled": active,
                    "configured": False,
                    "reachable": False,
                    "contract_detected": False,
                    "detail": "endpoint base_url or host/port is not configured",
                }
            ]

        attempts: list[EndpointProbeAttempt] = []
        probe_paths = dict.fromkeys((*target.catalog_paths, *target.health_paths, *target.discovery_paths))
        for path in probe_paths:
            attempt = _fetch_json(target, path)
            attempts.append(attempt)

        catalog_attempt = next((attempt for attempt in attempts if attempt.path in target.catalog_paths and attempt.ok), None)
        health_attempt = next((attempt for attempt in attempts if attempt.path in target.health_paths and attempt.ok), None)
        reachable_attempt = next((attempt for attempt in attempts if attempt.reachable), None)
        best_attempt = catalog_attempt or reachable_attempt or (attempts[0] if attempts else None)
        reachable = any(attempt.reachable for attempt in attempts)
        contract_detected = catalog_attempt is not None
        healthy = health_attempt is not None if target.health_paths else None
        detail = self._detail(catalog_attempt, health_attempt, best_attempt, bool(target.health_paths))
        return [
            {
                "config_path": config_ref,
                "endpoint_ref": str(data.get("name") or data.get("id") or "endpoint"),
                "base_url": f"{target.base_url}{target.base_path}",
                "enabled": active,
                "configured": True,
                "reachable": reachable,
                "contract_detected": contract_detected,
                "healthy": healthy,
                "health_path": health_attempt.path if health_attempt else None,
                "probe_path": best_attempt.path if best_attempt else "-",
                "status_code": best_attempt.status_code if best_attempt else None,
                "detail": detail,
            }
        ]

    def _detail(
        self,
        catalog_attempt: EndpointProbeAttempt | None,
        health_attempt: EndpointProbeAttempt | None,
        best_attempt: EndpointProbeAttempt | None,
        health_expected: bool,
    ) -> str:
        if catalog_attempt is not None:
            body = catalog_attempt.json_body
            if isinstance(body, dict):
                catalog_detail = f"catalog detected at {catalog_attempt.path}; keys: {', '.join(sorted(str(key) for key in body.keys())[:6]) or '-'}"
            elif isinstance(body, list):
                catalog_detail = f"catalog detected at {catalog_attempt.path}; {len(body)} items"
            else:
                catalog_detail = f"catalog detected at {catalog_attempt.path}"
            if health_attempt is not None:
                return f"{catalog_detail}; health ok at {health_attempt.path}"
            if health_expected:
                return f"{catalog_detail}; health endpoint unavailable"
            return catalog_detail
        if best_attempt is None:
            return "no endpoint probe paths configured"
        if best_attempt.reachable:
            return f"reachable via {best_attempt.path}; {best_attempt.detail}"
        return f"not reachable via {best_attempt.path}; {best_attempt.detail}"


DEFAULT_ENDPOINT_PROBE = EndpointProbe()


def endpoint_status_from_config(config_ref: str, data: dict[str, Any], active: bool) -> list[dict[str, Any]]:
    return DEFAULT_ENDPOINT_PROBE.status_from_config(config_ref, data, active)
