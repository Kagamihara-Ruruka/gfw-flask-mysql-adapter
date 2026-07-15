from __future__ import annotations

import time
from typing import Any

from flask import Flask, jsonify, render_template

from common_adapter.db.connect import dataset_backend_info, mysql_connection
from common_adapter.layers.runtime import database_datasets_from_mappings
from common_adapter.render.capability import server_render_capability
from common_adapter.spatial.overlay import elapsed_ms


class SystemRoutes:
    def __init__(self, config: dict[str, Any], *, developer_url: str | None = None) -> None:
        self.config = config
        self.developer_url = developer_url

    def register(self, app: Flask) -> None:
        config = self.config
        developer_url = self.developer_url

        @app.get("/")
        def index():
            return render_template("index.html", developer_url=developer_url)

        @app.get("/favicon.ico")
        def favicon():
            return "", 204

        @app.get("/api/health")
        def health():
            started = time.perf_counter()
            try:
                datasets, mapping_errors = database_datasets_from_mappings(config)
                sampled_dataset_id = next(iter(sorted(datasets)), None)
                ok = True
                db_ping_ms = None
                backend_packet = None
                if sampled_dataset_id is not None:
                    sampled_dataset = datasets[sampled_dataset_id]
                    backend_kind, connection_ref, connection = dataset_backend_info(config, sampled_dataset)
                    backend_packet = {"kind": backend_kind, "connection_ref": connection_ref}
                    if backend_kind == "mysql":
                        database = sampled_dataset.get("database") or connection["database"]
                        with mysql_connection(config, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
                            cur.execute("SELECT 1 AS ok")
                            ok = cur.fetchone()["ok"] == 1
                        db_ping_ms = elapsed_ms(started)
                return jsonify(
                    {
                        "status": "ok" if ok else "degraded",
                        "backend": config.get("sql_backend", {"kind": "mysql", "driver": "pymysql"}),
                        "sampled_dataset_backend": backend_packet,
                        "datasets": sorted(datasets.keys()),
                        "mapping_errors": mapping_errors,
                        "timing": {"db_ping_ms": db_ping_ms},
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


def register_system_routes(app: Flask, config: dict[str, Any], *, developer_url: str | None = None) -> None:
    SystemRoutes(config, developer_url=developer_url).register(app)
