from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from common_adapter.config.paths import (
    DATABASE_SOURCE_REF,
    LAYER_MAPPINGS_REF,
    ROUTER_MANIFEST_REF,
    SPATIAL_EEZ_SOURCE_REF,
    WEBSOCKET_AIS_SOURCE_REF,
    canonical_config_ref,
    layer_mappings_path,
    resolve_repo_path,
    router_manifest_path,
)

ROOT = Path(__file__).resolve().parents[2]

DATABASE_FRAGMENT = DATABASE_SOURCE_REF
SPATIAL_EEZ_FRAGMENT = SPATIAL_EEZ_SOURCE_REF
WEBSOCKET_AIS_FRAGMENT = WEBSOCKET_AIS_SOURCE_REF


def _resolve(value: str | Path) -> Path:
    return resolve_repo_path(canonical_config_ref(value))


def _read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"config root must be an object: {path}")
    return data


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _fragment_path(ref: str) -> Path:
    return _resolve(ref)


def _load_manifest() -> dict[str, Any]:
    path = router_manifest_path()
    if not path.exists():
        return {"active_configs": [], "locked_configs": [], "config_notes": {}, "config_groups": {}, "imported_layers": ["ais", "eez", "gfw"]}
    return _read_json(path)


def _save_manifest(manifest: dict[str, Any]) -> None:
    active = sorted({str(item) for item in manifest.get("active_configs") or [] if str(item).strip()})
    locked = sorted({str(item) for item in manifest.get("locked_configs") or [] if str(item).strip()})
    notes = manifest.get("config_notes") if isinstance(manifest.get("config_notes"), dict) else {}
    groups = manifest.get("config_groups") if isinstance(manifest.get("config_groups"), dict) else {}
    imported_layers = manifest.get("imported_layers")
    if not isinstance(imported_layers, list):
        imported_layers = ["ais", "eez", "gfw"]
    _write_json(
        router_manifest_path(),
        {
            "active_configs": active,
            "locked_configs": locked,
            "config_notes": {str(key): str(value) for key, value in notes.items()},
            "config_groups": {str(key): str(value) for key, value in groups.items()},
            "imported_layers": sorted({str(item) for item in imported_layers}),
        },
    )


def _safe_mapping_part(value: str, fallback: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "")).strip("._")
    return text or fallback


def _config_mapping_part(config_ref: str) -> str:
    parts = Path(config_ref).parts
    if len(parts) >= 4 and parts[0] == "config" and parts[1] == "sources":
        return f"{parts[2]}.{Path(config_ref).stem}"
    return Path(config_ref).stem


def _mapping_id(config_ref: str, connection_ref: str, table: str, layer_id: str) -> str:
    return "__".join(
        [
            _safe_mapping_part(_config_mapping_part(config_ref), "route"),
            _safe_mapping_part(connection_ref, "connection"),
            _safe_mapping_part(table, "table"),
            _safe_mapping_part(layer_id, "layer"),
        ]
    )


def _dataset_layer_id(dataset_id: str, dataset: dict[str, Any]) -> str:
    configured = str(dataset.get("data_layer") or dataset.get("layer_id") or "").strip().lower()
    if configured:
        return configured
    return dataset_id.strip().lower()


def _append_columns(target: list[str], columns: Any) -> None:
    if not isinstance(columns, list):
        return
    for column in columns:
        text = str(column or "").strip()
        if text and text not in target:
            target.append(text)


def _load_layer_mappings() -> dict[str, Any]:
    path = layer_mappings_path()
    if not path.exists():
        return {"mappings": []}
    try:
        data = _read_json(path)
    except Exception:
        return {"mappings": []}
    mappings = data.get("mappings")
    return {"mappings": mappings if isinstance(mappings, list) else []}


def _save_layer_mappings(packet: dict[str, Any]) -> None:
    rows = [row for row in packet.get("mappings") or [] if isinstance(row, dict)]
    _write_json(layer_mappings_path(), {"mappings": sorted(rows, key=lambda row: str(row.get("mapping_id") or ""))})


