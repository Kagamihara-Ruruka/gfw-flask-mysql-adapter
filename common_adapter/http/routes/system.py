from __future__ import annotations

from typing import Any

from flask import Flask, jsonify, render_template

from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.layers.status import RouteStatusRegistry
from common_adapter.render.capability import server_render_capability


class SystemRoutes:
    def __init__(
        self,
        config: dict[str, Any],
        *,
        layer_registry: RuntimeLayerRegistry,
        route_status_registry: RouteStatusRegistry,
        developer_url: str | None = None,
    ) -> None:
        self.config = config
        self.layer_registry = layer_registry
        self.route_status_registry = route_status_registry
        self.developer_url = developer_url

    def register(self, app: Flask) -> None:
        config = self.config
        developer_url = self.developer_url

        @app.get("/dashboard/")
        def dashboard():
            return render_template("index.html", developer_url=developer_url)

        @app.get("/favicon.ico")
        def favicon():
            return "", 204

        @app.get("/api/health")
        def health():
            try:
                status_snapshot = self.route_status_registry.snapshot()
                datasets = self.layer_registry.snapshot().get("datasets") or {}
                enabled_routes = [row for row in status_snapshot["routes"] if row.get("enabled")]
                unavailable_routes = [row for row in enabled_routes if not row.get("available")]
                backend_packet = None
                sampled_dataset_id = next(iter(sorted(datasets)), None)
                if sampled_dataset_id is not None:
                    sampled_dataset = datasets[sampled_dataset_id]
                    backend_packet = {
                        "kind": sampled_dataset.get("source_backend") or sampled_dataset.get("backend"),
                        "connection_ref": sampled_dataset.get("connection_ref"),
                    }
                return jsonify(
                    {
                        "status": "degraded" if unavailable_routes else "ok",
                        "backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                        "sampled_dataset_backend": backend_packet,
                        "datasets": sorted(datasets.keys()),
                        "mapping_errors": status_snapshot.get("source_errors") or [],
                        "routes": status_snapshot["routes"],
                        "layers": status_snapshot["layers"],
                        "status_generation": status_snapshot["generation"],
                    }
                )
            except Exception as exc:
                return jsonify({"status": "error", "error": str(exc)}), 503

        @app.get("/api/render/capability")
        def render_capability():
            try:
                return jsonify(server_render_capability(config))
            except Exception as exc:
                return jsonify({"status": "error", "error": str(exc)}), 400


def register_system_routes(
    app: Flask,
    config: dict[str, Any],
    *,
    layer_registry: RuntimeLayerRegistry,
    route_status_registry: RouteStatusRegistry,
    developer_url: str | None = None,
) -> None:
    SystemRoutes(
        config,
        layer_registry=layer_registry,
        route_status_registry=route_status_registry,
        developer_url=developer_url,
    ).register(app)
