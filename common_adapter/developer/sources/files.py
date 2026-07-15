from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Callable


class SourceConfigStore:
    """File operations for routed source config JSON files."""

    def __init__(
        self,
        *,
        source_config_dir: Path,
        managed_config_dir: Path,
        local_source_refs: set[str],
        discover_paths: Callable[[], list[Path]],
        load_manifest: Callable[[], dict[str, Any]],
        save_manifest: Callable[[dict[str, Any]], None],
        normalize_config_ref: Callable[[str | Path], str],
        resolve_config_ref: Callable[[str], Path],
        read_config_json: Callable[[Path], tuple[dict[str, Any] | None, str | None]],
        infer_config_group: Callable[[Path, dict[str, Any] | None], str],
        infer_source_group: Callable[[Path], str],
        is_routable_config_group: Callable[[str], bool],
        has_builtin_probe: Callable[[str], bool],
        normalize_source_group: Callable[[str], str],
        is_routable_source_group: Callable[[str], bool],
        target_source_config_path: Callable[[str, str], Path],
        source_group_cards: Callable[[], list[dict[str, Any]]],
    ) -> None:
        self.source_config_dir = source_config_dir
        self.managed_config_dir = managed_config_dir
        self.local_source_refs = local_source_refs
        self.discover_paths = discover_paths
        self.load_manifest = load_manifest
        self.save_manifest = save_manifest
        self.normalize_config_ref = normalize_config_ref
        self.resolve_config_ref = resolve_config_ref
        self.read_config_json = read_config_json
        self.infer_config_group = infer_config_group
        self.infer_source_group = infer_source_group
        self.is_routable_config_group = is_routable_config_group
        self.has_builtin_probe = has_builtin_probe
        self.normalize_source_group = normalize_source_group
        self.is_routable_source_group = is_routable_source_group
        self.target_source_config_path = target_source_config_path
        self.source_group_cards = source_group_cards

    def move_to_source_group(self, config_ref: str, group: str) -> dict[str, Any]:
        path = self.resolve_config_ref(config_ref)
        if not path.exists():
            raise FileNotFoundError("config file not found")
        if path.name.endswith(".example.json"):
            raise ValueError("example config cannot be moved")
        source_root = self.source_config_dir.resolve()
        try:
            path.resolve().relative_to(source_root)
        except ValueError as exc:
            raise ValueError("only source config files can be moved between source groups") from exc
        source_group = self.normalize_source_group(group)
        if not self.is_routable_source_group(source_group):
            raise ValueError("target source group must be a routable folder name")
        current_group = self.infer_source_group(path)
        old_ref = self.normalize_config_ref(path)
        data, error = self.read_config_json(path)
        if error or data is None:
            raise ValueError(f"config cannot be moved until its JSON is valid: {error}")
        data["role"] = source_group
        if current_group == source_group:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return {
                "status": "ok",
                "moved": old_ref,
                "old_path": old_ref,
                "from_group": current_group,
                "group": source_group,
                "manifest": self.load_manifest(),
                "source_groups": self.source_group_cards(),
                "overwrote": False,
            }
        destination = self.target_source_config_path(path.name, source_group)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination_existed = destination.exists()
        target_ref = self.normalize_config_ref(destination)
        if destination_existed:
            destination.unlink()
        shutil.move(str(path), str(destination))
        destination.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        new_ref = self.normalize_config_ref(destination)
        manifest = self.load_manifest()
        active_before = set(manifest["active_configs"])
        locked_before = set(manifest["locked_configs"])
        active_refs = {ref for ref in active_before if ref not in {old_ref, target_ref}}
        locked_refs = {ref for ref in locked_before if ref not in {old_ref, target_ref}}
        if old_ref in active_before or target_ref in active_before:
            active_refs.add(new_ref)
        if old_ref in locked_before or target_ref in locked_before:
            locked_refs.add(new_ref)
        notes = dict(manifest.get("config_notes") or {})
        old_note = notes.pop(old_ref, "")
        target_note = notes.pop(target_ref, "")
        if target_note:
            notes[new_ref] = target_note
        elif old_note:
            notes[new_ref] = old_note
        self.save_manifest(
            {
                "active_configs": sorted(active_refs),
                "locked_configs": sorted(locked_refs),
                "config_notes": notes,
                "imported_layers": manifest.get("imported_layers") or [],
            }
        )
        return {
            "status": "ok",
            "moved": new_ref,
            "old_path": old_ref,
            "from_group": current_group,
            "group": source_group,
            "manifest": self.load_manifest(),
            "source_groups": self.source_group_cards(),
            "overwrote": destination_existed,
        }

    def summarize(
        self,
        path: Path,
        active_refs: set[str],
        locked_refs: set[str] | None = None,
        runtime_refs: set[str] | None = None,
    ) -> dict[str, Any]:
        ref = self.normalize_config_ref(path)
        locked_refs = locked_refs or set()
        runtime_refs = runtime_refs or set()
        manifest = self.load_manifest()
        note = str((manifest.get("config_notes") or {}).get(ref, ""))
        runtime_current = ref in runtime_refs
        if runtime_current and not note:
            note = "目前服務啟動 config"
        data, error = self.read_config_json(path)
        source_group = self.infer_source_group(path)
        group = source_group or self.infer_config_group(path, data)
        declared_role = str((data or {}).get("role") or "").strip().lower()
        role_consistent = bool(source_group and declared_role == source_group)
        role_error = None
        if source_group and error is None and not role_consistent:
            role_error = f'config role "{declared_role or "<missing>"}" must match source folder "{source_group}"'
        resolved_path = path.resolve()
        source_dir = self.source_config_dir.resolve()
        managed_dir = self.managed_config_dir.resolve()
        try:
            resolved_path.relative_to(managed_dir)
            is_managed = True
        except ValueError:
            try:
                resolved_path.relative_to(source_dir)
                is_managed = ref not in self.local_source_refs
            except ValueError:
                is_managed = False
        is_example = group == "demo" or path.name.endswith(".example.json")
        is_locked = ref in locked_refs
        summary: dict[str, Any] = {
            "path": ref,
            "name": path.name,
            "active": self.is_routable_config_group(group) and ref in active_refs,
            "locked": is_locked or runtime_current,
            "runtime_current": runtime_current,
            "managed": is_managed,
            "example": is_example,
            "group": group,
            "source_group": source_group,
            "route_group": group if self.is_routable_config_group(group) else None,
            "routable": self.is_routable_config_group(group),
            "builtin_probe": self.has_builtin_probe(group),
            "delete_allowed": is_managed and not is_locked,
            "edit_allowed": not is_locked and group != "demo",
            "note": note,
            "size_bytes": path.stat().st_size,
            "mtime": path.stat().st_mtime,
            "parse_ok": error is None,
            "error": error or role_error,
            "declared_role": declared_role,
            "role_consistent": role_consistent,
            "route_blocked": bool(error or role_error),
            "connections": [],
            "datasets": [],
        }
        if data:
            connections = data.get("connections") or {}
            if isinstance(connections, dict) and connections:
                summary["connections"] = sorted(str(key) for key in connections.keys())
            datasets = data.get("datasets") or {}
            if isinstance(datasets, dict):
                summary["datasets"] = sorted(str(key) for key in datasets.keys())
        return summary

    def discover(self) -> list[Path]:
        return self.discover_paths()

    def delete_managed(self, config_ref: str) -> dict[str, Any]:
        path = self.resolve_config_ref(config_ref)
        source_dir = self.source_config_dir.resolve()
        try:
            path.relative_to(source_dir)
        except ValueError as exc:
            raise ValueError("only imported configs under config/sources/ can be deleted") from exc
        if not path.exists():
            raise FileNotFoundError("config file not found")
        normalized = self.normalize_config_ref(path)
        if normalized in self.local_source_refs:
            raise ValueError("built-in local source config cannot be deleted")
        manifest = self.load_manifest()
        if normalized in set(manifest["locked_configs"]):
            raise ValueError("locked config cannot be deleted")
        path.unlink()
        active_refs = {ref for ref in manifest["active_configs"] if ref != normalized}
        locked_refs = {ref for ref in manifest["locked_configs"] if ref != normalized}
        notes = dict(manifest.get("config_notes") or {})
        notes.pop(normalized, None)
        self.save_manifest(
            {
                "active_configs": sorted(active_refs),
                "locked_configs": sorted(locked_refs),
                "config_notes": notes,
                "imported_layers": manifest.get("imported_layers") or [],
            }
        )
        return {"deleted": normalized, "manifest": self.load_manifest(), "source_groups": self.source_group_cards()}

    def set_locked(self, config_ref: str, locked: bool) -> dict[str, Any]:
        path = self.resolve_config_ref(config_ref)
        if not path.exists():
            raise FileNotFoundError("config file not found")
        if path.name.endswith(".example.json"):
            raise ValueError("example config is demo-only and cannot be locked")
        normalized = self.normalize_config_ref(path)
        manifest = self.load_manifest()
        active_refs = set(manifest["active_configs"])
        locked_refs = set(manifest["locked_configs"])
        if locked:
            locked_refs.add(normalized)
        else:
            locked_refs.discard(normalized)
        self.save_manifest(
            {
                "active_configs": sorted(active_refs),
                "locked_configs": sorted(locked_refs),
                "config_notes": dict(manifest.get("config_notes") or {}),
                "imported_layers": manifest.get("imported_layers") or [],
            }
        )
        return {"status": "ok", "manifest": self.load_manifest()}

    def set_note(self, config_ref: str, note: str) -> dict[str, Any]:
        path = self.resolve_config_ref(config_ref)
        if not path.exists():
            raise FileNotFoundError("config file not found")
        normalized = self.normalize_config_ref(path)
        manifest = self.load_manifest()
        notes = dict(manifest.get("config_notes") or {})
        cleaned = str(note or "").strip()
        if cleaned:
            notes[normalized] = cleaned[:500]
        else:
            notes.pop(normalized, None)
        self.save_manifest(
            {
                "active_configs": manifest["active_configs"],
                "locked_configs": manifest["locked_configs"],
                "config_notes": notes,
                "imported_layers": manifest.get("imported_layers") or [],
            }
        )
        active_refs = set(self.load_manifest()["active_configs"])
        locked_refs = set(self.load_manifest()["locked_configs"])
        return {"status": "ok", "config": self.summarize(path, active_refs, locked_refs)}

    def write_json_content(self, config_ref: str, content: str) -> dict[str, Any]:
        path = self.resolve_config_ref(config_ref)
        if not path.exists():
            raise FileNotFoundError("config file not found")
        if path.name.endswith(".example.json"):
            raise ValueError("example config is demo-only and cannot be edited")
        normalized = self.normalize_config_ref(path)
        manifest = self.load_manifest()
        if normalized in set(manifest["locked_configs"]):
            raise ValueError("locked config cannot be edited")
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise ValueError("config root must be a JSON object")
        source_group = self.infer_source_group(path)
        declared_role = str(parsed.get("role") or "").strip().lower()
        if source_group and declared_role != source_group:
            raise ValueError(
                f'config role "{declared_role or "<missing>"}" must match source folder "{source_group}"; '
                "use the source-group selector to move this config"
            )
        path.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        active_refs = set(self.load_manifest()["active_configs"])
        locked_refs = set(self.load_manifest()["locked_configs"])
        return {"status": "ok", "config": self.summarize(path, active_refs, locked_refs)}
