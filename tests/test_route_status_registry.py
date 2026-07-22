from __future__ import annotations

import unittest
from unittest.mock import patch

from common_adapter.http.interface import create_flask_app
from common_adapter.http.routes.system import SystemRoutes
from common_adapter.developer.probes.status import RouteProbe
from common_adapter.layers.status import RouteStatusRegistry


class _LayerRegistry:
    def __init__(self) -> None:
        self.invalidated = 0
        self.packet = {
            "generation": 1,
            "datasets": {"ocean": {"backend": "mysql", "connection_ref": "primary"}},
            "layers": [
                {
                    "layer_id": "ocean",
                    "source_config_path": "config/sources/database/ocean.json",
                    "mapping_id": "ocean.mapping",
                    "imported": True,
                    "materialized": True,
                    "available": True,
                }
            ],
            "source_errors": [],
        }

    def invalidate(self) -> None:
        self.invalidated += 1

    def snapshot(self, *, force: bool = False):
        return self.packet


class _RouteProbe:
    def __init__(self) -> None:
        self.database_calls = 0

    def connection_status_from_config(self, config_ref, data, active, **_kwargs):
        self.database_calls += 1
        return [
            {
                "config_path": config_ref,
                "route_ref": "ocean",
                "connection_ref": "primary",
                "backend": "mysql",
                "enabled": active,
                "connected": True,
                "contract_detected": True,
                "detail": "connected",
            }
        ]

    def spatial_status_from_config(self, config_ref, data):
        return []


class _EndpointProbe:
    def status_from_config(self, config_ref, data, active):
        return []


class RouteStatusRegistryTests(unittest.TestCase):
    def test_hive_health_uses_the_formal_query_adapter(self) -> None:
        config_ref = "config/sources/database/spark-thrift.presentation.json"
        source = {
            "name": "pipeline_iceberg",
            "sql_backend": {"kind": "hive"},
            "connections": {"spark_thrift": {"kind": "hive"}},
        }
        runtime_config = {"__runtime_identity": {"profile": "PRESENTATION"}}
        dataset = {
            "connection_ref": "spark_thrift",
            "__runtime_source_config_path": config_ref,
        }
        with patch(
            "common_adapter.developer.probes.status.schema_packet",
            return_value={"columns": ["event_date"]},
        ) as schema_query:
            rows = RouteProbe().connection_status_from_config(
                config_ref,
                source,
                True,
                runtime_config=runtime_config,
                datasets={"pipeline_iceberg.chlor_a": dataset},
            )

        self.assertEqual(1, len(rows))
        self.assertTrue(rows[0]["connected"])
        self.assertTrue(rows[0]["contract_detected"])
        self.assertIn("正式 Query Adapter 驗證成功", rows[0]["detail"])
        schema_query.assert_called_once_with(
            runtime_config,
            dataset,
            query_context={
                "health_probe": True,
                "dataset_id": "pipeline_iceberg.chlor_a",
            },
        )

    def test_one_snapshot_owns_distinct_route_and_layer_states(self) -> None:
        clock = [0.0]
        layer_registry = _LayerRegistry()
        route_probe = _RouteProbe()

        def routes(group, config):
            if group == "database":
                return [
                    (
                        "config/sources/database/ocean.json",
                        None,
                        {"name": "ocean", "connections": {"primary": {"kind": "mysql"}}},
                    )
                ]
            return []

        with patch("common_adapter.layers.status.active_config_files_by_group", side_effect=routes):
            registry = RouteStatusRegistry(
                {},
                layer_registry,
                refresh_ttl_seconds=30,
                monotonic=lambda: clock[0],
                route_probe=route_probe,
                endpoint_probe=_EndpointProbe(),
            )
            first = registry.snapshot()
            second = registry.snapshot()
            clock[0] = 31
            third = registry.snapshot()

        self.assertEqual(2, route_probe.database_calls)
        self.assertEqual(first, second)
        self.assertNotEqual(first["generation"], third["generation"])
        row = first["routes"][0]
        for state in (
            "configured",
            "enabled",
            "reachable",
            "discovered",
            "mapped",
            "imported",
            "materialized",
            "queryable",
            "available",
        ):
            self.assertTrue(row[state], state)

    def test_health_consumes_status_snapshot_without_issuing_its_own_probe(self) -> None:
        layer_registry = _LayerRegistry()

        class StatusRegistry:
            def snapshot(self):
                return {
                    "generation": 4,
                    "routes": [{"enabled": True, "available": False, "detail": "offline"}],
                    "layers": layer_registry.packet["layers"],
                    "source_errors": [{"error": "offline"}],
                }

        app = create_flask_app()
        SystemRoutes(
            {},
            layer_registry=layer_registry,
            route_status_registry=StatusRegistry(),
        ).register(app)

        response = app.test_client().get("/api/health")
        packet = response.get_json()

        self.assertEqual(200, response.status_code)
        self.assertEqual("degraded", packet["status"])
        self.assertEqual(4, packet["status_generation"])
        self.assertEqual("offline", packet["routes"][0]["detail"])


if __name__ == "__main__":
    unittest.main()
