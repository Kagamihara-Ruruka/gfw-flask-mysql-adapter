from __future__ import annotations

import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common_adapter.runtime.config_state import RuntimeConfigStateStore


class RuntimeConfigStateStoreTests(unittest.TestCase):
    def make_store(self, root: Path) -> RuntimeConfigStateStore:
        (root / "config").mkdir(parents=True, exist_ok=True)
        return RuntimeConfigStateStore(root / ".runtime" / "presentation", repo_root=root)

    def test_stage_is_desired_state_until_a_validated_generation_is_prepared(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            target = root / "config" / "source.json"
            target.parent.mkdir(parents=True)
            target.write_text('{"value": 1}\n', encoding="utf-8")
            store = self.make_store(root)

            result = store.stage_json("config/source.json", {"value": 2})

            self.assertEqual("pending_restart", result["config_state"])
            self.assertEqual({"value": 1}, json.loads(target.read_text(encoding="utf-8")))
            prepared = store.prepare_generation(
                validate=lambda: self.assertEqual(
                    {"value": 2},
                    json.loads(target.read_text(encoding="utf-8")),
                )
            )
            self.assertEqual("validated", prepared["status"])
            self.assertEqual(1, prepared["generation"])
            self.assertEqual({"value": 2}, json.loads(target.read_text(encoding="utf-8")))
            self.assertIsNone(store.pending_document("config/source.json"))

    def test_failed_bundle_validation_restores_every_effective_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            first = root / "config" / "first.json"
            second = root / "config" / "second.json"
            first.parent.mkdir(parents=True)
            first.write_text('{"value": "first-old"}\n', encoding="utf-8")
            second.write_text('{"value": "second-old"}\n', encoding="utf-8")
            store = self.make_store(root)
            store.stage_json("config/first.json", {"value": "first-new"})
            store.stage_json("config/second.json", {"value": "second-new"})

            with self.assertRaisesRegex(RuntimeError, "validation failed"):
                store.prepare_generation(validate=lambda: (_ for _ in ()).throw(ValueError("invalid bundle")))

            self.assertEqual({"value": "first-old"}, json.loads(first.read_text(encoding="utf-8")))
            self.assertEqual({"value": "second-old"}, json.loads(second.read_text(encoding="utf-8")))
            self.assertIsNotNone(store.pending_document("config/first.json"))
            self.assertIsNotNone(store.pending_document("config/second.json"))
            state = store.snapshot()
            self.assertEqual("failed", state["status"])
            self.assertEqual("validation", state["error"]["stage"])

    def test_acceptance_cannot_hide_a_pending_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            target = root / "config" / "source.json"
            target.parent.mkdir(parents=True)
            target.write_text('{"value": 1}\n', encoding="utf-8")
            store = self.make_store(root)
            store.stage_json("config/source.json", {"value": 2})

            state = store.mark_effective(
                {"runtime_generation": 4, "runtime_fingerprint": "effective-old"}
            )

            self.assertEqual("pending_restart", state["status"])
            self.assertIn("config/source.json", state["pending"])
            self.assertEqual("effective-old", state["effective"]["runtime_fingerprint"])

    def test_concurrent_desired_state_updates_do_not_lose_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            target = root / "config" / "manifest.json"
            target.parent.mkdir(parents=True)
            target.write_text('{"values": {}}\n', encoding="utf-8")
            store = self.make_store(root)

            def add_value(index: int) -> None:
                def update(document: dict) -> dict:
                    values = dict(document.get("values") or {})
                    values[str(index)] = index
                    document["values"] = values
                    return document

                store.update_json(
                    "config/manifest.json",
                    update,
                    effective={"values": {}},
                )

            with ThreadPoolExecutor(max_workers=8) as executor:
                list(executor.map(add_value, range(24)))

            desired = store.pending_document("config/manifest.json")
            self.assertIsNotNone(desired)
            self.assertEqual({str(index): index for index in range(24)}, desired["values"])


if __name__ == "__main__":
    unittest.main()
