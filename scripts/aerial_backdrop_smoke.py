from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from common_adapter.render.backdrop import (
    AerialBackdropService,
    BackdropImage,
    BackdropRequestError,
)


def runtime_config(*, enabled: bool = True) -> dict[str, Any]:
    return {
        "rendering": {
            "aerial_backdrop": {
                "enabled": enabled,
                "provider": "nasa_gibs_wms",
                "endpoint": "https://example.test/wms",
                "layer": "daily_true_color",
                "fallback_layer": "static_blue_marble",
                "date_policy": "latest_available",
                "lookback_days": 7,
                "minimum_image_bytes": 20000,
                "image_format": "image/jpeg",
                "output_width": 1280,
                "output_height": 720,
                "context_scale": 12,
                "timeout_seconds": 20,
                "max_response_bytes": 8388608,
                "cache_max_entries": 4,
                "browser_cache_seconds": 86400,
                "background_opacity": 0.82,
                "scrim_opacity": 0.58,
                "attribution": "Test imagery",
            }
        }
    }


class FakeProvider:
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def fetch(
        self,
        *,
        bbox: tuple[float, float, float, float],
        source_date: str | None,
    ) -> BackdropImage:
        self.calls.append({"bbox": bbox, "source_date": source_date})
        return BackdropImage(
            content=b"\xff\xd8\xff\xd9",
            content_type="image/jpeg",
            provider=self.name,
            layer="daily_true_color",
            bbox=bbox,
            source_date=source_date,
        )


def assert_raises(callable_object, expected_message: str) -> None:
    try:
        callable_object()
    except BackdropRequestError as exc:
        if expected_message not in str(exc):
            raise AssertionError(f"expected {expected_message!r} in {str(exc)!r}") from exc
        return
    raise AssertionError(f"expected BackdropRequestError containing {expected_message!r}")


def main() -> int:
    provider = FakeProvider()
    service = AerialBackdropService(runtime_config(), provider=provider)
    first = service.image("120,22,120.1,22.1")
    second = service.image("120,22,120.1,22.1")

    if len(provider.calls) != 1:
        raise AssertionError(f"expected one provider request, got {len(provider.calls)}")
    if first.cache_hit or not second.cache_hit:
        raise AssertionError("expected miss followed by cache hit")
    west, south, east, north = first.bbox
    if not (west <= 120 < 120.1 <= east and south <= 22 < 22.1 <= north):
        raise AssertionError("expanded bbox does not contain selected cell")
    aspect = (east - west) / (north - south)
    if abs(aspect - (16 / 9)) > 0.000001:
        raise AssertionError(f"expected 16:9 bbox, got {aspect}")
    if first.source_date != date.today().isoformat():
        raise AssertionError("background date was not resolved relative to today")

    assert_raises(lambda: service.image("120,22,119,23"), "outside valid")

    capability = service.public_capability()
    if (
        capability.get("enabled") is not True
        or capability.get("route") != "/api/render/aerial-backdrop"
        or not capability.get("cache_revision")
        or capability.get("date_policy") != "latest_available"
    ):
        raise AssertionError("public capability is incomplete")
    revised_config = runtime_config()
    revised_config["rendering"]["aerial_backdrop"]["layer"] = "revised_layer"
    revised = AerialBackdropService(revised_config, provider=FakeProvider()).public_capability()
    if capability["cache_revision"] == revised["cache_revision"]:
        raise AssertionError("image config change did not invalidate browser cache revision")
    disabled = AerialBackdropService({"rendering": {}}).public_capability()
    if disabled != {"enabled": False}:
        raise AssertionError(f"unexpected disabled capability: {disabled!r}")

    print(
        json.dumps(
            {
                "status": "ok",
                "provider_calls": len(provider.calls),
                "cache_sequence": [first.cache_hit, second.cache_hit],
                "expanded_bbox": first.bbox,
                "capability": capability,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
