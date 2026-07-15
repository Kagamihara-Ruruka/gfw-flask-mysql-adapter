from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from common_adapter.developer.artifacts.layer_mappings import LayerMappingStore
from common_adapter.developer.sources.files import SourceConfigStore
from common_adapter.developer.state.manifest import RouterManifestStore


class SourceConfigRegistrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.source_root = self.root / "config" / "sources"
        self.source_root.mkdir(parents=True)
        self.manifest = {
            "active_configs": [],
            "locked_configs": [],
            "config_notes": {},
            "imported_layers": [],
        }

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def ref(self, value: str | Path) -> str:
        path = Path(value)
        if not path.is_absolute():
            path = self.root / path
        return path.resolve().relative_to(self.root.resolve()).as_posix()

    def resolve(self, value: str) -> Path:
        return (self.root / value).resolve()

    @staticmethod
    def read_json(path: Path) -> tuple[dict | None, str | None]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            return None, str(exc)
        return (value, None) if isinstance(value, dict) else (None, "config root must be an object")

    def source_group(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.source_root.resolve()).parts[0]
        except (ValueError, IndexError):
            return ""

    def save_manifest(self, manifest: dict) -> None:
        self.manifest = {
            "active_configs": list(manifest.get("active_configs") or []),
            "locked_configs": list(manifest.get("locked_configs") or []),
            "config_notes": dict(manifest.get("config_notes") or {}),
            "imported_layers": list(manifest.get("imported_layers") or []),
        }

    def store(self) -> SourceConfigStore:
        return SourceConfigStore(
            source_config_dir=self.source_root,
            managed_config_dir=self.source_root / "managed",
            local_source_refs=set(),
            discover_paths=lambda: list(self.source_root.glob("*/*.json")),
            load_manifest=lambda: dict(self.manifest),
            save_manifest=self.save_manifest,
            normalize_config_ref=self.ref,
            resolve_config_ref=self.resolve,
            read_config_json=self.read_json,
            infer_config_group=lambda path, _data: self.source_group(path),
            infer_source_group=self.source_group,
            is_routable_config_group=bool,
            has_builtin_probe=lambda _group: True,
            normalize_source_group=lambda value: str(value).strip().lower(),
            is_routable_source_group=bool,
            target_source_config_path=lambda filename, group: self.source_root / group / filename,
            source_group_cards=lambda: [],
        )

    def write_source(self, group: str, name: str, role: str) -> Path:
        path = self.source_root / group / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"role": role, "name": "route"}), encoding="utf-8")
        return path

    def test_move_updates_role_path_manifest_and_note_together(self) -> None:
        source = self.write_source("endpoint", "route.local.json", "endpoint")
        old_ref = self.ref(source)
        self.manifest = {
            "active_configs": [old_ref],
            "locked_configs": [],
            "config_notes": {old_ref: "persistent note"},
            "imported_layers": ["registered.layer"],
        }

        packet = self.store().move_to_source_group(old_ref, "database")

        new_path = self.source_root / "database" / source.name
        new_ref = self.ref(new_path)
        self.assertFalse(source.exists())
        self.assertTrue(new_path.exists())
        self.assertEqual("database", json.loads(new_path.read_text(encoding="utf-8"))["role"])
        self.assertEqual([new_ref], self.manifest["active_configs"])
        self.assertEqual({new_ref: "persistent note"}, self.manifest["config_notes"])
        self.assertEqual(["registered.layer"], self.manifest["imported_layers"])
        self.assertEqual(new_ref, packet["moved"])

    def test_same_drawer_repairs_declared_role(self) -> None:
        source = self.write_source("database", "route.local.json", "endpoint")

        packet = self.store().move_to_source_group(self.ref(source), "database")

        self.assertEqual(self.ref(source), packet["moved"])
        self.assertEqual("database", json.loads(source.read_text(encoding="utf-8"))["role"])


class RegistryArtifactTests(unittest.TestCase):
    def test_new_manifest_has_no_implicit_imported_layers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "router_manifest.local.json"
            manifest = RouterManifestStore(lambda: path).load()

        self.assertEqual([], manifest["imported_layers"])

    def test_mapping_save_does_not_implicitly_import_layer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layer_mappings.local.json"
            store = LayerMappingStore(lambda: path)
            existing_manifest = {
                "active_configs": ["config/sources/database/local.json"],
                "locked_configs": [],
                "config_notes": {},
                "imported_layers": ["existing.layer"],
            }
            mapping = {
                "config_path": "config/sources/database/local.json",
                "connection_ref": "local_mysql",
                "backend": "mysql",
                "database": "ocean_fishery",
                "table": "gold_grid",
                "dataset_id": "new_dataset",
                "layer_id": "new.layer",
                "roles": {"time": "obs_date", "lat": "lat", "lon": "lon"},
            }
            with patch(
                "common_adapter.developer.artifacts.layer_mappings.load_router_manifest",
                return_value=existing_manifest,
            ):
                packet = store.upsert(mapping)

        self.assertEqual(["existing.layer"], packet["manifest"]["imported_layers"])
        self.assertEqual("new.layer", packet["mapping"]["layer_id"])


if __name__ == "__main__":
    unittest.main()
