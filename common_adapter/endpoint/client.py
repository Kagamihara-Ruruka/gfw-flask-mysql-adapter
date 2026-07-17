from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

DEFAULT_ENDPOINT_TIMEOUT_SECONDS = 3.0
DEFAULT_ENDPOINT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024
DEFAULT_CATALOG_PATHS = ("catalog", "/api/v1/catalog")
DEFAULT_HEALTH_PATHS = ("/health", "/api/v1/health")
DEFAULT_DISCOVERY_PATHS = ("/openapi.json", "/docs")


@dataclass(frozen=True)
class EndpointTarget:
    base_url: str
    base_path: str
    catalog_paths: tuple[str, ...]
    health_paths: tuple[str, ...]
    discovery_paths: tuple[str, ...]
    timeout_seconds: float
    max_response_bytes: int
    headers: dict[str, str]


@dataclass(frozen=True)
class EndpointJsonResponse:
    body: Any
    response_bytes: int
    http_read_ms: float
    json_decode_ms: float


class EndpointRequestError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        url: str,
        status_code: int | None = None,
        reachable: bool = False,
        body: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.url = url
        self.status_code = status_code
        self.reachable = reachable
        self.body = body


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _paths(value: Any, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if isinstance(value, str) and value.strip():
        return (value.strip(),)
    if isinstance(value, list):
        return tuple(str(item).strip() for item in value if str(item).strip())
    return fallback


def _placeholder(value: Any) -> bool:
    text = str(value or "").strip()
    return not text or (text.startswith("<") and text.endswith(">"))


def _endpoint_config(data: dict[str, Any]) -> dict[str, Any]:
    endpoint = data.get("endpoint")
    if isinstance(endpoint, dict):
        return endpoint
    if isinstance(endpoint, str):
        return {"base_url": endpoint}
    return _mapping(data.get("http"))


def _base_url(data: dict[str, Any], endpoint: dict[str, Any]) -> str:
    direct = (
        endpoint.get("base_url")
        or endpoint.get("url")
        or endpoint.get("uri")
        or data.get("base_url")
        or data.get("url")
        or data.get("uri")
    )
    if direct and not _placeholder(direct):
        return str(direct).strip().rstrip("/")
    scheme = str(endpoint.get("scheme") or data.get("scheme") or "http").strip() or "http"
    host = str(endpoint.get("host") or data.get("host") or "").strip()
    port = endpoint.get("port", data.get("port"))
    if _placeholder(host):
        return ""
    if port in (None, ""):
        return f"{scheme}://{host}"
    port_text = str(port).strip()
    if not port_text.isdigit():
        return ""
    return f"{scheme}://{host}:{int(port_text)}"


def _path(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text if text.startswith("/") else f"/{text}"


def _timeout(endpoint: dict[str, Any]) -> float:
    try:
        value = float(endpoint.get("timeout_seconds") or DEFAULT_ENDPOINT_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        value = DEFAULT_ENDPOINT_TIMEOUT_SECONDS
    return max(0.2, min(value, 30.0))


def _max_response_bytes(endpoint: dict[str, Any]) -> int:
    try:
        value = int(endpoint.get("max_response_bytes") or DEFAULT_ENDPOINT_MAX_RESPONSE_BYTES)
    except (TypeError, ValueError):
        value = DEFAULT_ENDPOINT_MAX_RESPONSE_BYTES
    return max(64 * 1024, value)


def _auth_headers(data: dict[str, Any], endpoint: dict[str, Any]) -> dict[str, str]:
    auth = _mapping(endpoint.get("auth")) or _mapping(data.get("auth"))
    auth_type = str(auth.get("type") or "none").strip().lower()
    if auth_type in {"", "none", "noauth"}:
        return {}
    if auth_type == "bearer":
        token = str(auth.get("token") or os.getenv(str(auth.get("token_env") or "")) or "").strip()
        return {"Authorization": f"Bearer {token}"} if token else {}
    if auth_type in {"header", "api_key", "apikey"}:
        name = str(auth.get("header") or auth.get("header_name") or "Authorization").strip()
        value = str(auth.get("value") or os.getenv(str(auth.get("value_env") or "")) or "").strip()
        return {name: value} if name and value else {}
    return {}


def endpoint_target(data: dict[str, Any]) -> EndpointTarget | None:
    endpoint = _endpoint_config(data)
    base_url = _base_url(data, endpoint)
    if not base_url:
        return None
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return EndpointTarget(
        base_url=base_url,
        base_path=_path(endpoint.get("base_path") or data.get("base_path")),
        catalog_paths=_paths(
            endpoint.get("catalog_paths") or endpoint.get("catalog_endpoint"),
            DEFAULT_CATALOG_PATHS,
        ),
        health_paths=_paths(
            endpoint.get("health_paths") or endpoint.get("health_endpoint"),
            DEFAULT_HEALTH_PATHS,
        ),
        discovery_paths=_paths(endpoint.get("discovery_paths"), DEFAULT_DISCOVERY_PATHS),
        timeout_seconds=_timeout(endpoint),
        max_response_bytes=_max_response_bytes(endpoint),
        headers=_auth_headers(data, endpoint),
    )


def endpoint_url(target: EndpointTarget, path: str) -> str:
    if path.startswith(("http://", "https://")):
        return path
    if path.startswith("/"):
        return f"{target.base_url.rstrip('/')}/{path.lstrip('/')}"
    prefix = f"{target.base_url.rstrip('/')}{target.base_path}"
    return f"{prefix.rstrip('/')}/{path.lstrip('/')}"


class EndpointHttpClient:
    def __init__(self, target: EndpointTarget) -> None:
        self.target = target

    @classmethod
    def from_config(cls, data: dict[str, Any]) -> "EndpointHttpClient":
        target = endpoint_target(data)
        if target is None:
            raise ValueError("endpoint base_url or host/port is not configured")
        return cls(target)

    def get_json(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        max_response_bytes: int | None = None,
    ) -> Any:
        return self.get_json_timed(
            path,
            params=params,
            max_response_bytes=max_response_bytes,
        ).body

    def get_json_timed(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        max_response_bytes: int | None = None,
    ) -> EndpointJsonResponse:
        url = endpoint_url(self.target, path)
        query = {
            str(key): value
            for key, value in (params or {}).items()
            if value is not None and str(value) != ""
        }
        if query:
            url = f"{url}{'&' if '?' in url else '?'}{urlencode(query)}"
        request = Request(
            url,
            headers={"Accept": "application/json", **self.target.headers},
            method="GET",
        )
        limit = max_response_bytes or self.target.max_response_bytes
        http_started = time.perf_counter()
        try:
            with urlopen(request, timeout=self.target.timeout_seconds) as response:
                raw = response.read(limit + 1)
                status_code = int(response.status)
        except HTTPError as exc:
            raw = exc.read(min(limit, 1024 * 1024))
            body = _decode_json(raw)
            detail = body.get("error") if isinstance(body, dict) else None
            raise EndpointRequestError(
                str(detail or f"HTTP {exc.code}"),
                url=url,
                status_code=int(exc.code),
                reachable=True,
                body=body,
            ) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise EndpointRequestError(
                str(exc),
                url=url,
                reachable=False,
            ) from exc
        http_read_ms = (time.perf_counter() - http_started) * 1000
        if len(raw) > limit:
            raise EndpointRequestError(
                f"endpoint response exceeds {limit} bytes",
                url=url,
                status_code=status_code,
                reachable=True,
            )
        decode_started = time.perf_counter()
        body = _decode_json(raw)
        json_decode_ms = (time.perf_counter() - decode_started) * 1000
        if body is None:
            raise EndpointRequestError(
                f"HTTP {status_code}, non-json response",
                url=url,
                status_code=status_code,
                reachable=True,
            )
        return EndpointJsonResponse(
            body=body,
            response_bytes=len(raw),
            http_read_ms=round(http_read_ms, 3),
            json_decode_ms=round(json_decode_ms, 3),
        )

    def first_json(self, paths: Iterable[str], *, max_response_bytes: int | None = None) -> tuple[str, Any]:
        last_error: EndpointRequestError | None = None
        for path in paths:
            try:
                return path, self.get_json(path, max_response_bytes=max_response_bytes)
            except EndpointRequestError as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise ValueError("no endpoint paths configured")


def _decode_json(raw: bytes) -> Any | None:
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
