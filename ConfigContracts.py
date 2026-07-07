from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
ROUTER_MANIFEST_PATH = ROOT / "config" / "router_manifest.local.json"


def resolve_config_path(value: str | Path, *, base_path: Path | None = None) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    base = base_path.parent if base_path else ROOT
    resolved = (base / path).resolve()
    if resolved.exists():
        return resolved
    return (ROOT / path).resolve()


def read_config_json(path: str | Path) -> dict[str, Any]:
    resolved = Path(path)
    with resolved.open("r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"config root must be an object: {resolved}")
    return data


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _router_manifest_active_refs() -> list[str]:
    if not ROUTER_MANIFEST_PATH.exists():
        return []
    data = read_config_json(ROUTER_MANIFEST_PATH)
    active = data.get("active_configs")
    if not isinstance(active, list):
        return []
    return [str(item) for item in active if str(item).strip()]


def _iter_config_refs(config: dict[str, Any], *, root_profile: bool = False) -> list[str]:
    if root_profile:
        manifest_refs = _router_manifest_active_refs()
        if manifest_refs:
            return manifest_refs
    refs = config.get("config_refs") or config.get("include_configs") or []
    if isinstance(refs, dict):
        ordered: list[str] = []
        for group in ("database", "spatial", "websocket"):
            value = refs.get(group)
            if isinstance(value, str):
                ordered.append(value)
            elif isinstance(value, list):
                ordered.extend(str(item) for item in value)
        for key, value in refs.items():
            if key in {"database", "spatial", "websocket"}:
                continue
            if isinstance(value, str):
                ordered.append(value)
            elif isinstance(value, list):
                ordered.extend(str(item) for item in value)
        return ordered
    if isinstance(refs, str):
        return [refs]
    if isinstance(refs, list):
        return [str(item) for item in refs]
    return []


def _runtime_payload(config: dict[str, Any]) -> dict[str, Any]:
    payload = dict(config)
    payload.pop("config_refs", None)
    payload.pop("include_configs", None)
    payload.pop("schema", None)
    payload.pop("role", None)
    payload.pop("description", None)
    payload.pop("kind", None)
    return payload


def load_assembled_config(path: str | Path, *, seen: set[Path] | None = None, root_profile: bool = True) -> dict[str, Any]:
    config_path = resolve_config_path(path)
    seen = seen or set()
    if config_path in seen:
        raise ValueError(f"config include cycle detected: {config_path}")
    seen.add(config_path)

    root_config = read_config_json(config_path)
    assembled: dict[str, Any] = {}
    fragment_paths: list[str] = []
    for ref in _iter_config_refs(root_config, root_profile=root_profile):
        fragment_path = resolve_config_path(ref, base_path=config_path)
        fragment = load_assembled_config(fragment_path, seen=set(seen), root_profile=False)
        fragment_paths.append(str(fragment_path))
        assembled = deep_merge(assembled, _runtime_payload(fragment))

    assembled = deep_merge(assembled, _runtime_payload(root_config))
    assembled["__config_path"] = str(config_path)
    if fragment_paths:
        assembled["__config_fragments"] = fragment_paths
    return assembled
