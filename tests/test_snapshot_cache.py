from __future__ import annotations

import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import patch

from common_adapter.endpoint.client import EndpointRequestError
from common_adapter.endpoint.sampled_grid import SampledGridHttpQueryAdapter, _bounds_intersect
from common_adapter.query.snapshot_cache import (
    CANONICAL_SNAPSHOT_CACHE,
    SnapshotCachePolicy,
    SnapshotLoad,
)
from common_adapter.query.sampled_grid import (
    SAMPLED_GRID_CONTRACT_VERSION,
    canonicalize_sampled_grid_packet,
    canonicalize_sampled_grid_row,
    compile_sampled_grid_mapping,
    sampled_grid_public_fields,
)
from common_adapter.query.identity import dataset_cache_namespace
from common_adapter.query.immutable import freeze_json
from common_adapter.query.transport import (
    inflate_sampled_grid_render_packet,
    project_sampled_grid_render_packet,
)


def _dataset(*, resolutions: list[int]) -> dict[str, Any]:
    return {
        "dataset_id": "mapped.sampled_grid",
        "data_layer": "mapped.sampled_grid",
        "display_columns": ["date", "cell_id", "lat", "lon", "value"],
        "endpoint_source": {
            "endpoint": {"base_url": "http://example.invalid"},
        },
        "sampled_grid": {
            "available_resolutions_km": resolutions,
            "coverage_areas": [
                {
                    "id": "coverage-a",
                    "bounds": {"west": -10, "south": -10, "east": 10, "north": 10},
                },
            ],
            "source_fields": {
                "id": "source_id",
                "lat": "source_lat",
                "lon": "source_lon",
                "value": "source_value",
                "resolution": "source_resolution",
            },
            "geometry": {
                "encoding": "center",
                "cell_width_degrees": 1,
                "cell_height_degrees": 1,
            },
            "query": {
                "snapshot": {"path": "/snapshot", "rows_path": "rows"},
                "availability": {"path": "/availability", "dates_path": "dates"},
                "time_series": {"mode": "snapshot_fold", "max_workers": 2},
                "parameters": {
                    "date": "external_date",
                    "aoi": "external_aoi",
                    "resolution": "external_resolution",
                },
            },
            "resolution_policy": {
                "fallback": "coarser",
                "retry_status_codes": [400],
                "retry_error_contains": ["query exceeds"],
            },
            "snapshot_cache": {
                "enabled": True,
                "identity_roles": [
                    "dataset_id",
                    "date",
                    "coverage_id",
                    "resolution_km",
                ],
                "max_entries": 4,
                "ttl_seconds": None,
            },
        },
    }


def _source_rows(resolution: int) -> list[dict[str, Any]]:
    return [
        {
            "source_id": "west-cell",
            "source_lat": 0,
            "source_lon": 0,
            "source_value": 3,
            "source_resolution": resolution,
        },
        {
            "source_id": "east-cell",
            "source_lat": 5,
            "source_lon": 5,
            "source_value": 7,
            "source_resolution": resolution,
        },
    ]


