from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, replace
from datetime import date, timedelta
from hashlib import sha256
from threading import RLock
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


class BackdropConfigError(ValueError):
    pass


class BackdropRequestError(ValueError):
    pass


class BackdropProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class AerialBackdropSettings:
    enabled: bool
    provider: str
    endpoint: str
    layer: str
    fallback_layer: str
    date_policy: str
    lookback_days: int
    minimum_image_bytes: int
    image_format: str
    output_width: int
    output_height: int
    context_scale: float
    timeout_seconds: float
    max_response_bytes: int
    cache_max_entries: int
    browser_cache_seconds: int
    background_opacity: float
    scrim_opacity: float
    attribution: str

    @classmethod
    def from_runtime_config(cls, config: dict[str, Any]) -> AerialBackdropSettings | None:
        rendering = config.get("rendering")
        raw = rendering.get("aerial_backdrop") if isinstance(rendering, dict) else None
        if not isinstance(raw, dict) or not bool(raw.get("enabled")):
            return None

        required = (
            "provider",
            "endpoint",
            "layer",
            "fallback_layer",
            "date_policy",
            "lookback_days",
            "minimum_image_bytes",
            "image_format",
            "output_width",
            "output_height",
            "context_scale",
            "timeout_seconds",
            "max_response_bytes",
            "cache_max_entries",
            "browser_cache_seconds",
            "background_opacity",
            "scrim_opacity",
            "attribution",
        )
        missing = [key for key in required if key not in raw]
        if missing:
            raise BackdropConfigError(f"rendering.aerial_backdrop is missing: {', '.join(missing)}")

        endpoint = str(raw["endpoint"]).strip()
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            raise BackdropConfigError("aerial backdrop endpoint must be an https URL")

        date_policy = str(raw["date_policy"]).strip().lower()
        if date_policy != "latest_available":
            raise BackdropConfigError("aerial backdrop date_policy must be latest_available")
        lookback_days = int(raw["lookback_days"])
        minimum_image_bytes = int(raw["minimum_image_bytes"])
        max_response_bytes = int(raw["max_response_bytes"])
        if lookback_days < 0:
            raise BackdropConfigError("aerial backdrop lookback_days cannot be negative")
        if minimum_image_bytes < 1 or minimum_image_bytes > max_response_bytes:
            raise BackdropConfigError("aerial backdrop minimum_image_bytes is outside the response limits")

        return cls(
            enabled=True,
            provider=str(raw["provider"]).strip().lower(),
            endpoint=endpoint,
            layer=str(raw["layer"]).strip(),
            fallback_layer=str(raw["fallback_layer"]).strip(),
            date_policy=date_policy,
            lookback_days=lookback_days,
            minimum_image_bytes=minimum_image_bytes,
            image_format=str(raw["image_format"]).strip().lower(),
            output_width=int(raw["output_width"]),
            output_height=int(raw["output_height"]),
            context_scale=float(raw["context_scale"]),
            timeout_seconds=float(raw["timeout_seconds"]),
            max_response_bytes=max_response_bytes,
            cache_max_entries=int(raw["cache_max_entries"]),
            browser_cache_seconds=int(raw["browser_cache_seconds"]),
            background_opacity=float(raw["background_opacity"]),
            scrim_opacity=float(raw["scrim_opacity"]),
            attribution=str(raw["attribution"]).strip(),
        )


@dataclass(frozen=True)
class BackdropImage:
    content: bytes
    content_type: str
    provider: str
    layer: str
    bbox: tuple[float, float, float, float]
    source_date: str | None
    cache_hit: bool = False


class AerialImageProvider(Protocol):
    name: str

    def fetch(
        self,
        *,
        bbox: tuple[float, float, float, float],
        source_date: str | None,
    ) -> BackdropImage: ...


