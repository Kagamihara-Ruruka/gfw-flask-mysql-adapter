from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from common_adapter.config.paths import router_manifest_path as canonical_router_manifest_path
from common_adapter.developer.sources.ref_policy import manifest_group_for_ref, normalize_config_ref

DATA_LAYER_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
CONFIG_NOTE_MAX_LENGTH = 500


class RouterManifestStore:
    """Persistent developer-page state, similar to a browser cookie store."""

    def __init__(self, path_provider: Callable[[], Path] = canonical_router_manifest_path) -> None:
        self._path_provider = path_provider

    def path(self) -> Path:
        return self._path_provider()

    def normalize_imported_layers(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        layers = {str(item).strip().lower() for item in value}
        return sorted(layer for layer in layers if DATA_LAYER_ID_PATTERN.match(layer))

    def _existing_imported_layers(self, path: Path) -> list[str]:
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return []
        if "imported_layers" not in data:
            return []
        return self.normalize_imported_layers(data.get("imported_layers"))

    def load(self) -> dict[str, Any]:
        path = self.path()
        fallback = {
            "active_configs": [],
            "locked_configs": [],
            "config_notes": {},
            "imported_layers": [],
        }
        if not path.exists():
            return fallback
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return fallback
        active = data.get("active_configs")
        if not isinstance(active, list):
            active = []
        locked = data.get("locked_configs")
        if not isinstance(locked, list):
            locked = []
        notes = data.get("config_notes")
        if not isinstance(notes, dict):
            notes = {}
        imported_layers = self.normalize_imported_layers(data.get("imported_layers"))
        return {
            "active_configs": [str(item) for item in active],
            "locked_configs": [str(item) for item in locked],
            "config_notes": {str(key): str(value) for key, value in notes.items()},
            "imported_layers": imported_layers,
        }

    def save(self, manifest: dict[str, Any]) -> None:
        path = self.path()
        active = sorted({normalize_config_ref(item) for item in manifest.get("active_configs", [])})
        locked = sorted({normalize_config_ref(item) for item in manifest.get("locked_configs", [])})
        notes: dict[str, str] = {}
        for key, value in (manifest.get("config_notes") or {}).items():
            ref = normalize_config_ref(key)
            text = str(value).strip()
            if text:
                notes[ref] = text[:CONFIG_NOTE_MAX_LENGTH]
        active = sorted(ref for ref in active if manifest_group_for_ref(ref))
        if "imported_layers" in manifest:
            imported_layers = self.normalize_imported_layers(manifest.get("imported_layers"))
        else:
            imported_layers = self._existing_imported_layers(path)
        path.write_text(
            json.dumps(
                {
                    "active_configs": active,
                    "locked_configs": locked,
                    "config_notes": notes,
                    "imported_layers": imported_layers,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    def set_layer_import(self, layer_id: str, imported: bool) -> dict[str, Any]:
        layer = str(layer_id or "").strip().lower()
        if not DATA_LAYER_ID_PATTERN.match(layer):
            raise ValueError("unknown data layer")
        manifest = self.load()
        layers = set(self.normalize_imported_layers(manifest.get("imported_layers")))
        if imported:
            layers.add(layer)
        else:
            layers.discard(layer)
        manifest["imported_layers"] = sorted(layers)
        self.save(manifest)
        return {"status": "ok", "manifest": self.load()}


DEFAULT_ROUTER_MANIFEST_STORE = RouterManifestStore()


def router_manifest_path() -> Path:
    return DEFAULT_ROUTER_MANIFEST_STORE.path()


def load_router_manifest() -> dict[str, Any]:
    return DEFAULT_ROUTER_MANIFEST_STORE.load()


def save_router_manifest(manifest: dict[str, Any]) -> None:
    DEFAULT_ROUTER_MANIFEST_STORE.save(manifest)


def normalize_imported_layers(value: Any) -> list[str]:
    return DEFAULT_ROUTER_MANIFEST_STORE.normalize_imported_layers(value)


def _existing_imported_layers(path: Path) -> list[str]:
    return DEFAULT_ROUTER_MANIFEST_STORE._existing_imported_layers(path)


def set_layer_import(layer_id: str, imported: bool) -> dict[str, Any]:
    return DEFAULT_ROUTER_MANIFEST_STORE.set_layer_import(layer_id, imported)
