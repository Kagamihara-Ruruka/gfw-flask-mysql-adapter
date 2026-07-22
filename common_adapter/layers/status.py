from __future__ import annotations

import time
from copy import deepcopy
from pathlib import Path
from threading import RLock
from typing import Any, Callable

from common_adapter.ais.ingest import get_ais_ingest_status
from common_adapter.developer.probes.endpoint import EndpointProbe
from common_adapter.developer.probes.status import RouteProbe
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.layers.runtime import active_config_files_by_group


class RouteStatusRegistry:
    """Owns the read-only source/runtime status snapshot used by every UI."""

    def __init__(
        self,
        config: dict[str, Any],
        layer_registry: RuntimeLayerRegistry,
        *,
        refresh_ttl_seconds: float = 30.0,
        monotonic: Callable[[], float] = time.monotonic,
        route_probe: RouteProbe | None = None,
        endpoint_probe: EndpointProbe | None = None,
    ) -> None:
        self.config = config
        self.layer_registry = layer_registry
        self.refresh_ttl_seconds = max(0.0, float(refresh_ttl_seconds))
        self.monotonic = monotonic
        self.route_probe = route_probe or RouteProbe()
        self.endpoint_probe = endpoint_probe or EndpointProbe()
        self._lock = RLock()
        self._last_refresh = float("-inf")
        self._invalidated = True
        self._generation = 0
        self._snapshot: dict[str, Any] = {
            "generation": 0,
            "routes": [],
            "layers": [],
            "source_errors": [],
        }

    def invalidate(self) -> None:
        with self._lock:
            self._invalidated = True
            self._last_refresh = float("-inf")
        self.layer_registry.invalidate()

    def snapshot(self, *, force: bool = False) -> dict[str, Any]:
        with self._lock:
            now = self.monotonic()
            expired = now - self._last_refresh >= self.refresh_ttl_seconds
            if force or self._invalidated or self._generation == 0 or expired:
                self._snapshot = self._build_snapshot()
                self._generation += 1
                self._snapshot["generation"] = self._generation
                self._last_refresh = now
                self._invalidated = False
            return deepcopy(self._snapshot)

    def rows(self, group: str, *, force: bool = False) -> list[dict[str, Any]]:
        return [
            row
            for row in self.snapshot(force=force)["routes"]
            if row.get("source_route_group") == group
        ]

    def _build_snapshot(self) -> dict[str, Any]:
        layer_snapshot = self.layer_registry.snapshot()
        layers = layer_snapshot.get("layers") or []
        datasets = layer_snapshot.get("datasets") or {}
        routes: list[dict[str, Any]] = []
        routes.extend(self._database_rows(layers, datasets))
        routes.extend(self._endpoint_rows(layers))
        routes.extend(self._websocket_rows(layers))
        routes.extend(self._spatial_rows(layers))
        return {
            "generation": self._generation,
            "routes": sorted(
                routes,
                key=lambda row: (
                    str(row.get("source_route_group") or ""),
                    str(row.get("config_path") or ""),
                    str(row.get("route_ref") or row.get("connection_ref") or ""),
                ),
            ),
            "layers": layers,
            "source_errors": layer_snapshot.get("source_errors") or [],
        }

    def _database_rows(
        self,
        layers: list[dict[str, Any]],
        datasets: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for config_ref, _path, data in active_config_files_by_group("database", self.config):
            for raw in self.route_probe.connection_status_from_config(
                config_ref,
                data,
                True,
                runtime_config=self.config,
                datasets=datasets,
            ):
                backend = str(raw.get("backend") or "unknown").lower()
                connected = bool(raw.get("connected"))
                discovered = bool(connected and raw.get("contract_detected"))
                raw = {**raw, "schema_inspectable": discovered}
                rows.append(
                    self._normalize_row(
                        raw,
                        group="database",
                        config_ref=config_ref,
                        layers=layers,
                        configured=raw.get("configured", True),
                        reachable=connected,
                        discovered=discovered,
                        queryable=connected and discovered,
                    )
                )
        return rows

    def _endpoint_rows(self, layers: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for config_ref, _path, data in active_config_files_by_group("endpoint", self.config):
            for raw in self.endpoint_probe.status_from_config(config_ref, data, True):
                reachable = bool(raw.get("reachable"))
                discovered = bool(raw.get("contract_detected"))
                rows.append(
                    self._normalize_row(
                        raw,
                        group="endpoint",
                        config_ref=config_ref,
                        layers=layers,
                        configured=raw.get("configured", False),
                        reachable=reachable,
                        discovered=discovered,
                        queryable=reachable and discovered,
                    )
                )
        return rows

    def _websocket_rows(self, layers: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        ingest_status: dict[str, Any] | None = None
        ingest_error = ""
        for config_ref, _path, data in active_config_files_by_group("websocket", self.config):
            live = data.get("live") if isinstance(data.get("live"), dict) else {}
            ais = live.get("ais") if isinstance(live.get("ais"), dict) else {}
            ingest = data.get("ingest") if isinstance(data.get("ingest"), dict) else {}
            provider = str(data.get("provider") or data.get("stream_provider") or ais.get("provider") or "websocket")
            endpoint = str(data.get("stream_url") or data.get("url") or data.get("endpoint") or ais.get("stream_url") or "")
            source_enabled = bool(ingest.get("enabled", ais.get("enabled", True)))
            source_configured = provider == "aisstream" and bool(endpoint)
            read_model_configured = bool(ais.get("connection_ref") and ais.get("database") and ais.get("table"))
            configured = source_configured and read_model_configured
            if ingest_status is None and not ingest_error:
                try:
                    ingest_status = get_ais_ingest_status(self.config)
                except Exception as exc:
                    ingest_error = str(exc)
            store = (ingest_status or {}).get("store") or {}
            gate = (ingest_status or {}).get("key_gate") or {}
            pipeline_ready = bool(
                source_enabled
                and configured
                and store.get("status") == "ok"
                and gate.get("authorized_sql_read")
            )
            detail = ingest_error or str(store.get("error") or gate.get("message") or "")
            if not detail:
                detail = "AIS pipeline ready" if pipeline_ready else "AIS pipeline is not ready"
            raw = {
                "config_path": config_ref,
                "route_ref": str(data.get("name") or Path(config_ref).stem),
                "provider": provider,
                "endpoint": endpoint or "-",
                "source_transport": "websocket",
                "read_model_transport": "mysql",
                "connection_ref": str(ais.get("connection_ref") or ""),
                "table_ref": str(ais.get("table") or ""),
                "enabled": source_enabled,
                "source_enabled": source_enabled,
                "source_configured": source_configured,
                "read_model_configured": read_model_configured,
                "pipeline_ready": pipeline_ready,
                "pipeline": ingest_status or {},
                "detail": detail,
            }
            rows.append(
                self._normalize_row(
                    raw,
                    group="websocket",
                    config_ref=config_ref,
                    layers=layers,
                    configured=configured,
                    reachable=pipeline_ready,
                    discovered=configured,
                    queryable=pipeline_ready,
                )
            )
        return rows

    def _spatial_rows(self, layers: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for config_ref, _path, data in active_config_files_by_group("spatial", self.config):
            for raw in self.route_probe.spatial_status_from_config(config_ref, data):
                connected = bool(raw.get("connected"))
                ready = bool(raw.get("ready"))
                rows.append(
                    self._normalize_row(
                        raw,
                        group="spatial",
                        config_ref=config_ref,
                        layers=layers,
                        configured=True,
                        reachable=connected,
                        discovered=connected,
                        queryable=ready,
                    )
                )
        return rows

    @staticmethod
    def _normalize_row(
        raw: dict[str, Any],
        *,
        group: str,
        config_ref: str,
        layers: list[dict[str, Any]],
        configured: Any,
        reachable: Any,
        discovered: Any,
        queryable: Any,
    ) -> dict[str, Any]:
        related = [
            layer
            for layer in layers
            if str(layer.get("source_config_path") or "") == config_ref
        ]
        mapped = any(layer.get("mapping_id") for layer in related)
        imported = any(layer.get("imported") for layer in related)
        materialized = any(layer.get("materialized") for layer in related)
        layer_available = any(layer.get("available") for layer in related if layer.get("imported"))
        enabled = bool(raw.get("enabled", True))
        return {
            **raw,
            "source_route_group": group,
            "config_path": config_ref,
            "configured": bool(configured),
            "enabled": enabled,
            "reachable": bool(reachable),
            "discovered": bool(discovered),
            "mapped": mapped,
            "imported": imported,
            "materialized": materialized,
            "queryable": bool(queryable),
            "available": bool(enabled and queryable and (not imported or layer_available)),
            "layer_ids": sorted(
                str(layer.get("layer_id"))
                for layer in related
                if str(layer.get("layer_id") or "")
            ),
        }
