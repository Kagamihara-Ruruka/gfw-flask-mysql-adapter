from __future__ import annotations

import unittest
from unittest.mock import patch

from common_adapter.endpoint.runtime import (
    endpoint_datasets_from_routes,
    endpoint_layer_contracts,
    resolved_mapping_for_dataset,
)


class _CatalogClient:
    def __init__(self, body: dict) -> None:
        self.body = body

    def get_json(self, _path: str, *, params: dict | None = None) -> dict:
        return self.body


def _mapping() -> dict:
    return {
        "mapping_id": "database.pipeline__catalog",
        "config_path": "config/sources/database/pipeline.local.json",
        "connection_ref": "pipeline",
        "layer_id": "pipeline",
        "sampled_grid": {
            "default_coverage_id": "taiwan",
            "catalog": {
                "path": "catalog",
                "layers_path": "metrics",
                "resolutions_path": "resolutions",
                "coverages_path": "aois",
                "snapshot_capabilities_path": "query_capabilities.daily_grid",
                "layer_fields": {
                    "id": "metric_id",
                    "label": "label",
                    "product": "product_id",
                    "metric": "metric_id",
                    "min": "min",
                    "max": "max",
                    "unit": "unit",
                    "higher_is_better": "higher_is_better",
                    "interpretation": "interpretation",
                },
                "coverage_fields": {
                    "id": "id",
                    "label": "label",
                    "west": "min_lon",
                    "south": "min_lat",
                    "east": "max_lon",
                    "north": "max_lat",
                },
            },
            "query": {
                "snapshot": {"path": "daily-grid", "rows_path": "grid"},
                "parameters": {"date": "date", "metric": "metric"},
            },
            "row_fields": {
                "id": "grid_id",
                "row": "grid_row",
                "column": "grid_col",
                "value": "value",
                "resolution": "resolution_km",
            },
            "request_fields": {"time": "date"},
            "alignment": {
                "id": "global_geographic_index",
                "origin_lat": 90,
                "origin_lon": -180,
                "index_units_per_degree": 24,
            },
            "geometry": {
                "encoding": "global_index",
                "origin_lat": 90,
                "origin_lon": -180,
                "index_units_per_degree": 24,
            },
        },
    }


def _catalog() -> dict:
    return {
        "resolutions": [4, 16, 32],
        "query_capabilities": {
            "daily_grid": {
                "pagination": {
                    "mode": "offset_limit",
                    "limit_parameter": "limit",
                    "offset_parameter": "offset",
                    "max_page_size": 100000,
                    "stable_order": ["grid_row", "grid_col"],
                }
            }
        },
        "aois": [
            {
                "id": "taiwan",
                "label": "Taiwan",
                "min_lon": 118,
                "min_lat": 20,
                "max_lon": 124,
                "max_lat": 27,
            }
        ],
        "metrics": [
            {
                "metric_id": "chlor_a",
                "label": "Chlorophyll",
                "product_id": "CHL",
                "min": 0,
                "max": 100,
                "unit": "%",
                "higher_is_better": True,
                "interpretation": "higher_productivity",
            },
            {
                "metric_id": "pressure",
                "label": "Pressure",
                "product_id": "PRESSURE",
                "min": 0,
                "max": 100,
                "unit": "%",
                "higher_is_better": False,
                "interpretation": "higher_pressure_is_worse",
            },
        ],
    }


class EndpointMappingRuntimeTests(unittest.TestCase):
    def test_catalog_layers_share_grid_profile_and_keep_metric_semantics(self) -> None:
        route = {
            "name": "pipeline",
            "role": "database",
            "backend": {"kind": "iceberg"},
            "endpoint": {"base_url": "http://example.invalid"},
        }
        with patch(
            "common_adapter.endpoint.runtime.sampled_grid_catalog_mappings",
            return_value=[_mapping()],
        ), patch(
            "common_adapter.endpoint.runtime.EndpointHttpClient.from_config",
            return_value=_CatalogClient(_catalog()),
        ):
            datasets, errors = endpoint_datasets_from_routes(
                [("config/sources/database/pipeline.local.json", None, route)],
                source_route_group="database",
            )

        self.assertEqual([], errors)
        self.assertEqual({"pipeline.chlor_a", "pipeline.pressure"}, set(datasets))
        profiles = {dataset["grid_profile_id"] for dataset in datasets.values()}
        self.assertEqual(1, len(profiles))
        self.assertEqual({"time": "date"}, datasets["pipeline.chlor_a"]["sampled_grid"]["request_fields"])
        self.assertEqual("taiwan", datasets["pipeline.chlor_a"]["sampled_grid"]["default_coverage_id"])
        self.assertEqual(
            100000,
            datasets["pipeline.chlor_a"]["sampled_grid"]["query"]["snapshot"]["pagination"]["max_page_size"],
        )
        self.assertTrue(datasets["pipeline.chlor_a"]["sampled_grid"]["value_domain"]["higher_is_better"])
        self.assertFalse(datasets["pipeline.pressure"]["sampled_grid"]["value_domain"]["higher_is_better"])
        self.assertEqual(
            "higher_pressure_is_worse",
            datasets["pipeline.pressure"]["sampled_grid"]["value_domain"]["interpretation"],
        )

        contracts = endpoint_layer_contracts(datasets)
        contract_profiles = {
            contract["mapping"]["sampled_grid"]["grid_profile"]["profile_id"]
            for contract in contracts
        }
        self.assertEqual(profiles, contract_profiles)
        self.assertTrue(
            all(
                contract["mapping"]["sampled_grid"]["default_coverage_id"] == "taiwan"
                for contract in contracts
            )
        )
        self.assertTrue(all(contract["source_route_group"] == "database" for contract in contracts))

        resolved = resolved_mapping_for_dataset(
            "pipeline.chlor_a",
            datasets["pipeline.chlor_a"],
        )
        self.assertEqual("date", resolved["roles"]["time"])
        self.assertEqual("value", resolved["roles"]["value"])
        self.assertEqual("resolution_km", resolved["roles"]["resolution"])
        self.assertIn("value", resolved["selected_columns"])

    def test_unknown_default_coverage_is_rejected_as_mapping_drift(self) -> None:
        route = {
            "name": "pipeline",
            "role": "database",
            "backend": {"kind": "iceberg"},
            "endpoint": {"base_url": "http://example.invalid"},
        }
        mapping = _mapping()
        mapping["sampled_grid"]["default_coverage_id"] = "missing"
        with patch(
            "common_adapter.endpoint.runtime.sampled_grid_catalog_mappings",
            return_value=[mapping],
        ), patch(
            "common_adapter.endpoint.runtime.EndpointHttpClient.from_config",
            return_value=_CatalogClient(_catalog()),
        ):
            datasets, errors = endpoint_datasets_from_routes(
                [("config/sources/database/pipeline.local.json", None, route)],
                source_route_group="database",
            )

        self.assertEqual({}, datasets)
        self.assertEqual(1, len(errors))
        self.assertIn("default_coverage_id", errors[0]["error"])


if __name__ == "__main__":
    unittest.main()