class _FallbackClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def get_json(self, _path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(dict(params))
        resolution = int(params["external_resolution"])
        if resolution == 4:
            raise EndpointRequestError(
                "query exceeds source limit",
                url="http://example.invalid/snapshot",
                status_code=400,
                reachable=True,
                body={"error": "query exceeds source limit"},
            )
        return {"rows": _source_rows(resolution)}


class _ConcurrentClient:
    def __init__(self) -> None:
        self.call_count = 0
        self._lock = threading.Lock()

    def get_json(self, _path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.call_count += 1
        time.sleep(0.1)
        return {"rows": _source_rows(int(params["external_resolution"]))}


class _NoDataClient:
    def __init__(self) -> None:
        self.call_count = 0

    def get_json(self, _path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        self.call_count += 1
        raise EndpointRequestError(
            "no matching grid partition",
            url="http://example.invalid/snapshot",
            status_code=400,
            reachable=True,
            body={"error": "no matching grid partition"},
        )


class _TransientClient:
    def __init__(self) -> None:
        self.call_count = 0

    def get_json(self, _path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        self.call_count += 1
        if self.call_count == 1:
            raise EndpointRequestError(
                "timed out",
                url="http://example.invalid/snapshot",
                status_code=400,
                reachable=True,
                body={"error": "timed out"},
            )
        return {"rows": _source_rows(int(params["external_resolution"]))}


class _TimeSeriesClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._lock = threading.Lock()
        self.values = {
            "2024-01-01": 0,
            "2024-01-02": None,
            "2024-01-03": 4,
        }

    def get_json(self, path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.calls.append((path, dict(params)))
        if path == "/availability":
            return {"dates": ["2023-12-31", *self.values, "2024-01-04"]}
        date_value = str(params["external_date"])
        resolution = int(params["external_resolution"])
        return {
            "rows": [
                {
                    "source_id": "west-cell",
                    "source_lat": 0,
                    "source_lon": 0,
                    "source_value": self.values[date_value],
                    "source_resolution": resolution,
                },
                {
                    "source_id": "east-cell",
                    "source_lat": 5,
                    "source_lon": 5,
                    "source_value": 99,
                    "source_resolution": resolution,
                },
            ],
        }


def _records(
    adapter: SampledGridHttpQueryAdapter,
    bbox: tuple[float, float, float, float],
    resolution: int,
) -> dict[str, Any]:
    return adapter.records_packet(
        date_value="2024-01-01",
        bbox=bbox,
        limit="max",
        offset=0,
        query_context={"requested_resolution_km": resolution},
    )


class SnapshotCacheContractTests(unittest.TestCase):
    def setUp(self) -> None:
        CANONICAL_SNAPSHOT_CACHE.clear()
        CANONICAL_SNAPSHOT_CACHE.configure(max_total_rows=None)

    def tearDown(self) -> None:
        CANONICAL_SNAPSHOT_CACHE.clear()
        CANONICAL_SNAPSHOT_CACHE.configure(max_total_rows=None)

    def test_schema_uses_mapping_default_coverage_instead_of_largest_area(self) -> None:
        dataset = _dataset(resolutions=[4, 16])
        dataset["sampled_grid"]["coverage_areas"] = [
            {
                "id": "small",
                "bounds": {"west": -1, "south": -1, "east": 1, "north": 1},
            },
            {
                "id": "large",
                "bounds": {"west": -10, "south": -10, "east": 10, "north": 10},
            },
        ]
        dataset["sampled_grid"]["default_coverage_id"] = "small"
        client = _TimeSeriesClient()
        adapter = SampledGridHttpQueryAdapter({}, dataset)
        adapter.client = client

        packet = adapter.schema_packet()

        self.assertEqual("/availability", client.calls[0][0])
        self.assertEqual("small", client.calls[0][1]["external_aoi"])
        self.assertEqual("small", packet["sampled_grid"]["default_coverage_id"])

    def test_global_row_budget_evicts_lru_across_namespaces(self) -> None:
        policy = SnapshotCachePolicy.from_contract(_dataset(resolutions=[16])["sampled_grid"])
        CANONICAL_SNAPSHOT_CACHE.configure(max_total_rows=3)
        first_identity = {
            "dataset_id": "first",
            "date": "2024-01-01",
            "coverage_id": "coverage-a",
            "resolution_km": 16,
        }
        second_identity = {
            "dataset_id": "second",
            "date": "2024-01-01",
            "coverage_id": "coverage-a",
            "resolution_km": 16,
        }

        CANONICAL_SNAPSHOT_CACHE.get_or_load(
            "namespace-a",
            policy,
            first_identity,
            lambda: SnapshotLoad(first_identity, {"rows": [{}, {}]}),
        )
        CANONICAL_SNAPSHOT_CACHE.get_or_load(
            "namespace-b",
            policy,
            second_identity,
            lambda: SnapshotLoad(second_identity, {"rows": [{}, {}]}),
        )

        self.assertIsNone(CANONICAL_SNAPSHOT_CACHE.get("namespace-a", policy, first_identity))
        self.assertIsNotNone(CANONICAL_SNAPSHOT_CACHE.get("namespace-b", policy, second_identity))
        self.assertEqual(
            {
                "namespace_entries": 1,
                "total_entries": 1,
                "total_rows": 2,
                "max_total_rows": 3,
            },
            CANONICAL_SNAPSHOT_CACHE.stats("namespace-b"),
        )

    def test_identity_uses_only_mapping_declared_canonical_roles(self) -> None:
        policy = SnapshotCachePolicy.from_contract(_dataset(resolutions=[16])["sampled_grid"])
        shared = {
            "dataset_id": "mapped.sampled_grid",
            "date": "2024-01-01",
            "coverage_id": "coverage-a",
            "resolution_km": 16,
        }

        first = policy.key({**shared, "bbox": "west", "product": "foreign-a"})
        second = policy.key({**shared, "bbox": "east", "product": "foreign-b"})

        self.assertEqual(first, second)
        self.assertNotIn("bbox", dict(first))
        self.assertNotIn("product", dict(first))

    def test_dataset_namespace_changes_with_mapping_semantics(self) -> None:
        first = _dataset(resolutions=[16])
        second = _dataset(resolutions=[16])
        second["sampled_grid"]["source_fields"] = {
            **second["sampled_grid"]["source_fields"],
            "value": "replacement_value",
        }

        self.assertNotEqual(
            dataset_cache_namespace(first),
            dataset_cache_namespace(second),
        )

    def test_dataset_namespace_excludes_credentials_and_visualization(self) -> None:
        first = _dataset(resolutions=[16])
        second = _dataset(resolutions=[16])
        first["endpoint_source"]["auth"] = {"type": "bearer", "token": "first-secret"}
        second["endpoint_source"]["auth"] = {"type": "bearer", "token": "second-secret"}
        first["sampled_grid"]["visualization"] = {"palette": "warm"}
        second["sampled_grid"]["visualization"] = {"palette": "cool"}

        self.assertEqual(
            dataset_cache_namespace(first),
            dataset_cache_namespace(second),
        )

    def test_mapping_projection_does_not_leak_source_fields(self) -> None:
        dataset = _dataset(resolutions=[16])
        source = _source_rows(16)[0]

        row = canonicalize_sampled_grid_row(source, compile_sampled_grid_mapping(dataset))
        public_fields = sampled_grid_public_fields(dataset)

        self.assertNotIn("source_id", row)
        self.assertNotIn("source_value", row)
        self.assertEqual("west-cell", row["cell_id"])
        self.assertEqual(3, row["value"])
        self.assertEqual("date", public_fields["time_column"])
        self.assertEqual(["value"], public_fields["metric_columns"])
        self.assertTrue(set(public_fields["display_columns"]).isdisjoint(source))

    def test_compiled_mapping_does_not_reparse_contract_per_row(self) -> None:
        dataset = _dataset(resolutions=[16])
        context = compile_sampled_grid_mapping(dataset)

        with patch(
            "common_adapter.query.sampled_grid.sampled_grid_source_fields"
        ) as source_fields:
            rows = [
                canonicalize_sampled_grid_row(row, context)
                for row in _source_rows(16) * 50
            ]

        self.assertEqual(100, len(rows))
        source_fields.assert_not_called()

    def test_canonical_mapping_is_idempotent(self) -> None:
        dataset = _dataset(resolutions=[16])
        dataset["sampled_grid"]["source_fields"].update(
            {
                "coverage": "source_coverage",
                "status": "source_status",
            }
        )
        source = {
            **_source_rows(16)[0],
            "source_coverage": 0.75,
            "source_status": "observed",
        }

        first = canonicalize_sampled_grid_packet({"rows": [source]}, dataset)
        second = canonicalize_sampled_grid_packet(first, dataset)

        self.assertEqual(first, second)
        self.assertIs(first["rows"], second["rows"])
        self.assertEqual(SAMPLED_GRID_CONTRACT_VERSION, second["row_contract_version"])
        self.assertEqual("west-cell", second["rows"][0]["cell_id"])
        self.assertEqual(0.75, second["rows"][0]["coverage_ratio"])
        self.assertEqual("observed", second["rows"][0]["data_status"])
        with self.assertRaises(TypeError):
            second["rows"][0]["value"] = 99

    def test_render_transport_lifts_frame_fields_without_mutating_canonical_rows(self) -> None:
        rows = freeze_json(
            [
                {
                    "date": "2024-01-01",
                    "cell_id": "a",
                    "value": 3,
                    "resolution_km": 4,
                    "bounds": {"west": 0, "south": 0, "east": 1, "north": 1},
                },
                {
                    "date": "2024-01-01",
                    "cell_id": "b",
                    "value": 7,
                    "resolution_km": 4,
                    "bounds": {"west": 1, "south": 0, "east": 2, "north": 1},
                },
            ]
        )
        packet = {
            "row_contract_version": SAMPLED_GRID_CONTRACT_VERSION,
            "column_profile": "render",
            "rows": rows,
            "row_count": 2,
            "timing": {"api_total_ms": 10, "api_accounted_ms": 10},
        }

        projected = project_sampled_grid_render_packet(packet)
        inflated = inflate_sampled_grid_render_packet(projected)

        self.assertIs(packet["rows"], rows)
        self.assertEqual(
            {"date": "2024-01-01", "resolution_km": 4},
            projected["transport_projection"]["frame_fields"],
        )
        self.assertNotIn("date", projected["transport_projection"]["row_fields"])
        self.assertNotIn("resolution_km", projected["transport_projection"]["row_fields"])
        self.assertEqual([dict(row) for row in rows], inflated["rows"])
        with self.assertRaises(TypeError):
            rows[0]["value"] = 99

    def test_request_field_mapping_supplies_snapshot_time(self) -> None:
        dataset = _dataset(resolutions=[16])
        dataset["sampled_grid"]["request_fields"] = {"time": "snapshot.date"}

        row = canonicalize_sampled_grid_row(
            _source_rows(16)[0],
            compile_sampled_grid_mapping(dataset),
            context={"snapshot": {"date": "2024-01-02"}},
        )

        self.assertEqual("2024-01-02", row["date"])

    def test_float_rounding_does_not_include_a_boundary_neighbor(self) -> None:
        selected_bbox = {"west": 120.666667, "south": 24.666667, "east": 121.0, "north": 25.0}
        boundary_neighbor = {
            "bounds": {
                "west": 120.66666666666669,
                "south": 24.999999999999996,
                "east": 121.00000000000001,
                "north": 25.33333333333333,
            },
        }

        self.assertFalse(_bounds_intersect(boundary_neighbor, selected_bbox))

    def test_fallback_snapshot_is_reused_across_internal_bboxes(self) -> None:
        dataset = _dataset(resolutions=[4, 16])
        client = _FallbackClient()
        first_adapter = SampledGridHttpQueryAdapter({}, dataset)
        second_adapter = SampledGridHttpQueryAdapter({}, dataset)
        first_adapter.client = client
        second_adapter.client = client

        first = _records(first_adapter, (-1, -1, 1, 1), 4)
        second = _records(second_adapter, (4, 4, 6, 6), 4)

        self.assertEqual([4, 16], [call["external_resolution"] for call in client.calls])
        self.assertEqual(["west-cell"], [row["cell_id"] for row in first["rows"]])
        self.assertEqual(["east-cell"], [row["cell_id"] for row in second["rows"]])
        self.assertEqual(16, first["grid"]["actual_resolution_km"])
        self.assertTrue(first["grid"]["lod_degraded"])
        self.assertFalse(first["timing"]["cache_hit"])
        self.assertTrue(second["timing"]["cache_hit"])
        self.assertEqual(0, second["timing"]["query_ms"])

    def test_cache_consumers_share_immutable_rows(self) -> None:
        dataset = _dataset(resolutions=[16])
        client = _ConcurrentClient()
        adapter = SampledGridHttpQueryAdapter({}, dataset)
        adapter.client = client

        first = _records(adapter, (-1, -1, 1, 1), 16)
        second = _records(adapter, (-1, -1, 1, 1), 16)

        self.assertEqual(1, client.call_count)
        self.assertIs(first["rows"][0], second["rows"][0])
        with self.assertRaises(TypeError):
            second["rows"][0]["value"] = 99
        self.assertEqual(3, first["rows"][0]["value"])

    def test_concurrent_internal_bboxes_share_one_source_request(self) -> None:
        dataset = _dataset(resolutions=[16])
        client = _ConcurrentClient()
        adapters = [
            SampledGridHttpQueryAdapter({}, dataset),
            SampledGridHttpQueryAdapter({}, dataset),
        ]
        for adapter in adapters:
            adapter.client = client

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    lambda item: _records(item[0], item[1], 16),
                    zip(adapters, [(-1, -1, 1, 1), (4, 4, 6, 6)]),
                )
            )

        self.assertEqual(1, client.call_count)
        self.assertEqual({"west-cell", "east-cell"}, {packet["rows"][0]["cell_id"] for packet in results})
        self.assertEqual([False, True], sorted(packet["timing"]["cache_hit"] for packet in results))
        self.assertTrue(any(packet["timing"]["cache_waited"] for packet in results))

    def test_mapping_declared_missing_partition_becomes_negative_cache(self) -> None:
        dataset = _dataset(resolutions=[16])
        dataset["sampled_grid"]["query"]["snapshot"]["no_data"] = {
            "status_codes": [400],
            "error_contains": ["no matching grid partition"],
            "reason": "source_partition_missing",
        }
        client = _NoDataClient()
        adapter = SampledGridHttpQueryAdapter({}, dataset)
        adapter.client = client

        first = _records(adapter, (-1, -1, 1, 1), 16)
        second = _records(adapter, (-1, -1, 1, 1), 16)

        self.assertEqual(1, client.call_count)
        self.assertEqual([], first["rows"])
        self.assertEqual("source_partition_missing", first["grid"]["empty_reason"])
        self.assertFalse(first["timing"]["cache_hit"])
        self.assertTrue(second["timing"]["cache_hit"])

    def test_mapping_declared_transient_error_retries_without_lod_degrade(self) -> None:
        dataset = _dataset(resolutions=[16])
        dataset["sampled_grid"]["query"]["snapshot"]["retry"] = {
            "max_attempts": 2,
            "status_codes": [400],
            "error_contains": ["timed out"],
            "backoff_seconds": 0,
        }
        client = _TransientClient()
        adapter = SampledGridHttpQueryAdapter({}, dataset)
        adapter.client = client

        packet = _records(adapter, (-1, -1, 1, 1), 16)

        self.assertEqual(2, client.call_count)
        self.assertEqual(["west-cell"], [row["cell_id"] for row in packet["rows"]])
        self.assertFalse(packet["grid"]["lod_degraded"])

    def test_time_series_folds_available_snapshots_into_canonical_points(self) -> None:
        dataset = _dataset(resolutions=[16])
        client = _TimeSeriesClient()
        adapter = SampledGridHttpQueryAdapter({}, dataset)
        adapter.client = client

        first = adapter.time_series_packet(
            start_date="2024-01-01",
            end_date="2024-01-03",
            bbox=(-1, -1, 1, 1),
            metric="value",
            aggregation="sum",
            query_context={"requested_resolution_km": 16},
        )
        second = adapter.time_series_packet(
            start_date="2024-01-01",
            end_date="2024-01-03",
            bbox=(-1, -1, 1, 1),
            metric="value",
            aggregation="sum",
            query_context={"requested_resolution_km": 16},
        )

        self.assertEqual([0, None, 4], [point["value"] for point in first["points"]])
        self.assertEqual(3, first["point_count"])
        self.assertEqual(3, first["row_count"])
        self.assertEqual(16, first["grid"]["requested_resolution_km"])
        self.assertEqual(2, first["timing"]["worker_count"])
        self.assertEqual(3, first["timing"]["source_request_count"])
        self.assertTrue(second["timing"]["cache_hit"])
        self.assertEqual(0, second["timing"]["source_request_count"])
        snapshot_calls = [params for path, params in client.calls if path == "/snapshot"]
        self.assertEqual(3, len(snapshot_calls))
        self.assertEqual(
            ["2024-01-01", "2024-01-02", "2024-01-03"],
            sorted(params["external_date"] for params in snapshot_calls),
        )
        self.assertTrue(all(params["external_resolution"] == 16 for params in snapshot_calls))


if __name__ == "__main__":
    unittest.main()
