from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from common_adapter.config.atomic_json import atomic_write_json, atomic_write_text

from common_adapter.config.paths import (
    STAGING_CONFIG_DIR,
    canonical_config_ref,
    resolve_repo_path,
    to_config_ref,
)


class StagingConfigStore:
    """State machine for config JSON files waiting under config/staging."""

    def __init__(
        self,
        *,
        ensure_layout: Callable[[], Path],
        safe_import_name: Callable[[str], str],
        normalize_config_ref: Callable[[str | Path], str],
        read_config_json: Callable[[Path], tuple[dict[str, Any] | None, str | None]],
        infer_config_group: Callable[[Path, dict[str, Any] | None], str],
        is_routable_config_group: Callable[[str], bool],
        source_group_options: Callable[..., list[str]],
        normalize_source_group: Callable[[str], str],
        is_routable_source_group: Callable[[str], bool],
        target_source_config_path: Callable[[str, str], Path],
    ) -> None:
        self.ensure_layout = ensure_layout
        self.safe_import_name = safe_import_name
        self.normalize_config_ref = normalize_config_ref
        self.read_config_json = read_config_json
        self.infer_config_group = infer_config_group
        self.is_routable_config_group = is_routable_config_group
        self.source_group_options = source_group_options
        self.normalize_source_group = normalize_source_group
        self.is_routable_source_group = is_routable_source_group
        self.target_source_config_path = target_source_config_path

    def unique_path(self, filename: str) -> Path:
        directory = STAGING_CONFIG_DIR.resolve()
        directory.mkdir(parents=True, exist_ok=True)
        base_name = self.safe_import_name(filename)
        stem = Path(base_name).stem
        suffix = Path(base_name).suffix
        candidate = directory / base_name
        index = 2
        while candidate.exists():
            candidate = directory / f"{stem}-{index}{suffix}"
            index += 1
        return candidate

    def paths(self) -> list[Path]:
        self.ensure_layout()
        return sorted(
            {
                path.resolve()
                for path in STAGING_CONFIG_DIR.glob("*.json")
                if path.is_file()
            },
            key=lambda item: str(item).lower(),
        )

    def resolve_ref(self, staging_ref: str) -> Path:
        path = resolve_repo_path(canonical_config_ref(staging_ref))
        staging_root = STAGING_CONFIG_DIR.resolve()
        try:
            path.relative_to(staging_root)
        except ValueError as exc:
            raise ValueError("staging config path must stay under config/staging/") from exc
        if path.suffix.lower() != ".json":
            raise ValueError("staging config file must be .json")
        return path

    def summarize(self, path: Path) -> dict[str, Any]:
        ref = self.normalize_config_ref(path)
        data, error = self.read_config_json(path)
        suggested_group = self.infer_config_group(path, data)
        return {
            "path": ref,
            "staging_id": ref,
            "name": path.name,
            "size_bytes": path.stat().st_size,
            "mtime": path.stat().st_mtime,
            "parse_ok": error is None,
            "error": error,
            "suggested_group": suggested_group,
            "routable_suggestion": self.is_routable_config_group(suggested_group),
            "file_type": path.suffix.lstrip(".").upper() or "FILE",
        }

    def machine(self) -> dict[str, Any]:
        items = [self.summarize(path) for path in self.paths()]
        if not items:
            status = "empty"
        elif any(not item["parse_ok"] for item in items):
            status = "error"
        else:
            status = "ready"
        return {
            "card_type": "staging",
            "id": 0,
            "name": "staging",
            "machine": "config_staging",
            "path": to_config_ref(STAGING_CONFIG_DIR),
            "status": status,
            "count": len(items),
            "ignore": 0 if items else 1,
            "created_at": 0,
            "note": "暫存候選 config，選定資料源 group 後才導入正式路由。",
            "routable": False,
            "group_options": self.source_group_options(*(str(item.get("suggested_group") or "") for item in items)),
            "items": items,
        }

    def stage_file(self, filename: str, raw: bytes) -> dict[str, Any]:
        if len(raw) > 1024 * 1024:
            raise ValueError("config file is larger than 1 MB")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("config file must be UTF-8 JSON") from exc
        destination = self.unique_path(filename)
        atomic_write_text(destination, text)
        return {
            "status": "ok",
            "staging": self.machine(),
            "item": self.summarize(destination),
            "message": f"已暫存 {destination.name}",
        }

    def promote(self, staging_ref: str, group: str) -> dict[str, Any]:
        path = self.resolve_ref(staging_ref)
        if not path.exists():
            raise FileNotFoundError("staging config file not found")
        source_group = self.normalize_source_group(group)
        if not self.is_routable_source_group(source_group):
            raise ValueError("promote target group must be a routable data source group")
        data, error = self.read_config_json(path)
        if error or data is None:
            raise ValueError(f"staging config is not valid JSON: {error}")
        data["role"] = source_group
        destination = self.target_source_config_path(path.name, source_group)
        atomic_write_json(destination, data)
        path.unlink()
        return {
            "status": "ok",
            "promoted": self.normalize_config_ref(destination),
            "group": source_group,
            "staging": self.machine(),
            "message": f"已導入 {destination.name} 到 {source_group}",
        }

    def delete(self, staging_ref: str) -> dict[str, Any]:
        path = self.resolve_ref(staging_ref)
        if not path.exists():
            raise FileNotFoundError("staging config file not found")
        deleted = self.normalize_config_ref(path)
        path.unlink()
        return {
            "status": "ok",
            "deleted": deleted,
            "staging": self.machine(),
            "message": "暫存 config 已刪除",
        }
