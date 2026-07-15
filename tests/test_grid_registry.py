from __future__ import annotations

import unittest

from common_adapter.query.grid_registry import (
    GridCellKey,
    GridLevelKey,
    GridRegistry,
    GridSignature,
)


def _sampled_grid(*, origin_lat: int | float = 90) -> dict:
    return {
        "alignment": {
            "id": "global_geographic_index",
            "origin_lat": origin_lat,
            "origin_lon": -180,
            "index_units_per_degree": 24,
        },
        "geometry": {
            "encoding": "global_index",
            "origin_lat": origin_lat,
            "origin_lon": -180,
            "index_units_per_degree": 24,
        },
        "available_resolutions_km": [4, 16, 32],
        "value_domain": {"min": 0, "max": 100},
    }


class GridRegistryTests(unittest.TestCase):
    def test_metric_metadata_does_not_split_an_aligned_grid(self) -> None:
        chlor = _sampled_grid()
        chlor["value_domain"] = {"min": 0, "max": 100, "unit": "chlor"}
        temperature = _sampled_grid()
        temperature["value_domain"] = {"min": -2, "max": 35, "unit": "celsius"}

        registry = GridRegistry()
        first = registry.register(chlor)
        second = registry.register(temperature)

        self.assertIs(first, second)
        self.assertEqual(1, len(registry))

    def test_numeric_representation_does_not_change_signature(self) -> None:
        integer_origin = GridSignature.from_sampled_grid(_sampled_grid(origin_lat=90))
        float_origin = GridSignature.from_sampled_grid(_sampled_grid(origin_lat=90.0))

        self.assertEqual(integer_origin, float_origin)
        self.assertEqual(integer_origin.profile_id, float_origin.profile_id)

    def test_different_alignment_produces_a_different_profile(self) -> None:
        first = GridSignature.from_sampled_grid(_sampled_grid(origin_lat=90))
        second = GridSignature.from_sampled_grid(_sampled_grid(origin_lat=89))

        self.assertNotEqual(first, second)
        self.assertNotEqual(first.profile_id, second.profile_id)

    def test_resolution_is_a_grid_level_not_a_profile(self) -> None:
        profile = GridRegistry().register(_sampled_grid())

        level_4km = GridLevelKey.from_km(profile, 4)
        level_16km = GridLevelKey.from_km(profile, 16.0)

        self.assertEqual(profile.profile_id, level_4km.profile_id)
        self.assertNotEqual(level_4km, level_16km)
        self.assertEqual(4000, level_4km.resolution_m)

    def test_cell_identity_includes_profile_and_resolution(self) -> None:
        profile = GridRegistry().register(_sampled_grid())

        first = GridCellKey(GridLevelKey.from_km(profile, 4), "r04km_1512_7152")
        duplicate = GridCellKey(GridLevelKey.from_km(profile, 4.0), "r04km_1512_7152")
        other_level = GridCellKey(GridLevelKey.from_km(profile, 16), "r04km_1512_7152")

        self.assertEqual(1, len({first, duplicate}))
        self.assertNotEqual(first, other_level)


if __name__ == "__main__":
    unittest.main()
