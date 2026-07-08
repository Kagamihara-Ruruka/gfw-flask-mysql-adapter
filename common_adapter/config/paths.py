from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CONFIG_ROOT = ROOT / "config"

RUNTIME_DIR = CONFIG_ROOT / "runtime"
SOURCE_CONFIG_DIR = CONFIG_ROOT / "sources"
MANAGED_SOURCE_DIR = SOURCE_CONFIG_DIR / "managed"
STAGING_CONFIG_DIR = CONFIG_ROOT / "staging"
STATE_DIR = CONFIG_ROOT / "state"
ARTIFACTS_DIR = CONFIG_ROOT / "artifacts"

RUNTIME_CONFIG_REF = "config/runtime/adapter.local.json"
LEGACY_RUNTIME_CONFIG_REF = "config/adapter.local.json"
EXAMPLE_RUNTIME_CONFIG_REF = "config/examples/runtime/adapter.example.json"

DATABASE_SOURCE_REF = "config/sources/database/local.json"
SPATIAL_EEZ_SOURCE_REF = "config/sources/spatial/eez.local.json"
WEBSOCKET_AIS_SOURCE_REF = "config/sources/websocket/aisstream.local.json"

ROUTER_MANIFEST_REF = "config/state/router_manifest.local.json"
LEGACY_ROUTER_MANIFEST_REF = "config/router_manifest.local.json"
SOURCE_GROUP_REGISTRY_REF = "config/state/source_groups.local.json"

LAYER_MAPPINGS_REF = "config/artifacts/layer_mappings.local.json"
LEGACY_LAYER_MAPPINGS_REF = "config/layer_mappings.local.json"

LEGACY_SOURCE_REF_MAP = {
    "config/database.local.json": DATABASE_SOURCE_REF,
    "config/spatial.eez.local.json": SPATIAL_EEZ_SOURCE_REF,
    "config/websocket.aisstream.local.json": WEBSOCKET_AIS_SOURCE_REF,
}

LEGACY_REF_MAP = {
    LEGACY_RUNTIME_CONFIG_REF: RUNTIME_CONFIG_REF,
    LEGACY_ROUTER_MANIFEST_REF: ROUTER_MANIFEST_REF,
    LEGACY_LAYER_MAPPINGS_REF: LAYER_MAPPINGS_REF,
    **LEGACY_SOURCE_REF_MAP,
}


def resolve_repo_path(value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    return (ROOT / path).resolve()


def to_config_ref(path: str | Path) -> str:
    resolved = resolve_repo_path(path)
    rel = resolved.relative_to(CONFIG_ROOT.resolve())
    return str((Path("config") / rel).as_posix())


def canonical_config_ref(value: str | Path) -> str:
    text = str(value).replace("\\", "/")
    return LEGACY_REF_MAP.get(text, text)


def canonical_config_path(value: str | Path) -> Path:
    return resolve_repo_path(canonical_config_ref(value))


def router_manifest_path() -> Path:
    ensure_config_layout()
    return canonical_config_path(ROUTER_MANIFEST_REF)


def layer_mappings_path() -> Path:
    ensure_config_layout()
    return canonical_config_path(LAYER_MAPPINGS_REF)


def source_config_paths() -> list[Path]:
    ensure_config_layout()
    return sorted(
        {
            path.resolve()
            for path in SOURCE_CONFIG_DIR.glob("*/*.json")
            if path.is_file()
        },
        key=lambda item: str(item).lower(),
    )


def runtime_config_path(value: str | Path | None = None) -> Path | None:
    ensure_config_layout()
    if value:
        requested = resolve_repo_path(value)
        if requested.exists():
            return canonical_config_path(to_config_ref(requested))
        canonical = canonical_config_path(value)
        if canonical.exists():
            return canonical
        return requested
    runtime = canonical_config_path(RUNTIME_CONFIG_REF)
    if runtime.exists():
        return runtime
    legacy = resolve_repo_path(LEGACY_RUNTIME_CONFIG_REF)
    if legacy.exists():
        return legacy
    example = canonical_config_path(EXAMPLE_RUNTIME_CONFIG_REF)
    return example if example.exists() else None


def ensure_config_dirs() -> None:
    for directory in (
        CONFIG_ROOT,
        RUNTIME_DIR,
        SOURCE_CONFIG_DIR,
        MANAGED_SOURCE_DIR,
        STAGING_CONFIG_DIR,
        STATE_DIR,
        ARTIFACTS_DIR,
        SOURCE_CONFIG_DIR / "database",
        SOURCE_CONFIG_DIR / "spatial",
        SOURCE_CONFIG_DIR / "websocket",
    ):
        directory.mkdir(parents=True, exist_ok=True)


def _move_if_needed(legacy_ref: str, canonical_ref: str) -> bool:
    legacy = resolve_repo_path(legacy_ref)
    canonical = resolve_repo_path(canonical_ref)
    if not legacy.exists() or canonical.exists():
        return False
    canonical.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(legacy), str(canonical))
    return True


def _read_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _remap_manifest_refs(manifest: dict[str, Any]) -> dict[str, Any]:
    def remap(value: Any) -> str:
        return canonical_config_ref(str(value).strip())

    active = [remap(item) for item in manifest.get("active_configs") or [] if str(item).strip()]
    locked = [remap(item) for item in manifest.get("locked_configs") or [] if str(item).strip()]
    notes = {
        remap(key): str(value)
        for key, value in (manifest.get("config_notes") or {}).items()
        if str(key).strip() and str(value).strip()
    }
    groups = {
        remap(key): str(value)
        for key, value in (manifest.get("config_groups") or {}).items()
        if str(key).strip() and str(value).strip()
    }
    imported_layers = manifest.get("imported_layers")
    if not isinstance(imported_layers, list):
        imported_layers = ["ais", "eez", "gfw"]
    return {
        "active_configs": sorted(set(active)),
        "locked_configs": sorted(set(locked)),
        "config_notes": notes,
        "config_groups": groups,
        "imported_layers": sorted({str(item) for item in imported_layers}),
    }


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _migrate_managed_sources() -> bool:
    legacy_dir = CONFIG_ROOT / "managed"
    if not legacy_dir.exists():
        return False
    changed = False
    MANAGED_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    for source in legacy_dir.glob("*.json"):
        target = MANAGED_SOURCE_DIR / source.name
        if not target.exists():
            shutil.move(str(source), str(target))
            changed = True
    return changed


def ensure_config_layout() -> None:
    ensure_config_dirs()
    for legacy_ref, canonical_ref in LEGACY_REF_MAP.items():
        _move_if_needed(legacy_ref, canonical_ref)
    _migrate_managed_sources()

    canonical_manifest = resolve_repo_path(ROUTER_MANIFEST_REF)
    legacy_manifest = resolve_repo_path(LEGACY_ROUTER_MANIFEST_REF)
    manifest = _read_json_if_exists(canonical_manifest) or _read_json_if_exists(legacy_manifest)
    if manifest is not None:
        remapped = _remap_manifest_refs(manifest)
        if remapped != manifest or not canonical_manifest.exists():
            _write_manifest(canonical_manifest, remapped)
