from __future__ import annotations

import unittest
from unittest.mock import patch

from common_adapter.db.backends.hive import HiveReadBackend
from common_adapter.query.immutable import freeze_json
from common_adapter.query.sampled_grid import canonicalize_sampled_grid_range_packet
from common_adapter.query.snapshot_cache import CANONICAL_SNAPSHOT_CACHE


def _config() -> dict:
    return {
        "sql_backend": {"kind": "hive", "driver": "pyhive"},
        "connections": {
            "spark_thrift": {
                "kind": "hive",
                "driver": "pyhive",
                "host": "dtadm",
                "port": 10000,
                "username": "bigred",
                "auth": "NONE",
            }
        },
        "tables": {"gold_map_metric": "lake.ocean.gold_map_metric"},
        "defaults": {
            "start_date": "2022-01-01",
            "end_date": "2024-12-31",
            "heatmap_limit": 20000,
        },
    }


def _dataset() -> dict:
    return {
        "dataset_id": "sea_temperature",
        "data_layer": "ocean_sst",
        "backend": "hive",
        "connection_ref": "spark_thrift",
        "time_column": "event_date",
        "id_column": "grid_id",
        "lat_column": "grid_row",
        "lon_column": "grid_col",
        "display_columns": [
            "event_date",
            "grid_id",
            "grid_row",
            "grid_col",
            "resolution_km",
            "metric_value",
            "display_level",
            "data_coverage",
        ],
        "metric_columns": ["metric_value"],
        "category_columns": ["display_level"],
        "sampled_grid": {
            "contract_version": "rrkal.sampled_grid.v1",
            "available_resolutions_km": [4],
            "source_fields": {
                "time": "event_date",
                "id": "grid_id",
                "lat": "grid_row",
                "lon": "grid_col",
                "row": "grid_row",
                "column": "grid_col",
                "value": "metric_value",
                "resolution": "resolution_km",
                "coverage": "data_coverage",
                "status": "display_level",
            },
            "request_fields": {"time": "date"},
            "source_parameters": {
                "aoi": "taiwan",
                "product": "SST",
                "metric": "sea_temperature",
            },
            "date_range": {"start": "2022-01-01", "end": "2024-12-31"},
            "coverage_areas": [
                {
                    "id": "taiwan",
                    "label": "Taiwan",
                    "bounds": {"west": 118, "south": 20, "east": 124, "north": 27},
                }
            ],
            "geometry": {
                "encoding": "global_index",
                "origin_lat": 90,
                "origin_lon": -180,
                "index_units_per_degree": 24,
                "base_resolution_km": 4,
            },
            "alignment": {
                "id": "global_geographic_index",
                "origin_lat": 90,
                "origin_lon": -180,
                "index_units_per_degree": 24,
            },
            "snapshot_cache": {
                "enabled": True,
                "identity_roles": ["dataset_id", "date", "coverage_id", "resolution_km"],
                "max_entries": 8,
                "ttl_seconds": 3600,
            },
        },
    }


def _viewport_dataset() -> dict:
    dataset = _dataset()
    contract = dataset["sampled_grid"]
    contract.update(
        {
            "query_scope": "viewport",
            "available_resolutions_km": [4, 16, 32],
            "default_resolution_km": 32,
            "max_viewport_rows": 12000,
            "source_parameters": {
                "aoi": "northwest_pacific",
                "product": "SST",
                "metric": "sea_temperature",
            },
            "coverage_areas": [
                {
                    "id": "northwest_pacific",
                    "label": "Northwest Pacific",
                    "bounds": {"west": 105, "south": 15, "east": 135, "north": 35},
                }
            ],
        }
    )
    contract["snapshot_cache"]["identity_roles"].append("bbox")
    return dataset


def _selectable_viewport_dataset() -> dict:
    dataset = _viewport_dataset()
    contract = dataset["sampled_grid"]
    contract["source_parameters"].pop("aoi")
    contract["default_aoi"] = "taiwan"
    contract["default_resolution_km"] = 4
    contract["max_viewport_rows"] = 25000
    contract["coverage_areas"] = [
        {
            "id": "taiwan",
            "label": "Taiwan",
            "bounds": {"west": 118, "south": 20, "east": 124, "north": 27},
        },
        {
            "id": "northwest_pacific",
            "label": "Northwest Pacific",
            "bounds": {"west": 105, "south": 15, "east": 135, "north": 35},
        },
    ]
    return dataset


class HiveSampledGridBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        CANONICAL_SNAPSHOT_CACHE.clear()

    def test_range_transport_thaws_cached_canonical_snapshots(self) -> None:
        packet = {
            "row_contract_version": "rrkal.sampled_grid.v1",
            "start": "2024-01-01",
            "end": "2024-01-01",
            "snapshots": {
                "2024-01-01": freeze_json([
                    {
                        "cell_id": "r32km_206_909",
                        "date": "2024-01-01",
                        "lat": 21.25,
                        "lon": 123.25,
                        "value": 25.8,
                        "resolution_km": 32,
                        "coverage_ratio": 0.75,
                        "data_status": "observed",
                    }
                ]),
            },
            "grid": {
                "requested_resolution_km": 4,
                "actual_resolution_km": 32,
                "available_resolutions_km": [4, 16, 32],
                "lod_degraded": True,
                "degrade_reason": "viewport_row_budget",
            },
        }

        normalized = canonicalize_sampled_grid_range_packet(packet, _viewport_dataset())

        normalized["transport_marker"] = True
        normalized["snapshots"]["2024-01-01"].append({"cell_id": "transport-probe"})
        self.assertTrue(normalized["transport_marker"])
        self.assertEqual(32, normalized["grid"]["actual_resolution_km"])
        self.assertEqual(2, len(normalized["snapshots"]["2024-01-01"]))

    def test_schema_exposes_effective_mapping_date_range_without_source_query(self) -> None:
        packet = HiveReadBackend(_config(), _dataset()).schema_packet()
        self.assertEqual("2022-01-01", packet["dates"][0])
        self.assertEqual("2024-12-31", packet["dates"][-1])
        self.assertEqual(1096, len(packet["dates"]))
        self.assertEqual({"start": "2022-01-01", "end": "2024-12-31"}, packet["date_range"])
        self.assertEqual("effective_mapping_date_range", packet["timing"]["availability_source"])
        self.assertEqual(0, packet["timing"]["source_request_count"])

    @patch("common_adapter.db.backends.hive.heatmap_packet")
    def test_records_convert_gold_row_and_reuse_snapshot_cache(self, heatmap) -> None:
        heatmap.return_value = {
            "rows": [
                {
                    "grid_id": "r04km_1650_7278",
                    "grid_row": 1650,
                    "grid_col": 7278,
                    "resolution_km": 4,
                    "metric_value": 25.834999,
                    "relative_score": 92.80724236286221,
                    "display_level": "very_high",
                    "data_coverage": 0.75,
                }
            ],
            "timing": {"query_ms": 1000.0},
            "connection": {"reused": True, "reconnect_count": 0},
        }
        backend = HiveReadBackend(_config(), _dataset())
        request = {
            "date_value": "2022-01-01",
            "bbox": (118.0, 20.0, 124.0, 27.0),
            "limit": "max",
            "offset": 0,
            "query_context": {"requested_resolution_km": 4},
        }
        first = backend.records_packet(**request)
        second = backend.records_packet(**request)

        self.assertEqual(1, first["row_count"])
        row = first["rows"][0]
        self.assertEqual("r04km_1650_7278", row["cell_id"])
        self.assertAlmostEqual(21.2291666667, row["lat"])
        self.assertAlmostEqual(123.2708333333, row["lon"])
        self.assertEqual(25.834999, row["value"])
        self.assertEqual(0.75, row["coverage_ratio"])
        self.assertEqual("unknown", row["data_status"])
        self.assertEqual("2022-01-01", row["date"])
        self.assertFalse(first["timing"]["cache_hit"])
        self.assertTrue(second["timing"]["cache_hit"])
        heatmap.assert_called_once()

    @patch("common_adapter.db.backends.hive.heatmap_range_packet")
    def test_range_query_splits_one_source_job_into_daily_cache_entries(self, heatmap_range) -> None:
        heatmap_range.return_value = {
            "rows": [
                {
                    "event_date": "2024-01-01",
                    "grid_id": "r04km_1650_7278",
                    "grid_row": 1650,
                    "grid_col": 7278,
                    "resolution_km": 4,
                    "metric_value": 25.8,
                    "relative_score": 92.8,
                    "display_level": "very_high",
                    "data_coverage": 0.75,
                },
                {
                    "event_date": "2024-01-02",
                    "grid_id": "r04km_1650_7278",
                    "grid_row": 1650,
                    "grid_col": 7278,
                    "resolution_km": 4,
                    "metric_value": 26.1,
                    "relative_score": 93.1,
                    "display_level": "very_high",
                    "data_coverage": 0.8,
                },
            ],
            "timing": {"query_ms": 2500.0},
            "connection": {"reused": True, "reconnect_count": 0},
        }
        backend = HiveReadBackend(_config(), _dataset())
        request = {
            "start_date": "2024-01-01",
            "end_date": "2024-01-03",
            "bbox": (118.0, 20.0, 124.0, 27.0),
            "limit": "max",
            "query_context": {"requested_resolution_km": 4},
        }

        first = backend.records_range_packet(**request)
        second = backend.records_range_packet(**request)

        self.assertEqual(3, first["snapshot_count"])
        self.assertEqual(1, len(first["snapshots"]["2024-01-01"]))
        self.assertEqual(1, len(first["snapshots"]["2024-01-02"]))
        self.assertEqual([], first["snapshots"]["2024-01-03"])
        self.assertEqual("2024-01-02", first["snapshots"]["2024-01-02"][0]["date"])
        self.assertFalse(first["timing"]["cache_hit"])
        self.assertTrue(second["timing"]["cache_hit"])
        self.assertEqual(3, second["timing"]["cache_hits"])
        heatmap_range.assert_called_once()

    @patch("common_adapter.db.backends.hive.heatmap_packet")
    def test_viewport_queries_push_bbox_and_cache_each_view_separately(self, heatmap) -> None:
        heatmap.return_value = {
            "rows": [],
            "timing": {"query_ms": 1000.0},
            "connection": {"reused": True, "reconnect_count": 0},
        }
        backend = HiveReadBackend(_config(), _viewport_dataset())
        shared = {
            "date_value": "2024-01-01",
            "limit": "max",
            "offset": 0,
            "query_context": {"requested_resolution_km": 4},
        }

        first = backend.records_packet(bbox=(120.0, 20.0, 121.0, 21.0), **shared)
        second = backend.records_packet(bbox=(120.0, 20.0, 121.0, 21.0), **shared)
        third = backend.records_packet(bbox=(121.0, 20.0, 122.0, 21.0), **shared)

        self.assertFalse(first["timing"]["cache_hit"])
        self.assertTrue(second["timing"]["cache_hit"])
        self.assertFalse(third["timing"]["cache_hit"])
        self.assertEqual(2, heatmap.call_count)
        self.assertEqual((120.0, 20.0, 121.0, 21.0), heatmap.call_args_list[0].kwargs["bbox"])
        self.assertEqual(4, heatmap.call_args_list[0].kwargs["resolution"])

    @patch("common_adapter.db.backends.hive.heatmap_packet")
    def test_large_4km_view_degrades_to_complete_32km_view(self, heatmap) -> None:
        heatmap.return_value = {
            "rows": [],
            "timing": {"query_ms": 1000.0},
            "connection": {"reused": True, "reconnect_count": 0},
        }
        packet = HiveReadBackend(_config(), _viewport_dataset()).records_packet(
            date_value="2024-01-01",
            bbox=(105.0, 15.0, 135.0, 35.0),
            limit="max",
            offset=0,
            query_context={"requested_resolution_km": 4},
        )

        self.assertEqual(4, packet["grid"]["requested_resolution_km"])
        self.assertEqual(32, packet["grid"]["actual_resolution_km"])
        self.assertTrue(packet["grid"]["lod_degraded"])
        self.assertEqual("viewport_row_budget", packet["grid"]["degrade_reason"])
        self.assertEqual(32, heatmap.call_args.kwargs["resolution"])

    @patch("common_adapter.db.backends.hive.heatmap_packet")
    def test_declared_full_aoi_budget_keeps_requested_4km_resolution(self, heatmap) -> None:
        heatmap.return_value = {
            "rows": [],
            "timing": {"query_ms": 1000.0},
            "connection": {"reused": True, "reconnect_count": 0},
        }
        dataset = _viewport_dataset()
        dataset["sampled_grid"]["max_viewport_rows"] = 400000

        packet = HiveReadBackend(_config(), dataset).records_packet(
            date_value="2024-01-01",
            bbox=(105.0, 15.0, 135.0, 35.0),
            limit="max",
            offset=0,
            query_context={"requested_resolution_km": 4},
        )

        self.assertEqual(4, packet["grid"]["requested_resolution_km"])
        self.assertEqual(4, packet["grid"]["actual_resolution_km"])
        self.assertFalse(packet["grid"]["lod_degraded"])
        self.assertIsNone(packet["grid"]["degrade_reason"])
        self.assertEqual(4, heatmap.call_args.kwargs["resolution"])

    @patch("common_adapter.db.backends.hive.heatmap_packet")
    def test_request_aoi_selects_gold_partition_and_cache_identity(self, heatmap) -> None:
        heatmap.return_value = {"rows": [], "connection": {"reused": True}}
        backend = HiveReadBackend(_config(), _selectable_viewport_dataset())
        request = {
            "date_value": "2024-01-01",
            "bbox": (118.0, 20.0, 119.0, 21.0),
            "limit": "max",
            "offset": 0,
        }

        taiwan = backend.records_packet(
            **request,
            query_context={"aoi": "taiwan", "requested_resolution_km": 4},
        )
        northwest = backend.records_packet(
            **request,
            query_context={"aoi": "northwest_pacific", "requested_resolution_km": 4},
        )

        self.assertEqual("taiwan", taiwan["grid"]["coverage_id"])
        self.assertEqual("northwest_pacific", northwest["grid"]["coverage_id"])
        self.assertEqual(["taiwan", "northwest_pacific"], [
            call.kwargs["aoi"] for call in heatmap.call_args_list
        ])
        self.assertEqual(2, heatmap.call_count)

    def test_request_rejects_undeclared_aoi(self) -> None:
        backend = HiveReadBackend(_config(), _selectable_viewport_dataset())
        with self.assertRaisesRegex(ValueError, "unsupported aoi"):
            backend.records_packet(
                date_value="2024-01-01",
                bbox=(118.0, 20.0, 119.0, 21.0),
                limit="max",
                offset=0,
                query_context={"aoi": "not_declared", "requested_resolution_km": 4},
            )


if __name__ == "__main__":
    unittest.main()
