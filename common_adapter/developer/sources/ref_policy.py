from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common_adapter.config.paths import CONFIG_ROOT, SOURCE_CONFIG_DIR, resolve_repo_path, to_config_ref
from common_adapter.developer.sources.groups import DEFAULT_CONFIG_GROUP_CLASSIFIER


def normalize_config_ref(value: str | Path) -> str:
    path = resolve_repo_path(str(value).replace("\\", "/"))
    try:
        path.relative_to(CONFIG_ROOT.resolve())
    except ValueError as exc:
        raise ValueError("config path must stay under config/") from exc
    return to_config_ref(path)


def resolve_config_ref(config_ref: str) -> Path:
    path = resolve_repo_path(str(config_ref).replace("\\", "/"))
    try:
        path.relative_to(CONFIG_ROOT.resolve())
    except ValueError as exc:
        raise ValueError("config path must stay under config/") from exc
    if path.suffix.lower() != ".json":
        raise ValueError("config file must be .json")
    return path


def read_config_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        return None, str(exc)
    if not isinstance(data, dict):
        return None, "config root must be a JSON object"
    return data, None


def manifest_group_for_ref(config_ref: str) -> str:
    try:
        path = resolve_config_ref(config_ref)
        relative = path.resolve().relative_to(SOURCE_CONFIG_DIR.resolve())
        if len(relative.parts) < 2:
            return ""
        source_group = DEFAULT_CONFIG_GROUP_CLASSIFIER.normalize_source_group_name(relative.parts[0])
        data, error = read_config_json(path)
        if error or data is None:
            return ""
        declared_role = str(data.get("role") or "").strip().lower()
        return source_group if source_group and declared_role == source_group else ""
    except (ValueError, OSError):
        return ""
