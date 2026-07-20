from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from common_adapter.developer.schema_inspector import _catalog_tables, inspect_relational_routes


class SchemaInspectorBoundaryTests(unittest.TestCase):
    def test_catalog_schema_is_inferred_from_source_payload(self) -> None:
        tables = _catalog_tables(
            {
                "metrics": [
                    {"metric_id": "chlor_a", "label": "Chlorophyll", "max": 100, "ratio": 0.25},
                    {"metric_id": "sst", "label": "Temperature", "max": None, "ratio": 0.75},
                ],
                "resolutions": [4, 16, 32],
            }
        )

        by_name = {table["name"]: table for table in tables}
        metric_columns = {column["name"]: column for column in by_name["metrics"]["columns"]}
        self.assertEqual({"label", "max", "metric_id", "ratio"}, set(metric_columns))
        self.assertTrue(metric_columns["max"]["nullable"])
        self.assertEqual("unknown", metric_columns["max"]["value_semantics_candidate"]["kind"])
        self.assertEqual("continuous", metric_columns["ratio"]["value_semantics_candidate"]["kind"])
        self.assertEqual(
            "source_scout",
            metric_columns["ratio"]["value_semantics_candidate"]["provenance"],
        )
        self.assertEqual("integer", by_name["resolutions"]["columns"][0]["data_type"])

    def test_http_route_selection_depends_on_adapter_not_mapping_artifact(self) -> None:
        route = {
            "name": "external_catalog",
            "backend": {"kind": "iceberg"},
            "adapter": {"kind": "http_endpoint"},
        }
        with patch(
            "common_adapter.developer.schema_inspector.inspect_http_catalog_route",
            return_value=[{"route_ref": "external_catalog"}],
        ) as inspect_http:
            profiles = inspect_relational_routes(
                [("config/sources/database/external.json", Path("external.json"), route)]
            )

        self.assertEqual([{"route_ref": "external_catalog"}], profiles)
        inspect_http.assert_called_once()

    def test_schema_inspector_does_not_read_mapping_artifacts(self) -> None:
        source = (
            Path(__file__).resolve().parents[1]
            / "common_adapter"
            / "developer"
            / "schema_inspector.py"
        ).read_text(encoding="utf-8")

        self.assertNotIn("load_layer_mappings", source)
        self.assertNotIn("sampled_grid_catalog_mappings", source)
        self.assertNotIn("provided_tables", source)


if __name__ == "__main__":
    unittest.main()
