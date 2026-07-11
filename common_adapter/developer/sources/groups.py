from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from common_adapter.config.paths import SOURCE_CONFIG_DIR

CONFIG_NAME_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")
ROUTE_GROUP_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
CONFIG_GROUPS = {"database", "websocket", "spatial", "endpoint", "demo"}
BUILTIN_PROBE_GROUPS = {"database", "websocket", "spatial", "endpoint"}
NON_ROUTABLE_CONFIG_GROUPS = {"demo"}
RESERVED_SOURCE_GROUPS = {"adapter", "app", "artifacts", "config", "examples", "json", "managed", "profile", "runtime", "staging", "state"}


class ConfigGroupClassifier:
    """Classifies config JSON files without deciding UI drawer structure."""

    def normalize_config_group(self, value: str) -> str:
        group = str(value or "").strip().lower()
        if group in {"", "auto", "detect", "json", "profile", "runtime", "adapter", "app", "config"}:
            return ""
        if group in {"db", "sql", "mysql", "hive", "spark", "iceberg", "postgresql", "mongodb", "duckdb", "database"}:
            return "database"
        if group in {"ws", "websocket", "collector", "ais", "stream"}:
            return "websocket"
        if group in {"spatial", "postgis", "gis", "overlay", "mvt"}:
            return "spatial"
        if group in {"endpoint", "http", "http_api", "serving", "serving_api", "rest", "api"}:
            return "endpoint"
        if group in {"route", "source", "custom"}:
            return "route"
        if group in {"demo", "example", "sample"}:
            return "demo"
        if ROUTE_GROUP_PATTERN.match(group):
            return group
        return ""

    def is_routable_config_group(self, group: str) -> bool:
        normalized = self.normalize_config_group(group)
        return bool(normalized) and normalized not in NON_ROUTABLE_CONFIG_GROUPS

    def normalize_source_group_name(self, value: str) -> str:
        group = str(value or "").strip().lower()
        if group in RESERVED_SOURCE_GROUPS:
            return ""
        return group if ROUTE_GROUP_PATTERN.match(group) else ""

    def is_routable_source_group_name(self, group: str) -> bool:
        return bool(self.normalize_source_group_name(group))

    def has_builtin_probe(self, group: str) -> bool:
        return self.normalize_config_group(group) in BUILTIN_PROBE_GROUPS

    def infer_config_group(self, path: Path, data: dict[str, Any] | None = None) -> str:
        try:
            relative_source = path.resolve().relative_to(SOURCE_CONFIG_DIR.resolve())
            if len(relative_source.parts) >= 2:
                group = self.normalize_config_group(relative_source.parts[0])
                if group:
                    return group
        except ValueError:
            pass
        name = path.name.lower()
        if name.endswith(".example.json"):
            return "demo"
        if "collector" in name or "ais_" in name or "stream" in name:
            return "websocket"
        if isinstance(data, dict):
            schema = str(data.get("schema") or "").lower()
            role = str(data.get("role") or "").lower()
            for key in ("route_group", "source_group", "adapter_group"):
                declared_group = self.normalize_config_group(str(data.get(key) or ""))
                if declared_group:
                    return declared_group
            if "spatial" in schema or role.startswith("spatial"):
                return "spatial"
            if "websocket" in schema or role.startswith("websocket"):
                return "websocket"
            if "database" in schema or role.startswith("database"):
                return "database"
            if "profile" in schema or role.endswith("profile"):
                return ""
            if "endpoint" in schema or "http_api" in schema or "serving_api" in schema or role.startswith(("endpoint", "http_api", "serving_api")):
                return "endpoint"
            if "route" in schema or role.startswith(("route", "source")):
                return "route"
            if isinstance(data.get("datasets"), dict) or isinstance(data.get("connections"), dict) or isinstance(data.get("mysql"), dict):
                return "database"
            if any(key in data for key in ("provider", "stream_url", "ingest", "collector")) and not data.get("connections"):
                return "websocket"
            if data.get("kind") in {"spatial_postgis", "postgis_overlay"}:
                return "spatial"
            overlays = data.get("overlays")
            if isinstance(overlays, dict) and isinstance(overlays.get("eez"), dict):
                eez = overlays["eez"]
                if eez.get("provider") == "postgis" or eez.get("postgis"):
                    return "spatial"
            if any(key in data for key in ("endpoint", "base_url", "uri", "url", "host", "port")):
                return "endpoint"
            if any(key in data for key in ("route", "routes", "source", "sources", "adapter", "driver", "backend")):
                return "route"
        return ""

    def infer_source_group_name(self, path: Path) -> str:
        try:
            relative_source = path.resolve().relative_to(SOURCE_CONFIG_DIR.resolve())
            if len(relative_source.parts) >= 2:
                return self.normalize_source_group_name(relative_source.parts[0])
        except ValueError:
            pass
        return ""


DEFAULT_CONFIG_GROUP_CLASSIFIER = ConfigGroupClassifier()
