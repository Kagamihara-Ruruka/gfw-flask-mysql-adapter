from __future__ import annotations

from typing import Any

from flask import Flask, Response, jsonify, request

from common_adapter.render.backdrop import (
    AerialBackdropService,
    BackdropProviderError,
    BackdropRequestError,
)


class BackdropRoutes:
    def __init__(self, config: dict[str, Any]) -> None:
        self.service = AerialBackdropService(config)

    def register(self, app: Flask) -> None:
        @app.get("/api/render/aerial-backdrop")
        def aerial_backdrop():
            try:
                image = self.service.image(request.args.get("bbox", ""))
            except BackdropRequestError as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400
            except BackdropProviderError as exc:
                return jsonify({"status": "error", "error": str(exc)}), 502

            response = Response(image.content, mimetype=image.content_type)
            settings = self.service.settings
            if settings is not None:
                response.headers["Cache-Control"] = f"public, max-age={settings.browser_cache_seconds}"
            response.headers["X-RRKAL-Backdrop-Provider"] = image.provider
            response.headers["X-RRKAL-Backdrop-Layer"] = image.layer
            response.headers["X-RRKAL-Backdrop-Bbox"] = ",".join(f"{value:.6f}" for value in image.bbox)
            response.headers["X-RRKAL-Backdrop-Cache"] = "hit" if image.cache_hit else "miss"
            if image.source_date:
                response.headers["X-RRKAL-Backdrop-Date"] = image.source_date
            return response


def register_backdrop_routes(app: Flask, config: dict[str, Any]) -> None:
    BackdropRoutes(config).register(app)
