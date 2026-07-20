from __future__ import annotations

from typing import Any

from flask import Flask, Response, jsonify, request

from common_adapter.db.connect import parse_bbox
from common_adapter.spatial.attribution import eez_attribution_packet
from common_adapter.spatial.land_mask import EezDomainMaskService
from common_adapter.spatial.lod import (
    eez_boundary_mvt_tile_packet,
    eez_geojson_packet,
    eez_mvt_tile_packet,
    eez_render_mvt_tile_packet,
)
from common_adapter.spatial.overlay import eez_overlay_packet, overlay_settings


class OverlayRoutes:
    def __init__(self, config: dict[str, Any], *, domain_mask_service: EezDomainMaskService) -> None:
        self.config = config
        self.domain_mask_service = domain_mask_service

    @staticmethod
    def tile_response(tile: bytes, meta: dict[str, Any]) -> Response:
        response = Response(tile, mimetype="application/x-protobuf")
        response.headers["Cache-Control"] = "public, max-age=86400"
        response.headers["X-EEZ-Tile-Bytes"] = str(meta["bytes"])
        response.headers["X-EEZ-Tile-MS"] = str(meta["timing"]["tile_ms"])
        response.headers["X-EEZ-LOD"] = str(meta["lod"])
        response.headers["X-EEZ-Cache"] = str(meta["cache"])
        response.headers["X-EEZ-Cache-Tier"] = str(meta.get("cache_tier", "none"))
        response.headers["X-EEZ-Source-Table"] = str(meta["table"])
        return response

    def register(self, app: Flask) -> None:
        config = self.config

        @app.get("/api/overlays/eez")
        def eez_overlay():
            try:
                zoom_arg = request.args.get("zoom")
                bbox = parse_bbox(request.args.get("bbox"))
                zoom = float(zoom_arg) if zoom_arg else None
                if overlay_settings(config).get("provider") == "postgis":
                    packet = eez_geojson_packet(config, bbox=bbox, zoom=zoom)
                else:
                    packet = eez_overlay_packet(config, bbox=bbox, zoom=zoom)
                return jsonify(packet)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/overlays/eez/attribution")
        def eez_attribution():
            try:
                bbox = parse_bbox(request.args.get("bbox"))
                lat_arg = request.args.get("lat")
                lon_arg = request.args.get("lon") or request.args.get("lng")
                limit = int(request.args.get("limit", "8"))
                packet = eez_attribution_packet(
                    config,
                    bbox=bbox,
                    lat=float(lat_arg) if lat_arg is not None else None,
                    lon=float(lon_arg) if lon_arg is not None else None,
                    limit=limit,
                )
                if bbox is not None:
                    try:
                        domain = self.domain_mask_service.classify_bbox(
                            bbox,
                            eez_coverage_ratio=float(
                                (packet.get("query") or {}).get("eez_coverage_ratio") or 0.0
                            ),
                        )
                    except Exception as domain_error:
                        domain = {
                            "schema": "rrkal.eez_domain_attribution.v1",
                            "kind": "unresolved",
                            "regions": [],
                            "status": "error",
                            "detail": str(domain_error),
                        }
                elif packet.get("attribution"):
                    domain = {
                        "schema": "rrkal.eez_domain_attribution.v1",
                        "kind": "eez",
                        "regions": [],
                        "eez_coverage_ratio": 1.0,
                        "source_version": self.domain_mask_service.source_version,
                    }
                else:
                    try:
                        domain = self.domain_mask_service.classify_point(
                            lat=float(lat_arg),
                            lon=float(lon_arg),
                        )
                    except Exception as domain_error:
                        domain = {
                            "schema": "rrkal.eez_domain_attribution.v1",
                            "kind": "unresolved",
                            "regions": [],
                            "status": "error",
                            "detail": str(domain_error),
                        }

                if packet.get("attribution"):
                    primary = packet["attribution"][0]
                    packet["classification"] = {
                        "kind": "eez",
                        "pol_type": primary.get("pol_type"),
                    }
                    packet["fallback"] = None
                else:
                    packet["classification"] = {
                        "kind": domain.get("kind") or "unresolved",
                        "pol_type": None,
                    }
                    packet["fallback"] = None if domain.get("kind") != "unresolved" else "domain_unresolved"
                packet["domain"] = domain
                return jsonify(packet)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/overlays/eez/tiles/<int:z>/<int:x>/<int:y>.pbf")
        def eez_tile(z: int, x: int, y: int):
            try:
                tile, meta = eez_mvt_tile_packet(config, z=z, x=x, y=y)
                return self.tile_response(tile, meta)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/overlays/eez/boundary/tiles/<int:z>/<int:x>/<int:y>.pbf")
        def eez_boundary_tile(z: int, x: int, y: int):
            try:
                tile, meta = eez_boundary_mvt_tile_packet(config, z=z, x=x, y=y)
                return self.tile_response(tile, meta)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/overlays/eez/render/tiles/<int:z>/<int:x>/<int:y>.pbf")
        def eez_render_tile(z: int, x: int, y: int):
            try:
                tile, meta = eez_render_mvt_tile_packet(config, z=z, x=x, y=y)
                return self.tile_response(tile, meta)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400

        @app.get("/api/overlays/eez/domain/<string:kind>/tiles/<int:z>/<int:x>/<int:y>.svg")
        def eez_domain_tile(kind: str, z: int, x: int, y: int):
            try:
                if kind not in {"land", "high_seas"}:
                    raise ValueError(f"unsupported EEZ domain kind: {kind}")
                tile, meta = self.domain_mask_service.tile_svg(kind, z, x, y)
                response = Response(tile, mimetype="image/svg+xml")
                response.headers["Cache-Control"] = "public, max-age=86400"
                response.headers["X-EEZ-Domain-Kind"] = kind
                response.headers["X-EEZ-Domain-Version"] = str(meta["artifact_version"])
                response.headers["X-EEZ-Source-Version"] = str(meta["source_version"])
                response.headers["X-EEZ-Domain-Tile-MS"] = str(meta["tile_ms"])
                response.headers["X-EEZ-Domain-Features"] = str(meta["feature_count"])
                response.headers["X-EEZ-Domain-LOD"] = str(meta.get("lod", "unknown"))
                response.headers["X-EEZ-Domain-Source-Table"] = str(meta.get("source_table", "unknown"))
                return response
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400


def register_overlay_routes(
    app: Flask,
    config: dict[str, Any],
    *,
    domain_mask_service: EezDomainMaskService,
) -> None:
    OverlayRoutes(config, domain_mask_service=domain_mask_service).register(app)