def _mapping_from_dataset(config_ref: str, route_config: dict[str, Any], dataset_id: str, dataset: dict[str, Any]) -> dict[str, Any] | None:
    table = str(dataset.get("table") or dataset.get("mysql_table") or "").strip()
    if not table:
        return None
    connection_ref = str(dataset.get("connection_ref") or route_config.get("default_connection_ref") or "local_mysql").strip()
    connections = route_config.get("connections") if isinstance(route_config.get("connections"), dict) else {}
    connection = connections.get(connection_ref) if isinstance(connections.get(connection_ref), dict) else {}
    database = str(dataset.get("database") or connection.get("database") or route_config.get("mysql", {}).get("database") or "").strip()
    layer_id = _dataset_layer_id(dataset_id, dataset)
    roles = {
        key: str(dataset.get(f"{key}_column") or "").strip()
        for key in ("time", "lat", "lon", "id")
        if str(dataset.get(f"{key}_column") or "").strip()
    }
    selected_columns: list[str] = []
    _append_columns(selected_columns, dataset.get("display_columns"))
    _append_columns(selected_columns, dataset.get("metric_columns"))
    _append_columns(selected_columns, dataset.get("category_columns"))
    for column in roles.values():
        if column not in selected_columns:
            selected_columns.append(column)
    return {
        "mapping_id": _mapping_id(config_ref, connection_ref, table, layer_id),
        "enabled": True,
        "source": "route_dataset_migration",
        "config_path": config_ref,
        "connection_ref": connection_ref,
        "backend": str(dataset.get("backend") or route_config.get("sql_backend", {}).get("kind") or "mysql").strip().lower(),
        "database": database,
        "table": table,
        "dataset_id": dataset_id.strip().lower(),
        "layer_id": layer_id,
        "label": str(dataset.get("label") or dataset_id),
        "roles": roles,
        "selected_columns": selected_columns,
        "display_columns": list(dataset.get("display_columns") or []),
        "metric_columns": list(dataset.get("metric_columns") or []),
        "category_columns": list(dataset.get("category_columns") or []),
    }


def _ensure_layer_mappings_from_database_fragment() -> list[str]:
    path = _fragment_path(DATABASE_FRAGMENT)
    if not path.exists():
        return []
    route_config = _read_json(path)
    datasets = route_config.get("datasets")
    if not isinstance(datasets, dict) or not datasets:
        return []
    packet = _load_layer_mappings()
    mappings = [row for row in packet["mappings"] if isinstance(row, dict)]
    existing_ids = {str(row.get("mapping_id") or "") for row in mappings}
    written: list[str] = []
    for dataset_id, dataset in datasets.items():
        if not isinstance(dataset, dict):
            continue
        mapping = _mapping_from_dataset(DATABASE_FRAGMENT, route_config, str(dataset_id), dataset)
        if not mapping:
            continue
        mapping_id = str(mapping["mapping_id"])
        if mapping_id in existing_ids:
            continue
        mappings.append(mapping)
        existing_ids.add(mapping_id)
        written.append(mapping_id)
    if written:
        _save_layer_mappings({"mappings": mappings})
    return written


def _has_database_payload(profile: dict[str, Any]) -> bool:
    return any(key in profile for key in ("sql_backend", "mysql", "default_connection_ref", "connections", "datasets"))


def _has_spatial_payload(profile: dict[str, Any]) -> bool:
    overlays = profile.get("overlays")
    return isinstance(overlays, dict) and isinstance(overlays.get("eez"), dict)


def _has_websocket_payload(profile: dict[str, Any]) -> bool:
    live = profile.get("live")
    return isinstance(live, dict) and isinstance(live.get("ais"), dict)


def _database_fragment(profile: dict[str, Any]) -> dict[str, Any]:
    keys = ("sql_backend", "mysql", "default_connection_ref", "connections", "datasets")
    payload = {key: copy.deepcopy(profile[key]) for key in keys if key in profile}
    return {
        "schema": "rrkal.adapter.database.v1",
        "role": "database",
        "description": "Local database source route fragment generated from the active adapter config.",
        **payload,
    }