class NasaGibsWmsProvider:
    name = "nasa_gibs_wms"

    def __init__(self, settings: AerialBackdropSettings) -> None:
        self.settings = settings

    def fetch(
        self,
        *,
        bbox: tuple[float, float, float, float],
        source_date: str | None,
    ) -> BackdropImage:
        anchor = date.fromisoformat(source_date) if source_date else date.today()
        attempts = [
            (
                self.settings.layer,
                (anchor - timedelta(days=offset)).isoformat(),
                self.settings.minimum_image_bytes,
            )
            for offset in range(self.settings.lookback_days + 1)
        ]
        attempts.append((self.settings.fallback_layer, None, 1))
        errors: list[str] = []
        for layer, layer_date, minimum_bytes in attempts:
            try:
                content, content_type = self._fetch_layer(
                    layer,
                    bbox,
                    layer_date,
                    minimum_bytes=minimum_bytes,
                )
                return BackdropImage(
                    content=content,
                    content_type=content_type,
                    provider=self.name,
                    layer=layer,
                    bbox=bbox,
                    source_date=layer_date,
                )
            except BackdropProviderError as exc:
                errors.append(f"{layer}: {exc}")
        raise BackdropProviderError("; ".join(errors))

    def _fetch_layer(
        self,
        layer: str,
        bbox: tuple[float, float, float, float],
        source_date: str | None,
        *,
        minimum_bytes: int,
    ) -> tuple[bytes, str]:
        params: dict[str, Any] = {
            "SERVICE": "WMS",
            "REQUEST": "GetMap",
            "VERSION": "1.1.1",
            "LAYERS": layer,
            "STYLES": "",
            "FORMAT": self.settings.image_format,
            "TRANSPARENT": "FALSE",
            "WIDTH": self.settings.output_width,
            "HEIGHT": self.settings.output_height,
            "SRS": "EPSG:4326",
            "BBOX": ",".join(f"{value:.6f}" for value in bbox),
        }
        if source_date:
            params["TIME"] = source_date
        request = Request(
            f"{self.settings.endpoint}?{urlencode(params)}",
            headers={
                "Accept": self.settings.image_format,
                "User-Agent": "RRKAL-Common-Adapter/1.0",
            },
            method="GET",
        )
        try:
            with urlopen(request, timeout=self.settings.timeout_seconds) as response:
                content = response.read(self.settings.max_response_bytes + 1)
                content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0].lower()
        except HTTPError as exc:
            raise BackdropProviderError(f"HTTP {exc.code}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise BackdropProviderError(str(exc)) from exc

        if len(content) > self.settings.max_response_bytes:
            raise BackdropProviderError("image response exceeds configured byte limit")
        if not content_type.startswith("image/"):
            raise BackdropProviderError(f"unexpected content type {content_type or '-'}")
        if not content:
            raise BackdropProviderError("empty image response")
        if len(content) < minimum_bytes:
            raise BackdropProviderError("image response is below the configured detail threshold")
        return content, content_type


class BackdropImageCache:
    def __init__(self, max_entries: int) -> None:
        self.max_entries = max_entries
        self._items: OrderedDict[tuple[Any, ...], BackdropImage] = OrderedDict()
        self._lock = RLock()

    def get(self, key: tuple[Any, ...]) -> BackdropImage | None:
        with self._lock:
            image = self._items.get(key)
            if image is None:
                return None
            self._items.move_to_end(key)
            return replace(image, cache_hit=True)

    def put(self, key: tuple[Any, ...], image: BackdropImage) -> None:
        with self._lock:
            self._items[key] = image
            self._items.move_to_end(key)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)


PROVIDER_TYPES: dict[str, type[NasaGibsWmsProvider]] = {
    NasaGibsWmsProvider.name: NasaGibsWmsProvider,
}


