from __future__ import annotations

import threading
import time
import unittest

from common_adapter.endpoint.sampled_grid import SampledGridHttpQueryAdapter
from common_adapter.query.sampled_grid import compile_sampled_grid_mapping
from common_adapter.query.sampled_grid_paging import (
    SampledGridFrameAssembler,
    canonicalize_sampled_grid_shard,
    effective_query_bbox,
    plan_sampled_grid_shards,
)
from common_adapter.query.snapshot_cache import CANONICAL_SNAPSHOT_CACHE


def _dataset(*, units_per_degree: int = 24) -> dict:
    return {
        "dataset_id": "sampled-grid",
        "sampled_grid": {
            "available_resolutions_km": [4, 16, 32],
            "source_fields": {
                "id": "grid_id",
                "row": "grid_row",
                "column": "grid_col",
                "value": "value",
                "resolution": "resolution_km",
            },
            "request_fields": {"time": "date"},
            "geometry": {
                "encoding": "global_index",
                "origin_lat": 90,
                "origin_lon": -180,
                "index_units_per_degree": units_per_degree,
            },
        },
    }


def _pagination(max_page_size: int) -> dict:
    return {
        "mode": "offset_limit",
        "limit_parameter": "limit",
        "offset_parameter": "offset",
        "max_page_size": max_page_size,
        "stable_order": ["grid_row", "grid_col"],
    }


def _spatial_window() -> dict:
    return {
        "mode": "grid_index_range",
        "bounds": "half_open",
        "row_field": "grid_row",
        "column_field": "grid_col",
        "row_start_parameter": "row_start",
        "row_stop_parameter": "row_stop",
        "column_start_parameter": "column_start",
        "column_stop_parameter": "column_stop",
        "metadata_path": "spatial_window",
    }


def _paged_adapter_dataset() -> dict:
    return {
        "dataset_id": "paged.sampled-grid",
        "data_layer": "paged.sampled-grid",
        "connection_ref": "paged-source",
        "display_columns": ["date", "cell_id", "lat", "lon", "value", "resolution_km"],
        "endpoint_source": {
            "endpoint": {"base_url": "http://paged.example.invalid"},
            "query_policy": {
                "max_in_flight": 1,
                "max_request_in_flight": 2,
            },
        },
        "sampled_grid": {
            "available_resolutions_km": [4],
            "coverage_areas": [
                {
                    "id": "coverage",
                    "bounds": {"west": 0, "south": 0, "east": 2, "north": 2},
                }
            ],
            "source_fields": {
                "id": "grid_id",
                "row": "grid_row",
                "column": "grid_col",
                "value": "value",
                "resolution": "resolution_km",
            },
            "request_fields": {"time": "date"},
            "geometry": {
                "encoding": "global_index",
                "origin_lat": 2,
                "origin_lon": 0,
                "index_units_per_degree": 1,
            },
            "query": {
                "parameters": {"date": "date", "aoi": "aoi", "resolution": "resolution"},
                "snapshot": {
                    "path": "/snapshot",
                    "rows_path": "rows",
                    "pagination": {
                        **_pagination(2),
                        "limit_parameter": "take",
                        "offset_parameter": "skip",
                    },
                    "spatial_window": _spatial_window(),
                },
            },
            "resolution_policy": {"fallback": "none"},
            "snapshot_cache": {
                "enabled": True,
                "identity_roles": ["dataset_id", "date", "coverage_id", "resolution_km"],
                "max_entries": 8,
                "ttl_seconds": None,
            },
        },
    }


def _columnar_paged_adapter_dataset() -> dict:
    dataset = _paged_adapter_dataset()
    snapshot = dataset["sampled_grid"]["query"]["snapshot"]
    snapshot["field_projection"] = {
        "mode": "field_list",
        "parameter": "fields",
        "separator": ",",
        "available_fields": [
            "grid_id",
            "grid_row",
            "grid_col",
            "value",
            "resolution_km",
            "unused_source_field",
        ],
    }
    snapshot["columnar_response"] = {
        "mode": "columns",
        "parameter": "response_shape",
        "value": "columns",
        "columns_path": "columns",
        "row_count_path": "row_count",
    }
    return dataset


