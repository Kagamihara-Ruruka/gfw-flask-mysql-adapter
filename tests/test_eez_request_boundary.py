from __future__ import annotations

import unittest
from unittest.mock import patch

from common_adapter.spatial.lod import (
    eez_lod_source,
    eez_tile_query_concurrency,
    geographic_pixel_degrees_for_zoom,
    mvt_detail_for_zoom,
)
from common_adapter.spatial.overlay import postgis_dsn


class EezRequestBoundaryTests(unittest.TestCase):
    def test_tile_source_uses_bootstrapped_subdivision_table_without_provisioning(self) -> None:
        config = {
            "overlays": {
                "eez": {
                    "enabled": True,
                    "provider": "postgis",
                    "postgis": {
                        "table": "eez_v12",
                        "tile_table": "eez_v12_tile",
                        "fill_table": "eez_v12_fill",
                    },
                }
            }
        }

        with patch("common_adapter.spatial.lod.ensure_eez_fill_table") as provision:
            source = eez_lod_source(config, 3)

        provision.assert_not_called()
        self.assertEqual(source.table, "eez_v12_tile")
        self.assertEqual(source.lod, "web_mercator_subdivided_z3")
        self.assertEqual(source.geometry_srid, 4326)
        self.assertEqual(source.simplify_meters, mvt_detail_for_zoom(3)[2])

    def test_lod_tolerance_is_one_visible_pixel_in_source_coordinates(self) -> None:
        self.assertAlmostEqual(geographic_pixel_degrees_for_zoom(0), 360.0 / 256)
        self.assertAlmostEqual(
            geographic_pixel_degrees_for_zoom(4),
            geographic_pixel_degrees_for_zoom(3) / 2,
        )

    def test_tile_query_concurrency_is_config_owned(self) -> None:
        config = {"overlays": {"eez": {"tile_query_concurrency": 6}}}
        self.assertEqual(eez_tile_query_concurrency(config), 6)
        self.assertEqual(eez_tile_query_concurrency({}), 6)

    def test_postgis_password_can_come_from_kubernetes_secret_environment(self) -> None:
        settings = {
            "host": "bdde-postgis-service",
            "port": 5432,
            "database": "common_spatial",
            "user": "postgres",
            "password": "env:POSTGIS_PASSWORD",
        }
        with patch.dict("os.environ", {"POSTGIS_PASSWORD": "spatial-secret"}):
            dsn = postgis_dsn(settings)
        self.assertIn("password=spatial-secret", dsn)
        self.assertNotIn("env:POSTGIS_PASSWORD", dsn)


if __name__ == "__main__":
    unittest.main()
