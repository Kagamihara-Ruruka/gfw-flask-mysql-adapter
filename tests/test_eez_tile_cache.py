from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from common_adapter.spatial.tile_cache import MvtTileCache


class MvtTileCacheTests(unittest.TestCase):
    def test_tile_survives_process_local_cache_replacement(self) -> None:
        key = ("fill-v1", "eez_v12_tile", 2, 1, 1)
        value = (b"mvt", {"cache": "miss", "cache_tier": "postgis", "timing": {"tile_ms": 42.0}})
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            first_process = MvtTileCache()
            first_process.set(key, value, max_entries=8, directory=directory)

            memory_hit = first_process.get(key, max_entries=8, directory=directory)
            self.assertIsNotNone(memory_hit)
            self.assertEqual(memory_hit[1]["cache_tier"], "memory")

            next_process = MvtTileCache()
            disk_hit = next_process.get(key, max_entries=8, directory=directory)
            self.assertIsNotNone(disk_hit)
            self.assertEqual(disk_hit[0], b"mvt")
            self.assertEqual(disk_hit[1]["cache"], "hit")
            self.assertEqual(disk_hit[1]["cache_tier"], "disk")

    def test_zero_capacity_disables_memory_and_disk_cache(self) -> None:
        key = ("fill-v1", 0, 0, 0)
        value = (b"mvt", {"cache": "miss"})
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            cache = MvtTileCache()
            cache.set(key, value, max_entries=0, directory=directory)

            self.assertIsNone(cache.get(key, max_entries=0, directory=directory))
            self.assertEqual(list(directory.rglob("*.pbf")), [])


if __name__ == "__main__":
    unittest.main()
