from __future__ import annotations

import time
from typing import Any

from flask import Flask, jsonify, request

from common_adapter import __version__
from common_adapter.db.spark_thrift import (
    availability_packet,
    grid_features_packet,
    heatmap_packet,
    spark_defaults,
    spark_thrift_settings,
    summary_packet,
)


def _param(name: str, default: Any) -> Any:
    value = request.args.get(name)
    return default if value in {None, ""} else value


def _elapsed_ms(started_ns: int, finished_ns: int) -> float:
    return round((finished_ns - started_ns) / 1_000_000, 3)


def _timed_response(
    packet: dict[str, Any],
    *,
    d_mark: int,
    e_mark: int,
    f_mark: int,
):
    timing = {
        "de_ms": _elapsed_ms(d_mark, e_mark),
        "ef_ms": _elapsed_ms(e_mark, f_mark),
        **packet.get("timing", {}),
    }
    packet["timing"] = timing

    l_mark = time.perf_counter_ns()
    response = jsonify(packet)
    m_mark = time.perf_counter_ns()

    server_timing = {
        **timing,
        "lm_ms": _elapsed_ms(l_mark, m_mark),
        "backend_ms": _elapsed_ms(d_mark, m_mark),
    }
    response.headers["Server-Timing"] = ", ".join(
        f"{name.removesuffix('_ms')};dur={duration}"
        for name, duration in server_timing.items()
    )
    return response


def register_spark_routes(app: Flask, config: dict[str, Any]) -> None:
    @app.get("/api/spark/health")
    def spark_health():
        try:
            settings = spark_thrift_settings(config)
            return jsonify(
                {
                    "status": "ok",
                    "version": __version__,
                    "endpoint": {
                        "host": settings.get("host", "dtadm"),
                        "port": int(settings.get("port", 10000)),
                        "auth": settings.get("auth", "NONE"),
                    },
                }
            )
        except Exception as exc:
            return jsonify({"status": "error", "error": str(exc)}), 400

    @app.get("/api/spark/heatmap")
    def spark_heatmap():
        d_mark = time.perf_counter_ns()
        try:
            defaults = spark_defaults(config)
            params = {
                "date": str(_param("date", defaults.get("date", "2024-01-01"))),
                "aoi": str(_param("aoi", defaults.get("aoi", "taiwan"))),
                "product": str(_param("product", defaults.get("product", "SST"))),
                "metric": str(_param("metric", defaults.get("metric", "sea_temperature"))),
                "resolution": int(_param("resolution", defaults.get("resolution", 4))),
                "limit": int(_param("limit", defaults.get("heatmap_limit", 20000))),
            }
            e_mark = time.perf_counter_ns()
            f_mark = time.perf_counter_ns()
            packet = heatmap_packet(
                config,
                **params,
            )
            return _timed_response(packet, d_mark=d_mark, e_mark=e_mark, f_mark=f_mark)
        except Exception as exc:
            return jsonify({"status": "error", "kind": "heatmap", "error": str(exc)}), 400

    @app.get("/api/spark/availability")
    def spark_availability():
        d_mark = time.perf_counter_ns()
        try:
            defaults = spark_defaults(config)
            params = {
                "start_date": str(_param("start", defaults.get("start_date", "2022-01-01"))),
                "end_date": str(_param("end", defaults.get("end_date", "2024-12-31"))),
                "aoi": str(_param("aoi", defaults.get("aoi", "taiwan"))),
                "product": str(_param("product", defaults.get("product", "SST"))),
                "metric": str(_param("metric", defaults.get("metric", "sea_temperature"))),
                "resolution": int(_param("resolution", defaults.get("resolution", 4))),
            }
            e_mark = time.perf_counter_ns()
            f_mark = time.perf_counter_ns()
            packet = availability_packet(config, **params)
            return _timed_response(packet, d_mark=d_mark, e_mark=e_mark, f_mark=f_mark)
        except Exception as exc:
            return jsonify({"status": "error", "kind": "availability", "error": str(exc)}), 400

    @app.get("/api/spark/summary")
    def spark_summary():
        d_mark = time.perf_counter_ns()
        try:
            defaults = spark_defaults(config)
            params = {
                "date": str(_param("date", defaults.get("date", "2024-01-01"))),
                "aoi": str(_param("aoi", defaults.get("aoi", "taiwan"))),
                "product": str(_param("product", defaults.get("product", "SST"))),
                "metric": str(_param("metric", defaults.get("metric", "sea_temperature"))),
                "resolution": int(_param("resolution", defaults.get("resolution", 4))),
            }
            e_mark = time.perf_counter_ns()
            f_mark = time.perf_counter_ns()
            packet = summary_packet(
                config,
                **params,
            )
            return _timed_response(packet, d_mark=d_mark, e_mark=e_mark, f_mark=f_mark)
        except Exception as exc:
            return jsonify({"status": "error", "kind": "summary", "error": str(exc)}), 400

    @app.get("/api/spark/grid-features")
    def spark_grid_features():
        d_mark = time.perf_counter_ns()
        try:
            defaults = spark_defaults(config)
            params = {
                "date": str(_param("date", defaults.get("date", "2024-01-01"))),
                "aoi": str(_param("aoi", defaults.get("aoi", "taiwan"))),
                "limit": int(_param("limit", defaults.get("grid_features_limit", 1000))),
            }
            e_mark = time.perf_counter_ns()
            f_mark = time.perf_counter_ns()
            packet = grid_features_packet(
                config,
                **params,
            )
            return _timed_response(packet, d_mark=d_mark, e_mark=e_mark, f_mark=f_mark)
        except Exception as exc:
            return jsonify({"status": "error", "kind": "grid_features", "error": str(exc)}), 400
