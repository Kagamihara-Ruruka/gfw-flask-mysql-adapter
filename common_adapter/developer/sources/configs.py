from __future__ import annotations

from pathlib import Path
from typing import Any

from common_adapter.config.paths import (
    CONFIG_ROOT as CONFIG_ROOT_ABS,
    DATABASE_SOURCE_REF,
    SOURCE_CONFIG_DIR,
    SPATIAL_EEZ_SOURCE_REF,
    STAGING_CONFIG_DIR,
    WEBSOCKET_AIS_SOURCE_REF,
    ensure_config_layout,
    source_config_paths,
)
from common_adapter.developer.sources.drawers import SourceDrawerRegistry
from common_adapter.developer.sources.files import SourceConfigStore
from common_adapter.developer.sources.groups import (
    BUILTIN_PROBE_GROUPS,
    CONFIG_GROUPS,
    CONFIG_NAME_PATTERN,
    DEFAULT_CONFIG_GROUP_CLASSIFIER,
    NON_ROUTABLE_CONFIG_GROUPS,
    RESERVED_SOURCE_GROUPS,
    ROUTE_GROUP_PATTERN,
)
from common_adapter.developer.sources.staging import StagingConfigStore
from common_adapter.developer.sources.ref_policy import (
    manifest_group_for_ref,
    normalize_config_ref,
    read_config_json,
    resolve_config_ref,
)
from common_adapter.developer.state.manifest import load_router_manifest, save_router_manifest

ROOT = Path(__file__).resolve().parents[3]
CONFIG_ROOT = Path("config")
MANAGED_CONFIG_DIR = SOURCE_CONFIG_DIR / "managed"
STAGING_CONFIG_DIR_REL = CONFIG_ROOT / "staging"
LOCAL_SOURCE_REFS = {DATABASE_SOURCE_REF, SPATIAL_EEZ_SOURCE_REF, WEBSOCKET_AIS_SOURCE_REF}


def config_root() -> Path:
    ensure_config_layout()
    return CONFIG_ROOT_ABS.resolve()


def normalize_config_group(value: str) -> str:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.normalize_config_group(value)


def is_routable_config_group(group: str) -> bool:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.is_routable_config_group(group)


def normalize_source_group_name(value: str) -> str:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.normalize_source_group_name(value)


def is_routable_source_group_name(group: str) -> bool:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.is_routable_source_group_name(group)


def has_builtin_probe(group: str) -> bool:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.has_builtin_probe(group)


def infer_config_group(path: Path, data: dict[str, Any] | None = None) -> str:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.infer_config_group(path, data)


def infer_source_group_name(path: Path) -> str:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.infer_source_group_name(path)


def safe_import_name(filename: str) -> str:
    name = CONFIG_NAME_PATTERN.sub("_", Path(filename or "imported-config.json").name).strip("._")
    if not name:
        name = "imported-config.json"
    if not name.lower().endswith(".json"):
        name = f"{name}.json"
    return name


def unique_source_config_path(filename: str, group: str) -> Path:
    source_group = normalize_source_group_name(group)
    if not is_routable_source_group_name(source_group):
        raise ValueError("imported config must declare or imply a routable data source")
    directory = (SOURCE_CONFIG_DIR / source_group).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    base_name = safe_import_name(filename)
    stem = Path(base_name).stem
    suffix = Path(base_name).suffix
    candidate = directory / base_name
    index = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{index}{suffix}"
        index += 1
    return candidate


def target_source_config_path(filename: str, group: str) -> Path:
    source_group = normalize_source_group_name(group)
    if not is_routable_source_group_name(source_group):
        raise ValueError("imported config must declare or imply a routable data source")
    directory = (SOURCE_CONFIG_DIR / source_group).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory / safe_import_name(filename)


DEFAULT_STAGING_CONFIG_STORE = StagingConfigStore(
    ensure_layout=config_root,
    safe_import_name=safe_import_name,
    normalize_config_ref=normalize_config_ref,
    read_config_json=lambda path: read_config_json(path),
    infer_config_group=infer_config_group,
    is_routable_config_group=is_routable_config_group,
    source_group_options=lambda *groups: source_group_options(*groups),
    normalize_source_group=normalize_source_group_name,
    is_routable_source_group=is_routable_source_group_name,
    target_source_config_path=target_source_config_path,
)


def unique_managed_config_path(filename: str, group: str) -> Path:
    return unique_source_config_path(filename, group)