class _PagedClient:
    def __init__(self, *, incomplete_row_start: int | None = None) -> None:
        self.rows = [
            {"grid_id": "0:0", "grid_row": 0, "grid_col": 0, "value": 1, "resolution_km": 4},
            {"grid_id": "0:1", "grid_row": 0, "grid_col": 1, "value": 2, "resolution_km": 4},
            {"grid_id": "1:0", "grid_row": 1, "grid_col": 0, "value": 3, "resolution_km": 4},
            {"grid_id": "1:1", "grid_row": 1, "grid_col": 1, "value": 4, "resolution_km": 4},
        ]
        self.incomplete_row_start = incomplete_row_start
        self.calls: list[dict] = []
        self.active = 0
        self.peak_active = 0
        self._lock = threading.Lock()

    def get_json(self, _path: str, *, params: dict) -> dict:
        with self._lock:
            self.calls.append(dict(params))
            self.active += 1
            self.peak_active = max(self.peak_active, self.active)
        try:
            time.sleep(0.03)
            offset = int(params["skip"])
            limit = int(params["take"])
            row_start = int(params["row_start"])
            row_stop = int(params["row_stop"])
            column_start = int(params["column_start"])
            column_stop = int(params["column_stop"])
            window_rows = [
                row
                for row in self.rows
                if row_start <= row["grid_row"] < row_stop
                and column_start <= row["grid_col"] < column_stop
            ]
            rows = window_rows[offset : offset + limit]
            if self.incomplete_row_start == row_start:
                rows = rows[:-1]
            payload = {
                "page": {
                    "mode": "offset_limit",
                    "limit": limit,
                    "offset": offset,
                    "returned": len(rows),
                    "has_more": offset + limit < len(window_rows),
                    "spatial_window": {
                        "row_start": row_start,
                        "row_stop": row_stop,
                        "column_start": column_start,
                        "column_stop": column_stop,
                    },
                },
            }
            if params.get("response_shape") == "columns":
                fields = str(params["fields"]).split(",")
                payload.update(
                    {
                        "columns": {
                            field: [row[field] for row in rows]
                            for field in fields
                        },
                        "row_count": len(rows),
                    }
                )
            else:
                payload["rows"] = rows
            return payload
        finally:
            with self._lock:
                self.active -= 1