def _spatial_fragment(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": "rrkal.adapter.spatial.v1",
        "role": "spatial",
        "description": "Local spatial source route fragment generated from the active adapter config.",
        "overlays": {"eez": copy.deepcopy(profile.get("overlays", {}).get("eez", {}))},
    }


def _websocket_fragment(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": "rrkal.adapter.websocket.v1",
        "role": "websocket",
        "description": "Local websocket source route fragment generated from the active adapter config.",
        "live": {"ais": copy.deepcopy(profile.get("live", {}).get("ais", {}))},
    }


def _write_fragment_if_missing(ref: str, payload: dict[str, Any]) -> bool:
    path = _fragment_path(ref)
    if path.exists():
        return False
    _write_json(path, payload)
    return True


def materialize_route_fragments(profile_path: str | Path) -> dict[str, Any]:
    path = _resolve(profile_path)
    if not path.exists() or path.name.endswith(".example.json"):
        return {"changed": False, "profile": str(path), "fragments": []}

    profile = _read_json(path)
    role = str(profile.get("role") or "").lower()
    if profile.get("schema") and role not in {"profile", "runtime_json", "runtime"}:
        return {"changed": False, "profile": str(path), "fragments": []}

    fragments: list[tuple[str, str, dict[str, Any]]] = []
    if _has_database_payload(profile):
        fragments.append(("database", DATABASE_FRAGMENT, _database_fragment(profile)))
    if _has_spatial_payload(profile):
        fragments.append(("spatial", SPATIAL_EEZ_FRAGMENT, _spatial_fragment(profile)))
    if _has_websocket_payload(profile):
        fragments.append(("websocket", WEBSOCKET_AIS_FRAGMENT, _websocket_fragment(profile)))

    if not fragments:
        written_mappings = _ensure_layer_mappings_from_database_fragment()
        return {
            "changed": bool(written_mappings),
            "profile": str(path),
            "fragments": [],
            "mappings": written_mappings,
        }

    written: list[str] = []
    for _group, ref, payload in fragments:
        if _write_fragment_if_missing(ref, payload):
            written.append(ref)

    manifest = _load_manifest()
    active = {str(item) for item in manifest.get("active_configs") or []}
    groups = dict(manifest.get("config_groups") or {})
    notes = dict(manifest.get("config_notes") or {})
    for group, ref, _payload in fragments:
        active.add(ref)
        groups[ref] = group
        notes.setdefault(ref, f"Generated {group} source route from active adapter config.")
    manifest["active_configs"] = sorted(active)
    manifest["config_groups"] = groups
    manifest["config_notes"] = notes
    _save_manifest(manifest)

    profile_changed = False
    for key in ("sql_backend", "mysql", "default_connection_ref", "connections", "datasets", "overlays", "live"):
        if key in profile:
            profile.pop(key, None)
            profile_changed = True
    if str(profile.get("schema") or "").lower() == "rrkal.adapter.profile.v1":
        profile["schema"] = "rrkal.adapter.runtime_json.v1"
        profile_changed = True
    profile.setdefault("schema", "rrkal.adapter.runtime_json.v1")
    if str(profile.get("role") or "").lower() == "profile":
        profile["role"] = "runtime_json"
        profile_changed = True
    profile.setdefault("role", "runtime_json")
    profile.setdefault(
        "description",
        f"Local runtime JSON. Route fragments are selected by {ROUTER_MANIFEST_REF}.",
    )
    if profile_changed:
        _write_json(path, profile)

    written_mappings = _ensure_layer_mappings_from_database_fragment()

    return {
        "changed": bool(written or profile_changed or written_mappings),
        "profile": str(path),
        "fragments": [ref for _group, ref, _payload in fragments],
        "written": written,
        "mappings": written_mappings,
    }