def unique_staging_config_path(filename: str) -> Path:
    return DEFAULT_STAGING_CONFIG_STORE.unique_path(filename)


def staging_config_paths() -> list[Path]:
    return DEFAULT_STAGING_CONFIG_STORE.paths()


def resolve_staging_config_ref(staging_ref: str) -> Path:
    return DEFAULT_STAGING_CONFIG_STORE.resolve_ref(staging_ref)


DEFAULT_SOURCE_DRAWER_REGISTRY = SourceDrawerRegistry(
    ensure_layout=config_root,
    normalize_source_group=normalize_source_group_name,
    normalize_adapter_group=normalize_config_group,
    is_routable_source_group=is_routable_source_group_name,
    has_builtin_probe=has_builtin_probe,
)


def source_group_registry_path() -> Path:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.registry_path()


def _read_source_group_registry() -> dict[str, Any]:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.read_registry()


def _write_source_group_registry(groups: list[dict[str, Any]]) -> None:
    DEFAULT_SOURCE_DRAWER_REGISTRY.write_registry(groups)


def _source_group_config_count(group: str) -> int:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.config_count(group)


def _source_group_cards_raw() -> list[dict[str, Any]]:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.raw_drawers()


def source_group_cards() -> list[dict[str, Any]]:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.list_drawers()


def create_source_group(group: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.create_drawer(group)


def update_source_group_card(group: str, patch: dict[str, Any]) -> dict[str, Any]:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.update_drawer(group, patch)


def source_group_options(*suggested_groups: str) -> list[str]:
    return DEFAULT_SOURCE_DRAWER_REGISTRY.options(*suggested_groups)


def summarize_staging_config_file(path: Path) -> dict[str, Any]:
    return DEFAULT_STAGING_CONFIG_STORE.summarize(path)


def staging_config_machine() -> dict[str, Any]:
    return DEFAULT_STAGING_CONFIG_STORE.machine()


def stage_config_file(filename: str, raw: bytes) -> dict[str, Any]:
    return DEFAULT_STAGING_CONFIG_STORE.stage_file(filename, raw)


def promote_staging_config(staging_ref: str, group: str) -> dict[str, Any]:
    return DEFAULT_STAGING_CONFIG_STORE.promote(staging_ref, group)


def delete_staging_config(staging_ref: str) -> dict[str, Any]:
    return DEFAULT_STAGING_CONFIG_STORE.delete(staging_ref)


DEFAULT_SOURCE_CONFIG_STORE = SourceConfigStore(
    source_config_dir=SOURCE_CONFIG_DIR,
    managed_config_dir=MANAGED_CONFIG_DIR,
    local_source_refs=LOCAL_SOURCE_REFS,
    discover_paths=source_config_paths,
    load_manifest=load_router_manifest,
    save_manifest=save_router_manifest,
    normalize_config_ref=normalize_config_ref,
    resolve_config_ref=resolve_config_ref,
    read_config_json=read_config_json,
    infer_config_group=infer_config_group,
    infer_source_group=infer_source_group_name,
    is_routable_config_group=is_routable_config_group,
    has_builtin_probe=has_builtin_probe,
    normalize_source_group=normalize_source_group_name,
    is_routable_source_group=is_routable_source_group_name,
    target_source_config_path=target_source_config_path,
    source_group_cards=source_group_cards,
)


def move_config_to_source_group(config_ref: str, group: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CONFIG_STORE.move_to_source_group(config_ref, group)


def summarize_config_file(
    path: Path,
    active_refs: set[str],
    locked_refs: set[str] | None = None,
    runtime_refs: set[str] | None = None,
) -> dict[str, Any]:
    return DEFAULT_SOURCE_CONFIG_STORE.summarize(path, active_refs, locked_refs, runtime_refs)


def discover_config_files() -> list[Path]:
    return DEFAULT_SOURCE_CONFIG_STORE.discover()


def delete_managed_config(config_ref: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CONFIG_STORE.delete_managed(config_ref)


def set_config_locked(config_ref: str, locked: bool) -> dict[str, Any]:
    return DEFAULT_SOURCE_CONFIG_STORE.set_locked(config_ref, locked)


def set_config_note(config_ref: str, note: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CONFIG_STORE.set_note(config_ref, note)


def write_config_json_content(config_ref: str, content: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CONFIG_STORE.write_json_content(config_ref, content)
