from __future__ import annotations

import unittest

from common_adapter.layers.capabilities import (
    eez_high_seas_overlay_capability,
    eez_land_mask_provider_capability,
    land_mask_consumer_capability,
    spatial_interpolation_capability,
)


class LayerCapabilityTests(unittest.TestCase):
    def test_regular_continuous_grid_supports_render_only_linear_interpolation(self) -> None:
        capability = spatial_interpolation_capability(
            {
                "geometry": {"encoding": "global_index"},
                "value_semantics": {
                    "kind": "continuous",
                    "provenance": "source_scout",
                },
            }
        )

        self.assertEqual("supported", capability["status"])
        self.assertEqual(["nearest", "linear"], capability["methods"])
        self.assertEqual("linear", capability["default_method"])
        self.assertTrue(capability["render_only"])
        self.assertEqual("source_scout", capability["evidence"]["provenance"])

    def test_missing_value_semantics_remains_unknown(self) -> None:
        capability = spatial_interpolation_capability(
            {"geometry": {"encoding": "center"}}
        )

        self.assertEqual("unknown", capability["status"])
        self.assertEqual(["nearest"], capability["methods"])

    def test_categorical_grid_and_vector_layer_do_not_support_interpolation(self) -> None:
        categorical = spatial_interpolation_capability(
            {
                "geometry": {"encoding": "center"},
                "value_semantics": {"kind": "categorical", "provenance": "source_scout"},
            }
        )
        vector = spatial_interpolation_capability(None)

        self.assertEqual("unsupported", categorical["status"])
        self.assertEqual("non_continuous_value_semantics", categorical["reason"])
        self.assertEqual("unsupported", vector["status"])
        self.assertEqual("not_sampled_grid", vector["reason"])

    def test_marine_domain_registers_as_land_mask_consumer_without_dataset_names(self) -> None:
        capability = land_mask_consumer_capability(
            {
                "geometry": {"encoding": "global_index"},
                "spatial_domain": {"kind": "marine", "provenance": "source_scout"},
            }
        )

        self.assertEqual("supported", capability["status"])
        self.assertEqual("eez", capability["provider_layer_id"])
        self.assertEqual("land_mask_provider", capability["provider_capability"])
        self.assertEqual("source_scout", capability["evidence"]["provenance"])

    def test_eez_route_registers_versioned_land_mask_child_capability(self) -> None:
        capability = eez_land_mask_provider_capability(
            {
                "overlays": {
                    "eez": {
                        "enabled": True,
                        "provider": "postgis",
                        "source": {"version": "v12_20231025"},
                        "domain_mask": {
                            "enabled": True,
                            "tile_query_concurrency": 3,
                            "tile_timeout_ms": 42000,
                        },
                    }
                }
            },
            "eez",
        )

        self.assertEqual("supported", capability["status"])
        self.assertIn("/eez/domain/land/", capability["tile_template"])
        self.assertEqual("rrkal.eez_land_mask.v7", capability["capability_version"])
        self.assertEqual("eez_lod", capability["geometry_source"])
        self.assertEqual("eez", capability["lod_owner"])
        self.assertEqual(3, capability["tile_request_concurrency"])
        self.assertEqual(42000, capability["tile_timeout_ms"])

    def test_eez_route_registers_high_seas_paint_as_separate_child_capability(self) -> None:
        capability = eez_high_seas_overlay_capability(
            {
                "overlays": {
                    "eez": {
                        "enabled": True,
                        "provider": "postgis",
                        "source": {"version": "v12_20231025"},
                        "domain_mask": {"enabled": True},
                    }
                }
            },
            "eez",
        )

        self.assertEqual("supported", capability["status"])
        self.assertIn("/eez/domain/high_seas/", capability["tile_template"])
        self.assertEqual("versioned_seed_tuple", capability["classification"])
        self.assertEqual("eez_lod", capability["geometry_source"])
        self.assertEqual(["fill_color"], capability["paint"]["controls"])


if __name__ == "__main__":
    unittest.main()