class AerialBackdropService:
    def __init__(self, config: dict[str, Any], *, provider: AerialImageProvider | None = None) -> None:
        self.settings = AerialBackdropSettings.from_runtime_config(config)
        self.provider: AerialImageProvider | None = provider
        self.cache: BackdropImageCache | None = None
        if self.settings is not None:
            if self.provider is None:
                provider_type = PROVIDER_TYPES.get(self.settings.provider)
                if provider_type is None:
                    raise BackdropConfigError(f"unsupported aerial backdrop provider: {self.settings.provider}")
                self.provider = provider_type(self.settings)
            self.cache = BackdropImageCache(self.settings.cache_max_entries)

    @property
    def enabled(self) -> bool:
        return self.settings is not None and self.provider is not None and self.cache is not None

    def public_capability(self) -> dict[str, Any]:
        if not self.enabled or self.settings is None:
            return {"enabled": False}
        return {
            "enabled": True,
            "provider": self.settings.provider,
            "route": "/api/render/aerial-backdrop",
            "cache_revision": self._cache_revision(),
            "date_policy": self.settings.date_policy,
            "date_anchor": date.today().isoformat(),
            "background_opacity": self.settings.background_opacity,
            "scrim_opacity": self.settings.scrim_opacity,
            "attribution": self.settings.attribution,
        }

    def _cache_revision(self) -> str:
        if self.settings is None:
            return ""
        image_contract = (
            self.settings.provider,
            self.settings.endpoint,
            self.settings.layer,
            self.settings.fallback_layer,
            self.settings.date_policy,
            self.settings.lookback_days,
            self.settings.minimum_image_bytes,
            self.settings.image_format,
            self.settings.output_width,
            self.settings.output_height,
            self.settings.context_scale,
            date.today().isoformat(),
        )
        payload = "\x1f".join(str(value) for value in image_contract).encode("utf-8")
        return sha256(payload).hexdigest()[:12]

    def image(self, bbox_value: str) -> BackdropImage:
        if not self.enabled or self.settings is None or self.provider is None or self.cache is None:
            raise BackdropRequestError("aerial backdrop is disabled")
        bbox = self._parse_bbox(bbox_value)
        source_date = date.today().isoformat()
        expanded = self._expand_bbox(bbox)
        key = (
            self.settings.provider,
            self.settings.layer,
            self.settings.fallback_layer,
            source_date,
            *(round(value, 6) for value in expanded),
            self.settings.output_width,
            self.settings.output_height,
        )
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        image = self.provider.fetch(bbox=expanded, source_date=source_date)
        self.cache.put(key, image)
        return image

    def _parse_bbox(self, value: str) -> tuple[float, float, float, float]:
        try:
            parts = tuple(float(part.strip()) for part in str(value or "").split(","))
        except ValueError as exc:
            raise BackdropRequestError("bbox must contain four numbers") from exc
        if len(parts) != 4:
            raise BackdropRequestError("bbox must contain west,south,east,north")
        west, south, east, north = parts
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise BackdropRequestError("bbox is outside valid longitude/latitude bounds")
        return west, south, east, north

    def _expand_bbox(
        self,
        bbox: tuple[float, float, float, float],
    ) -> tuple[float, float, float, float]:
        if self.settings is None:
            return bbox
        west, south, east, north = bbox
        center_lon = (west + east) / 2
        center_lat = (south + north) / 2
        width = (east - west) * self.settings.context_scale
        height = (north - south) * self.settings.context_scale
        aspect = self.settings.output_width / self.settings.output_height
        if width / height < aspect:
            width = height * aspect
        else:
            height = width / aspect
        width = min(360.0, width)
        height = min(180.0, height)
        expanded_west = min(max(center_lon - width / 2, -180.0), 180.0 - width)
        expanded_south = min(max(center_lat - height / 2, -90.0), 90.0 - height)
        return (
            expanded_west,
            expanded_south,
            expanded_west + width,
            expanded_south + height,
        )


def aerial_backdrop_capability(config: dict[str, Any]) -> dict[str, Any]:
    return AerialBackdropService(config).public_capability()
