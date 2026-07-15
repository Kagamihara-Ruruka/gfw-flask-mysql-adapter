from __future__ import annotations

import unittest
from unittest.mock import patch

from common_adapter.spatial.lod import (
    eez_lod_source,
    eez_tile_query_concurrency,
    geographic_pixel_degrees_for_zoom,
    mvt_detail_for_zoom,
)


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


if __name__ == "__main__":
    unittest.main()