class SampledGridPagingTests(unittest.TestCase):
    def setUp(self) -> None:
        CANONICAL_SNAPSHOT_CACHE.clear()

    def tearDown(self) -> None:
        CANONICAL_SNAPSHOT_CACHE.clear()

    def test_effective_bbox_clips_cc_viewport_to_coverage(self) -> None:
        self.assertEqual(
            {"west": 105.0, "south": 20.0, "east": 120.0, "north": 35.0},
            effective_query_bbox(
                {"west": 100, "south": 20, "east": 120, "north": 40},
                {"west": 105, "south": 15, "east": 135, "north": 35},
            ),
        )
        self.assertIsNone(
            effective_query_bbox(
                {"west": 0, "south": 0, "east": 1, "north": 1},
                {"west": 105, "south": 15, "east": 135, "north": 35},
            )
        )

    def test_northwest_pacific_full_extent_derives_four_stable_shards(self) -> None:
        mapping = compile_sampled_grid_mapping(_dataset())
        plan = plan_sampled_grid_shards(
            viewport_bbox={"west": 105, "south": 15, "east": 135, "north": 35},
            coverage_bounds={"west": 105, "south": 15, "east": 135, "north": 35},
            resolution_km=4,
            mapping=mapping,
            pagination=_pagination(100000),
            spatial_window=_spatial_window(),
        )

        self.assertEqual(720, plan.source_column_count)
        self.assertEqual(480, plan.source_row_count)
        self.assertEqual(345600, plan.expected_row_count)
        self.assertEqual(4, plan.topology_shard_count)
        self.assertEqual([0, 0, 0, 0], [shard.offset for shard in plan.shards])
        self.assertEqual([86400, 86400, 86400, 86400], [shard.limit for shard in plan.shards])
        self.assertEqual(4, len({shard.shard_id for shard in plan.shards}))

    def test_viewport_resolves_only_intersecting_stable_shards(self) -> None:
        mapping = compile_sampled_grid_mapping(_dataset())
        plan = plan_sampled_grid_shards(
            viewport_bbox={"west": 118, "south": 20, "east": 124, "north": 27},
            coverage_bounds={"west": 105, "south": 15, "east": 135, "north": 35},
            resolution_km=4,
            mapping=mapping,
            pagination=_pagination(100000),
            spatial_window=_spatial_window(),
        )

        self.assertEqual(144, plan.query_column_count)
        self.assertEqual(168, plan.query_row_count)
        self.assertEqual(24192, plan.expected_row_count)
        self.assertEqual([0], [shard.offset for shard in plan.shards])
        self.assertEqual([24192], [shard.limit for shard in plan.shards])
        self.assertEqual(1, len(plan.shards))

    def test_assembler_accepts_out_of_order_canonical_shards(self) -> None:
        mapping = compile_sampled_grid_mapping(_paged_adapter_dataset())
        plan = plan_sampled_grid_shards(
            viewport_bbox={"west": 0, "south": 0, "east": 2, "north": 2},
            coverage_bounds={"west": 0, "south": 0, "east": 2, "north": 2},
            resolution_km=4,
            mapping=mapping,
            pagination=_pagination(2),
            spatial_window=_spatial_window(),
        )
        rows = [
            {"grid_id": "0:0", "grid_row": 0, "grid_col": 0, "value": 1, "resolution_km": 4},
            {"grid_id": "0:1", "grid_row": 0, "grid_col": 1, "value": 2, "resolution_km": 4},
            {"grid_id": "1:0", "grid_row": 1, "grid_col": 0, "value": 3, "resolution_km": 4},
            {"grid_id": "1:1", "grid_row": 1, "grid_col": 1, "value": 4, "resolution_km": 4},
        ]
        assembler = SampledGridFrameAssembler(plan=plan)
        for shard in reversed(plan.shards):
            page_rows = [
                row
                for row in rows
                if shard.source_row_start <= row["grid_row"] < shard.source_row_stop
                and shard.source_column_start <= row["grid_col"] < shard.source_column_stop
            ][shard.offset : shard.offset + shard.limit]
            canonical = canonicalize_sampled_grid_shard(
                rows=page_rows,
                page_metadata={
                    "mode": "offset_limit",
                    "limit": shard.limit,
                    "offset": shard.offset,
                    "returned": len(page_rows),
                    "has_more": shard.source_has_more,
                    "spatial_window": {
                        "row_start": shard.source_row_start,
                        "row_stop": shard.source_row_stop,
                        "column_start": shard.source_column_start,
                        "column_stop": shard.source_column_stop,
                    },
                },
                mapping=mapping,
                query_plan=plan,
                shard_plan=shard,
                spatial_window=_spatial_window(),
                context={"date": "2020-01-01", "resolution": 4},
            )
            assembler.add_shard(shard, canonical)

        assembled = assembler.finish()
        self.assertEqual(4, assembled.frame.row_count)
        self.assertEqual(2, assembled.shard_count)
        self.assertEqual(
            {"0:0", "0:1", "1:0", "1:1"},
            set(assembled.frame.column("cell_id") or ()),
        )

    def test_adapter_reuses_retained_shards_and_fetches_only_added_shards(self) -> None:
        adapter = SampledGridHttpQueryAdapter({}, _paged_adapter_dataset())
        client = _PagedClient()
        adapter.client = client

        top = adapter.records_packet(
            date_value="2020-01-01",
            bbox=(0, 1, 2, 2),
            limit="max",
            offset=0,
            query_context={"requested_resolution_km": 4},
        )
        top_again = adapter.records_packet(
            date_value="2020-01-01",
            bbox=(0, 1, 2, 2),
            limit="max",
            offset=0,
            query_context={"requested_resolution_km": 4},
        )
        bottom = adapter.records_packet(
            date_value="2020-01-01",
            bbox=(0, 0, 2, 1),
            limit="max",
            offset=0,
            query_context={"requested_resolution_km": 4},
        )
        full = adapter.records_packet(
            date_value="2020-01-01",
            bbox=(0, 0, 2, 2),
            limit="max",
            offset=0,
            query_context={"requested_resolution_km": 4},
        )

        self.assertEqual(2, top["row_count"])
        self.assertEqual(1, top["timing"]["source_request_count"])
        self.assertTrue(top_again["timing"]["cache_hit"])
        self.assertEqual(0, top_again["timing"]["source_request_count"])
        self.assertEqual(2, bottom["row_count"])
        self.assertEqual(1, bottom["timing"]["source_request_count"])
        self.assertEqual(4, full["row_count"])
        self.assertTrue(full["timing"]["cache_hit"])
        self.assertEqual(0, full["timing"]["source_request_count"])
        self.assertEqual(2, len(client.calls))

        timing = full["timing"]
        self.assertEqual(
            ["snapshot_load_ms", "filter_ms", "packet_projection_ms", "packet_build_ms"],
            timing["api_phase_names"],
        )
        critical_path_ms = sum(timing[name] for name in timing["api_phase_names"])
        self.assertAlmostEqual(timing["server_total_ms"], critical_path_ms, places=2)

    def test_adapter_uses_mapping_driven_columnar_source_transport(self) -> None:
        adapter = SampledGridHttpQueryAdapter({}, _columnar_paged_adapter_dataset())
        client = _PagedClient()
        adapter.client = client

        packet = adapter.records_packet(
            date_value="2020-01-01",
            bbox=(0, 0, 2, 2),
            limit="max",
            offset=0,
            query_context={
                "requested_resolution_km": 4,
                "output_profile": "canonical_frame",
            },
        )

        self.assertEqual(4, packet["row_count"])
        self.assertNotIn("rows", packet)
        value_index = packet["canonical_frame"]["row_fields"].index("value")
        self.assertEqual(
            [1, 2, 3, 4],
            list(packet["canonical_frame"]["columns"][value_index]),
        )
        self.assertEqual("columns", client.calls[0]["response_shape"])
        self.assertEqual(
            "grid_id,grid_row,grid_col,value,resolution_km",
            client.calls[0]["fields"],
        )
        self.assertNotIn("unused_source_field", client.calls[0]["fields"])

    def test_source_request_capacity_is_independent_from_frame_operation_capacity(self) -> None:
        adapter = SampledGridHttpQueryAdapter({}, _paged_adapter_dataset())
        client = _PagedClient()
        adapter.client = client

        packet = adapter.records_packet(
            date_value="2020-01-01",
            bbox=(0, 0, 2, 2),
            limit="max",
            offset=0,
            query_context={"requested_resolution_km": 4},
        )

        self.assertEqual(2, packet["timing"]["source_worker_count"])
        self.assertEqual(2, client.peak_active)

    def test_incomplete_shard_never_returns_a_partial_frame(self) -> None:
        adapter = SampledGridHttpQueryAdapter({}, _paged_adapter_dataset())
        adapter.client = _PagedClient(incomplete_row_start=1)

        with self.assertRaisesRegex(
            ValueError,
            "shard rows-000001-000002-cols-000000-000002 is incomplete",
        ):
            adapter.records_packet(
                date_value="2020-01-01",
                bbox=(0, 0, 2, 2),
                limit="max",
                offset=0,
                query_context={"requested_resolution_km": 4},
            )

        self.assertLessEqual(
            CANONICAL_SNAPSHOT_CACHE.entry_count(adapter.snapshot_cache_namespace),
            1,
        )


if __name__ == "__main__":
    unittest.main()
