from __future__ import annotations

import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from common_adapter.endpoint.client import EndpointRequestError
from common_adapter.endpoint.sampled_grid import SampledGridHttpQueryAdapter
from common_adapter.query.snapshot_cache import (
    CANONICAL_SNAPSHOT_CACHE,
    SnapshotCachePolicy,
)
from common_adapter.query.sampled_grid import (
    canonicalize_sampled_grid_row,
    sampled_grid_public_fields,
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

    def tearDown(self) -> None:
        CANONICAL_SNAPSHOT_CACHE.clear()

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

    def test_mapping_projection_does_not_leak_source_fields(self) -> None:
        dataset = _dataset(resolutions=[16])
        source = _source_rows(16)[0]

        row = canonicalize_sampled_grid_row(source, dataset)
        public_fields = sampled_grid_public_fields(dataset)

        self.assertNotIn("source_id", row)
        self.assertNotIn("source_value", row)
        self.assertEqual("west-cell", row["cell_id"])
        self.assertEqual(3, row["value"])
        self.assertEqual("date", public_fields["time_column"])
        self.assertEqual(["value"], public_fields["metric_columns"])
        self.assertTrue(set(public_fields["display_columns"]).isdisjoint(source))

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


if __name__ == "__main__":
    unittest.main()
