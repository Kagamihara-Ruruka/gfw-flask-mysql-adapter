from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from common_adapter.config.paths import (
    CONFIG_ROOT as CONFIG_ROOT_ABS,
    DATABASE_SOURCE_REF,
    SOURCE_CONFIG_DIR,
    SPATIAL_EEZ_SOURCE_REF,
    STAGING_CONFIG_DIR,
    WEBSOCKET_AIS_SOURCE_REF,
    canonical_config_ref,
    ensure_config_layout,
    resolve_repo_path,
    source_config_paths,
    to_config_ref,
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


def _manifest_group_for_ref(config_ref: str, groups: dict[str, str]) -> str:
    group = normalize_config_group(groups.get(config_ref, ""))
    if group:
        return group
    try:
        path = resolve_config_ref(config_ref)
        data, _error = read_config_json(path)
        return infer_config_group(path, data)
    except Exception:
        return ""


def infer_config_group(path: Path, data: dict[str, Any] | None = None) -> str:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.infer_config_group(path, data)


def infer_source_group_name(path: Path) -> str:
    return DEFAULT_CONFIG_GROUP_CLASSIFIER.infer_source_group_name(path)


def normalize_config_ref(value: str | Path) -> str:
    root = config_root()
    path = resolve_repo_path(canonical_config_ref(value))
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError("config path must stay under config/") from exc
    return to_config_ref(path)


def resolve_config_ref(config_ref: str) -> Path:
    root = config_root()
    path = resolve_repo_path(canonical_config_ref(config_ref))
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError("config path must stay under config/") from exc
    if path.suffix.lower() != ".json":
        raise ValueError("config file must be .json")
    return path


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


def read_config_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        return None, str(exc)
    if not isinstance(data, dict):
        return None, "config root must be a JSON object"
    return data, None


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


_config_root_impl = config_root
_normalize_config_group_impl = normalize_config_group
_is_routable_config_group_impl = is_routable_config_group
_normalize_source_group_name_impl = normalize_source_group_name
_is_routable_source_group_name_impl = is_routable_source_group_name
_has_builtin_probe_impl = has_builtin_probe
_manifest_group_for_ref_impl = _manifest_group_for_ref
_infer_config_group_impl = infer_config_group
_normalize_config_ref_impl = normalize_config_ref
_resolve_config_ref_impl = resolve_config_ref
_safe_import_name_impl = safe_import_name
_unique_source_config_path_impl = unique_source_config_path
_target_source_config_path_impl = target_source_config_path
_unique_managed_config_path_impl = unique_managed_config_path
_unique_staging_config_path_impl = unique_staging_config_path
_read_config_json_impl = read_config_json
_staging_config_paths_impl = staging_config_paths
_resolve_staging_config_ref_impl = resolve_staging_config_ref
_source_group_cards_impl = source_group_cards
_create_source_group_impl = create_source_group
_update_source_group_card_impl = update_source_group_card
_source_group_options_impl = source_group_options
_summarize_staging_config_file_impl = summarize_staging_config_file
_staging_config_machine_impl = staging_config_machine
_stage_config_file_impl = stage_config_file
_promote_staging_config_impl = promote_staging_config
_delete_staging_config_impl = delete_staging_config
_move_config_to_source_group_impl = move_config_to_source_group
_summarize_config_file_impl = summarize_config_file
_discover_config_files_impl = discover_config_files
_delete_managed_config_impl = delete_managed_config
_set_config_locked_impl = set_config_locked
_set_config_note_impl = set_config_note
_write_config_json_content_impl = write_config_json_content


class SourceCatalog:
    """Catalog of external data-source config files under config/sources."""

    def config_root(self) -> Path:
        return _config_root_impl()

    def normalize_group(self, value: str) -> str:
        return _normalize_config_group_impl(value)

    def is_routable_group(self, group: str) -> bool:
        return _is_routable_config_group_impl(group)

    def normalize_source_group(self, value: str) -> str:
        return _normalize_source_group_name_impl(value)

    def is_routable_source_group(self, group: str) -> bool:
        return _is_routable_source_group_name_impl(group)

    def has_builtin_probe(self, group: str) -> bool:
        return _has_builtin_probe_impl(group)

    def manifest_group_for_ref(self, config_ref: str, groups: dict[str, str]) -> str:
        return _manifest_group_for_ref_impl(config_ref, groups)

    def infer_group(self, path: Path, data: dict[str, Any] | None = None) -> str:
        return _infer_config_group_impl(path, data)

    def normalize_ref(self, value: str | Path) -> str:
        return _normalize_config_ref_impl(value)

    def resolve_ref(self, config_ref: str) -> Path:
        return _resolve_config_ref_impl(config_ref)

    def safe_import_name(self, filename: str) -> str:
        return _safe_import_name_impl(filename)

    def unique_source_path(self, filename: str, group: str) -> Path:
        return _unique_source_config_path_impl(filename, group)

    def target_source_path(self, filename: str, group: str) -> Path:
        return _target_source_config_path_impl(filename, group)

    def unique_managed_path(self, filename: str, group: str) -> Path:
        return _unique_managed_config_path_impl(filename, group)

    def unique_staging_path(self, filename: str) -> Path:
        return _unique_staging_config_path_impl(filename)

    def read_json(self, path: Path) -> tuple[dict[str, Any] | None, str | None]:
        return _read_config_json_impl(path)

    def staging_paths(self) -> list[Path]:
        return _staging_config_paths_impl()

    def resolve_staging_ref(self, staging_ref: str) -> Path:
        return _resolve_staging_config_ref_impl(staging_ref)

    def source_group_options(self, *suggested_groups: str) -> list[str]:
        return _source_group_options_impl(*suggested_groups)

    def source_group_cards(self) -> list[dict[str, Any]]:
        return _source_group_cards_impl()

    def create_source_group(self, group: str) -> dict[str, Any]:
        return _create_source_group_impl(group)

    def update_source_group(self, group: str, patch: dict[str, Any]) -> dict[str, Any]:
        return _update_source_group_card_impl(group, patch)

    def summarize_staging(self, path: Path) -> dict[str, Any]:
        return _summarize_staging_config_file_impl(path)

    def staging_machine(self) -> dict[str, Any]:
        return _staging_config_machine_impl()

    def stage_file(self, filename: str, raw: bytes) -> dict[str, Any]:
        return _stage_config_file_impl(filename, raw)

    def promote_staging(self, staging_ref: str, group: str) -> dict[str, Any]:
        return _promote_staging_config_impl(staging_ref, group)

    def delete_staging(self, staging_ref: str) -> dict[str, Any]:
        return _delete_staging_config_impl(staging_ref)

    def move_to_source_group(self, config_ref: str, group: str) -> dict[str, Any]:
        return _move_config_to_source_group_impl(config_ref, group)

    def summarize(
        self,
        path: Path,
        active_refs: set[str],
        locked_refs: set[str] | None = None,
        runtime_refs: set[str] | None = None,
    ) -> dict[str, Any]:
        return _summarize_config_file_impl(path, active_refs, locked_refs, runtime_refs)

    def discover(self) -> list[Path]:
        return _discover_config_files_impl()

    def delete_managed(self, config_ref: str) -> dict[str, Any]:
        return _delete_managed_config_impl(config_ref)

    def set_locked(self, config_ref: str, locked: bool) -> dict[str, Any]:
        return _set_config_locked_impl(config_ref, locked)

    def set_note(self, config_ref: str, note: str) -> dict[str, Any]:
        return _set_config_note_impl(config_ref, note)

    def write_json_content(self, config_ref: str, content: str) -> dict[str, Any]:
        return _write_config_json_content_impl(config_ref, content)


DEFAULT_SOURCE_CATALOG = SourceCatalog()


def config_root() -> Path:
    return DEFAULT_SOURCE_CATALOG.config_root()


def normalize_config_group(value: str) -> str:
    return DEFAULT_SOURCE_CATALOG.normalize_group(value)


def is_routable_config_group(group: str) -> bool:
    return DEFAULT_SOURCE_CATALOG.is_routable_group(group)


def normalize_source_group_name(value: str) -> str:
    return DEFAULT_SOURCE_CATALOG.normalize_source_group(value)


def is_routable_source_group_name(group: str) -> bool:
    return DEFAULT_SOURCE_CATALOG.is_routable_source_group(group)


def has_builtin_probe(group: str) -> bool:
    return DEFAULT_SOURCE_CATALOG.has_builtin_probe(group)


def _manifest_group_for_ref(config_ref: str, groups: dict[str, str]) -> str:
    return DEFAULT_SOURCE_CATALOG.manifest_group_for_ref(config_ref, groups)


def infer_config_group(path: Path, data: dict[str, Any] | None = None) -> str:
    return DEFAULT_SOURCE_CATALOG.infer_group(path, data)


def normalize_config_ref(value: str | Path) -> str:
    return DEFAULT_SOURCE_CATALOG.normalize_ref(value)


def resolve_config_ref(config_ref: str) -> Path:
    return DEFAULT_SOURCE_CATALOG.resolve_ref(config_ref)


def safe_import_name(filename: str) -> str:
    return DEFAULT_SOURCE_CATALOG.safe_import_name(filename)


def unique_source_config_path(filename: str, group: str) -> Path:
    return DEFAULT_SOURCE_CATALOG.unique_source_path(filename, group)


def target_source_config_path(filename: str, group: str) -> Path:
    return DEFAULT_SOURCE_CATALOG.target_source_path(filename, group)


def unique_managed_config_path(filename: str, group: str) -> Path:
    return DEFAULT_SOURCE_CATALOG.unique_managed_path(filename, group)


def unique_staging_config_path(filename: str) -> Path:
    return DEFAULT_SOURCE_CATALOG.unique_staging_path(filename)


def read_config_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    return DEFAULT_SOURCE_CATALOG.read_json(path)


def staging_config_paths() -> list[Path]:
    return DEFAULT_SOURCE_CATALOG.staging_paths()


def resolve_staging_config_ref(staging_ref: str) -> Path:
    return DEFAULT_SOURCE_CATALOG.resolve_staging_ref(staging_ref)


def source_group_options(*suggested_groups: str) -> list[str]:
    return DEFAULT_SOURCE_CATALOG.source_group_options(*suggested_groups)


def source_group_cards() -> list[dict[str, Any]]:
    return DEFAULT_SOURCE_CATALOG.source_group_cards()


def create_source_group(group: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.create_source_group(group)


def update_source_group_card(group: str, patch: dict[str, Any]) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.update_source_group(group, patch)


def summarize_staging_config_file(path: Path) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.summarize_staging(path)


def staging_config_machine() -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.staging_machine()


def stage_config_file(filename: str, raw: bytes) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.stage_file(filename, raw)


def promote_staging_config(staging_ref: str, group: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.promote_staging(staging_ref, group)


def delete_staging_config(staging_ref: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.delete_staging(staging_ref)


def move_config_to_source_group(config_ref: str, group: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.move_to_source_group(config_ref, group)


def summarize_config_file(
    path: Path,
    active_refs: set[str],
    locked_refs: set[str] | None = None,
    runtime_refs: set[str] | None = None,
) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.summarize(path, active_refs, locked_refs, runtime_refs)


def discover_config_files() -> list[Path]:
    return DEFAULT_SOURCE_CATALOG.discover()


def delete_managed_config(config_ref: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.delete_managed(config_ref)


def set_config_locked(config_ref: str, locked: bool) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.set_locked(config_ref, locked)


def set_config_note(config_ref: str, note: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.set_note(config_ref, note)


def write_config_json_content(config_ref: str, content: str) -> dict[str, Any]:
    return DEFAULT_SOURCE_CATALOG.write_json_content(config_ref, content)
