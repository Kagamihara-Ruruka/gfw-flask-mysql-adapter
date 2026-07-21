from __future__ import annotations

import gzip
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request
from flask_sock import Sock

from common_adapter.db.connect import query_policy
from common_adapter.endpoint.supervisor import ManagedEndpointSupervisor
from common_adapter.http.routes.backdrop import register_backdrop_routes
from common_adapter.http.routes.datasets import register_dataset_routes
from common_adapter.http.routes.developer import register_developer_routes
from common_adapter.http.routes.live import register_live_routes
from common_adapter.http.routes.official_site import register_official_site_routes
from common_adapter.http.routes.overlays import register_overlay_routes
from common_adapter.http.routes.system import register_system_routes
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.layers.status import RouteStatusRegistry
from common_adapter.query.batch import QueryBatchExecutor
from common_adapter.spatial.land_mask import EezDomainMaskService

ROOT = Path(__file__).resolve().parents[2]
SERVER_PID_FILE = Path("flask_pid.txt")


def create_flask_app() -> Flask:
    return Flask(
        __name__,
        template_folder=str(ROOT / "templates"),
        static_folder=str(ROOT / "static"),
    )


def create_app(
    config: dict[str, Any],
    *,
    developer_url: str | None = None,
    layer_registry: RuntimeLayerRegistry | None = None,
    route_status_registry: RouteStatusRegistry | None = None,
    eez_domain_mask_service: EezDomainMaskService | None = None,
) -> Flask:
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

    resolved_layer_registry = layer_registry or RuntimeLayerRegistry(config)
    resolved_route_status_registry = route_status_registry or RouteStatusRegistry(config, resolved_layer_registry)

    register_official_site_routes(app, site_root=ROOT / "official_site")

    register_system_routes(
        app,
        config,
        layer_registry=resolved_layer_registry,
        route_status_registry=resolved_route_status_registry,
        developer_url=developer_url,
    )

    register_backdrop_routes(app, config)

    batch_executor = QueryBatchExecutor(
        max_workers=query_policy(config)["network_concurrency"],
    )
    app.extensions["query_batch_executor"] = batch_executor
    register_dataset_routes(
        app,
        config,
        layer_registry=resolved_layer_registry,
        batch_executor=batch_executor,
    )

    resolved_eez_domain_mask_service = eez_domain_mask_service or EezDomainMaskService(config)
    if (
        getattr(resolved_eez_domain_mask_service, "prepare_on_startup", False)
        and callable(getattr(resolved_eez_domain_mask_service, "prepare", None))
    ):
        resolved_eez_domain_mask_service.prepare()
    app.extensions["eez_domain_mask_service"] = resolved_eez_domain_mask_service
    register_overlay_routes(
        app,
        config,
        domain_mask_service=resolved_eez_domain_mask_service,
    )

    register_live_routes(app, sock, config)

    return app


def create_developer_app(
    config: dict[str, Any],
    *,
    consumer_url: str,
    layer_registry: RuntimeLayerRegistry | None = None,
    route_status_registry: RouteStatusRegistry | None = None,
    endpoint_supervisor: ManagedEndpointSupervisor | None = None,
) -> Flask:
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

    resolved_layer_registry = layer_registry or RuntimeLayerRegistry(config)
    resolved_route_status_registry = route_status_registry or RouteStatusRegistry(config, resolved_layer_registry)
    register_developer_routes(
        app,
        runtime_config=config,
        layer_registry=resolved_layer_registry,
        route_status_registry=resolved_route_status_registry,
        endpoint_supervisor=endpoint_supervisor,
    )
    return app
