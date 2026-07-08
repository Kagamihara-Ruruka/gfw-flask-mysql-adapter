from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from common_adapter.config.paths import (
    SOURCE_CONFIG_DIR,
    SOURCE_GROUP_REGISTRY_REF,
    resolve_repo_path,
    to_config_ref,
)


class SourceDrawerRegistry:
    """Registry for source-folder drawers rendered by the developer config browser."""

    def __init__(
        self,
        *,
        ensure_layout: Callable[[], Path],
        normalize_source_group: Callable[[str], str],
        normalize_adapter_group: Callable[[str], str],
        is_routable_source_group: Callable[[str], bool],
        has_builtin_probe: Callable[[str], bool],
    ) -> None:
        self.ensure_layout = ensure_layout
        self.normalize_source_group = normalize_source_group
        self.normalize_adapter_group = normalize_adapter_group
        self.is_routable_source_group = is_routable_source_group
        self.has_builtin_probe = has_builtin_probe

    def registry_path(self) -> Path:
        self.ensure_layout()
        return resolve_repo_path(SOURCE_GROUP_REGISTRY_REF)

    def read_registry(self) -> dict[str, Any]:
        path = self.registry_path()
        if not path.exists():
            return {"groups": []}
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            return {"groups": []}
        return data if isinstance(data, dict) else {"groups": []}

    def write_registry(self, drawers: list[dict[str, Any]]) -> None:
        path = self.registry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        persisted: list[dict[str, Any]] = []
        for item in drawers:
            name = str(item.get("name") or "").strip().lower()
            if not name:
                continue
            persisted.append(
                {
                    "id": int(item.get("id") or 0),
                    "name": name,
                    "path": str(item.get("path") or f"config/sources/{name}"),
                    "created_at": int(item.get("created_at") or 0),
                    "ignore": 1 if int(item.get("_registry_ignore", item.get("ignore") or 0)) else 0,
                    "note": str(item.get("note") or "")[:500],
                }
            )
        payload = {"groups": sorted(persisted, key=lambda item: (int(item.get("id") or 0), str(item.get("name") or "")))}
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def config_count(self, group: str) -> int:
        directory = SOURCE_CONFIG_DIR / group
        if not directory.exists() or not directory.is_dir():
            return 0
        return sum(1 for path in directory.glob("*.json") if path.is_file())

    def raw_drawers(self) -> list[dict[str, Any]]:
        self.ensure_layout()
        registry = self.read_registry()
        registered = {
            str(item.get("name") or ""): item
            for item in registry.get("groups", [])
            if isinstance(item, dict) and str(item.get("name") or "")
        }
        next_id = max((int(item.get("id") or 0) for item in registered.values()), default=0) + 1
        drawers: list[dict[str, Any]] = []
        changed = False
        directories = sorted(
            (path for path in SOURCE_CONFIG_DIR.iterdir() if path.is_dir()),
            key=lambda item: (item.stat().st_ctime, item.name.lower()),
        )
        for directory in directories:
            name = directory.name
            source_group = self.normalize_source_group(name)
            adapter_group = self.normalize_adapter_group(name)
            count = self.config_count(name)
            existing = registered.get(name)
            if existing:
                drawer_id = int(existing.get("id") or next_id)
                created_at = int(existing.get("created_at") or directory.stat().st_ctime)
                registry_ignore = 1 if int(existing.get("ignore") or 0) else 0
                ignore = 1 if count == 0 else registry_ignore
                note = str(existing.get("note") or "")[:500]
            else:
                drawer_id = next_id
                next_id += 1
                created_at = int(directory.stat().st_ctime)
                registry_ignore = 0
                ignore = 1 if count == 0 else registry_ignore
                note = ""
                changed = True
            drawers.append(
                {
                    "item_type": "source_drawer",
                    "id": drawer_id,
                    "name": name,
                    "source_group": source_group,
                    "adapter_group": adapter_group,
                    "group": source_group or name,
                    "path": to_config_ref(directory),
                    "created_at": created_at,
                    "ignore": ignore,
                    "_registry_ignore": registry_ignore,
                    "note": note,
                    "count": count,
                    "routable": self.is_routable_source_group(name),
                    "builtin_probe": self.has_builtin_probe(adapter_group),
                }
            )
        drawers = sorted(drawers, key=lambda item: (int(item["id"]), str(item["name"])))
        persisted_drawers = [
            {
                "id": int(drawer.get("id") or 0),
                "name": str(drawer.get("name") or ""),
                "path": str(drawer.get("path") or ""),
                "created_at": int(drawer.get("created_at") or 0),
                "ignore": 1 if int(drawer.get("_registry_ignore", drawer.get("ignore") or 0)) else 0,
                "note": str(drawer.get("note") or "")[:500],
            }
            for drawer in drawers
        ]
        registered_drawers = [
            {
                "id": int(item.get("id") or 0),
                "name": str(item.get("name") or ""),
                "path": str(item.get("path") or ""),
                "created_at": int(item.get("created_at") or 0),
                "ignore": 1 if int(item.get("ignore") or 0) else 0,
                "note": str(item.get("note") or "")[:500],
            }
            for item in registry.get("groups", [])
            if isinstance(item, dict)
        ]
        if changed or persisted_drawers != registered_drawers:
            self.write_registry(drawers)
        return drawers

    def list_drawers(self) -> list[dict[str, Any]]:
        return [
            {key: value for key, value in drawer.items() if not key.startswith("_")}
            for drawer in self.raw_drawers()
        ]

    def create_drawer(self, group: str) -> dict[str, Any]:
        normalized = self.normalize_source_group(group)
        if not self.is_routable_source_group(normalized):
            raise ValueError("source group must be a routable folder name")
        directory = SOURCE_CONFIG_DIR / normalized
        directory.mkdir(parents=True, exist_ok=True)
        self.write_registry(self.raw_drawers())
        return {"status": "ok", "group": normalized, "source_groups": self.list_drawers()}

    def update_drawer(self, group: str, patch: dict[str, Any]) -> dict[str, Any]:
        normalized = self.normalize_source_group(group)
        if not self.is_routable_source_group(normalized):
            raise ValueError("source group must be a routable folder name")
        directory = SOURCE_CONFIG_DIR / normalized
        if not directory.exists() or not directory.is_dir():
            raise FileNotFoundError("source group folder not found")
        drawers = self.raw_drawers()
        updated = False
        for drawer in drawers:
            if drawer["name"] != normalized:
                continue
            if "ignore" in patch:
                registry_ignore = 1 if int(patch.get("ignore") or 0) else 0
                drawer["_registry_ignore"] = registry_ignore
                drawer["ignore"] = 1 if int(drawer.get("count") or 0) == 0 else registry_ignore
                updated = True
            if "note" in patch:
                drawer["note"] = str(patch.get("note") or "")[:500]
                updated = True
            break
        if not updated:
            raise ValueError("no supported source group fields were provided")
        self.write_registry(drawers)
        return {"status": "ok", "group": normalized, "source_groups": self.list_drawers()}

    def options(self, *suggested_groups: str) -> list[str]:
        groups: set[str] = set()
        for drawer in self.list_drawers():
            group = self.normalize_source_group(str(drawer.get("source_group") or drawer.get("name") or ""))
            if int(drawer.get("ignore") or 0) == 0 and self.is_routable_source_group(group):
                groups.add(group)
        for group in suggested_groups:
            normalized = self.normalize_source_group(group)
            if self.is_routable_source_group(normalized):
                groups.add(normalized)
        return sorted(groups)
