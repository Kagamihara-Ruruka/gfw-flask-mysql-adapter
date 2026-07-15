from __future__ import annotations

import unittest

from common_adapter.registry import KeyedRegistry, group_by_key, unique_by


class KeyedRegistryTests(unittest.TestCase):
    def test_unique_by_preserves_first_item_order(self) -> None:
        rows = [
            {"id": "a", "value": 1},
            {"id": "b", "value": 2},
            {"id": "a", "value": 3},
        ]

        result = unique_by(rows, key=lambda row: row["id"])

        self.assertEqual([1, 2], [row["value"] for row in result])

    def test_group_by_key_retains_every_layer(self) -> None:
        rows = [
            {"grid": "shared", "layer": "chlor"},
            {"grid": "other", "layer": "gfw"},
            {"grid": "shared", "layer": "sst"},
        ]

        groups = group_by_key(rows, key=lambda row: row["grid"])

        self.assertEqual(["chlor", "sst"], [row["layer"] for row in groups["shared"]])
        self.assertEqual(["gfw"], [row["layer"] for row in groups["other"]])

    def test_intern_reuses_value_and_calls_factory_once(self) -> None:
        registry: KeyedRegistry[str, object] = KeyedRegistry()
        calls = 0

        def factory() -> object:
            nonlocal calls
            calls += 1
            return object()

        first = registry.intern("shared", factory)
        second = registry.intern("shared", factory)

        self.assertIs(first, second)
        self.assertEqual(1, calls)
        self.assertEqual(1, len(registry))


if __name__ == "__main__":
    unittest.main()
