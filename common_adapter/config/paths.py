from __future__ import annotations

import os
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
EXAMPLE_RUNTIME_CONFIG_REF = "config/examples/runtime/adapter.example.json"

DATABASE_SOURCE_REF = "config/sources/database/local.json"
SPATIAL_EEZ_SOURCE_REF = "config/sources/spatial/eez.local.json"
WEBSOCKET_AIS_SOURCE_REF = "config/sources/websocket/aisstream.local.json"

ROUTER_MANIFEST_REF = "config/state/router_manifest.local.json"
SOURCE_GROUP_REGISTRY_REF = "config/state/source_groups.local.json"

LAYER_MAPPINGS_REF = "config/artifacts/layer_mappings.local.json"

ROUTER_MANIFEST_ENV = "BDDE38_ROUTER_MANIFEST_PATH"
LAYER_MAPPINGS_ENV = "BDDE38_LAYER_MAPPINGS_PATH"


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
    return str(value).replace("\\", "/")


def canonical_config_path(value: str | Path) -> Path:
    return resolve_repo_path(canonical_config_ref(value))


def router_manifest_path() -> Path:
    ensure_config_layout()
    return canonical_config_path(os.environ.get(ROUTER_MANIFEST_ENV) or ROUTER_MANIFEST_REF)


def layer_mappings_path() -> Path:
    ensure_config_layout()
    return canonical_config_path(os.environ.get(LAYER_MAPPINGS_ENV) or LAYER_MAPPINGS_REF)


def activate_runtime_profile(config: dict[str, Any]) -> dict[str, str]:
    """Make the profile's control artifacts explicit for this process generation."""

    manifest_path = str(config.get("__router_manifest_path") or ROUTER_MANIFEST_REF)
    mappings_path = str(config.get("__layer_mappings_path") or LAYER_MAPPINGS_REF)
    os.environ[ROUTER_MANIFEST_ENV] = manifest_path
    os.environ[LAYER_MAPPINGS_ENV] = mappings_path
    return {
        "manifest_path": str(canonical_config_path(manifest_path)),
        "mapping_path": str(canonical_config_path(mappings_path)),
    }


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
        SOURCE_CONFIG_DIR / "endpoint",
        SOURCE_CONFIG_DIR / "spatial",
        SOURCE_CONFIG_DIR / "websocket",
    ):
        directory.mkdir(parents=True, exist_ok=True)


def ensure_config_layout() -> None:
    ensure_config_dirs()
