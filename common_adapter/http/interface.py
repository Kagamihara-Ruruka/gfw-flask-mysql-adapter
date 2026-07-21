from __future__ import annotations

import gzip
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request
from flask_sock import Sock

from common_adapter.http.routes.backdrop import register_backdrop_routes
from common_adapter.http.routes.datasets import register_dataset_routes
from common_adapter.http.routes.developer import register_developer_routes
from common_adapter.http.routes.live import register_live_routes
from common_adapter.http.routes.overlays import register_overlay_routes
from common_adapter.http.routes.spark import register_spark_routes
from common_adapter.http.routes.system import register_system_routes

ROOT = Path(__file__).resolve().parents[2]
SERVER_PID_FILE = Path("flask_pid.txt")


def create_flask_app() -> Flask:
    return Flask(
        __name__,
        template_folder=str(ROOT / "templates"),
        static_folder=str(ROOT / "static"),
    )


def create_app(config: dict[str, Any], *, developer_url: str | None = None) -> Flask:
    app = create_flask_app()
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    sock = Sock(app)

    @app.after_request
    def gzip_json_response(response):
        if request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        accepts_gzip = "gzip" in request.headers.get("Accept-Encoding", "").lower()
        is_json = response.mimetype == "application/json"
        already_encoded = response.headers.get("Content-Encoding")
        if not accepts_gzip or not is_json or already_encoded or response.direct_passthrough:
            return response
        payload = response.get_data()
        if len(payload) < 2048:
            return response
        compressed = gzip.compress(payload, compresslevel=5)
        response.set_data(compressed)
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Vary"] = "Accept-Encoding"
        response.headers["Content-Length"] = str(len(compressed))
        return response

    register_system_routes(app, config, developer_url=developer_url)

    register_backdrop_routes(app, config)

    register_dataset_routes(app, config)

    register_spark_routes(app, config)

    register_overlay_routes(app, config)

    register_live_routes(app, sock, config)

    return app


def create_developer_app(config: dict[str, Any], *, consumer_url: str) -> Flask:
    app = create_flask_app()
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    @app.after_request
    def no_store_static(response):
        if request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def developer_index():
        embedded = request.args.get("embedded") == "1"
        return render_template("developer.html", consumer_url=consumer_url, embedded=embedded)

    @app.get("/favicon.ico")
    def favicon():
        return "", 204

    register_developer_routes(app, runtime_config=config)
    return app
