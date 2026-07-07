from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import psycopg

from DatabaseConnect import mysql_connection
from SpatialOverlay import overlay_settings, postgis_dsn, validate_identifier

CONFIG_ROOT = Path("config")
MANAGED_CONFIG_DIR = CONFIG_ROOT / "managed"
ROUTER_MANIFEST_PATH = CONFIG_ROOT / "router_manifest.local.json"
LAYER_MAPPINGS_PATH = CONFIG_ROOT / "layer_mappings.local.json"
CONFIG_NAME_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")
DATA_LAYER_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
CONFIG_GROUPS = {"database", "websocket", "spatial", "demo"}
DATA_LAYER_IDS = {"gfw", "ais", "eez"}
DEFAULT_IMPORTED_LAYERS = ["gfw", "ais", "eez"]


def config_root() -> Path:
    root = CONFIG_ROOT.resolve()
    root.mkdir(parents=True, exist_ok=True)
    MANAGED_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return root


def router_manifest_path() -> Path:
    config_root()
    return ROUTER_MANIFEST_PATH.resolve()


def layer_mappings_path() -> Path:
    config_root()
    return LAYER_MAPPINGS_PATH.resolve()


def load_router_manifest() -> dict[str, Any]:
    path = router_manifest_path()
    if not path.exists():
        return {
            "active_configs": [],
            "locked_configs": [],
            "config_notes": {},
            "config_groups": {},
            "imported_layers": list(DEFAULT_IMPORTED_LAYERS),
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {
            "active_configs": [],
            "locked_configs": [],
            "config_notes": {},
            "config_groups": {},
            "imported_layers": list(DEFAULT_IMPORTED_LAYERS),
        }
    active = data.get("active_configs")
    if not isinstance(active, list):
        active = []
    locked = data.get("locked_configs")
    if not isinstance(locked, list):
        locked = []
    notes = data.get("config_notes")
    if not isinstance(notes, dict):
        notes = {}
    groups = data.get("config_groups")
    if not isinstance(groups, dict):
        groups = {}
    imported_layers = normalize_imported_layers(data.get("imported_layers"))
    if "imported_layers" not in data:
        imported_layers = list(DEFAULT_IMPORTED_LAYERS)
    return {
        "active_configs": [str(item) for item in active],
        "locked_configs": [str(item) for item in locked],
        "config_notes": {str(key): str(value) for key, value in notes.items()},
        "config_groups": {
            str(key): normalize_config_group(str(value))
            for key, value in groups.items()
            if normalize_config_group(str(value))
        },
        "imported_layers": imported_layers,
    }


def save_router_manifest(manifest: dict[str, Any]) -> None:
    path = router_manifest_path()
    active = sorted({normalize_config_ref(item) for item in manifest.get("active_configs", [])})
    locked = sorted({normalize_config_ref(item) for item in manifest.get("locked_configs", [])})
    notes: dict[str, str] = {}
    for key, value in (manifest.get("config_notes") or {}).items():
        ref = normalize_config_ref(key)
        text = str(value).strip()
        if text:
            notes[ref] = text[:500]
    groups: dict[str, str] = {}
    for key, value in (manifest.get("config_groups") or {}).items():
        ref = normalize_config_ref(key)
        group = normalize_config_group(str(value))
        if group:
            groups[ref] = group
    active = sorted(ref for ref in active if groups.get(ref, "database") != "demo")
    if "imported_layers" in manifest:
        imported_layers = normalize_imported_layers(manifest.get("imported_layers"))
    else:
        imported_layers = _existing_imported_layers(path)
    path.write_text(
        json.dumps(
            {
                "active_configs": active,
                "locked_configs": locked,
                "config_notes": notes,
                "config_groups": groups,
                "imported_layers": imported_layers,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def normalize_imported_layers(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    layers = {str(item).strip().lower() for item in value}
    return sorted(layer for layer in layers if DATA_LAYER_ID_PATTERN.match(layer))


def _existing_imported_layers(path: Path) -> list[str]:
    if not path.exists():
        return list(DEFAULT_IMPORTED_LAYERS)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return list(DEFAULT_IMPORTED_LAYERS)
    if "imported_layers" not in data:
        return list(DEFAULT_IMPORTED_LAYERS)
    return normalize_imported_layers(data.get("imported_layers"))


def set_layer_import(layer_id: str, imported: bool) -> dict[str, Any]:
    layer = str(layer_id or "").strip().lower()
    if not DATA_LAYER_ID_PATTERN.match(layer):
        raise ValueError("unknown data layer")
    manifest = load_router_manifest()
    layers = set(normalize_imported_layers(manifest.get("imported_layers")))
    if imported:
        layers.add(layer)
    else:
        layers.discard(layer)
    manifest["imported_layers"] = sorted(layers)
    save_router_manifest(manifest)
    return {"status": "ok", "manifest": load_router_manifest()}


def load_layer_mappings() -> dict[str, Any]:
    path = layer_mappings_path()
    if not path.exists():
        return {"mappings": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"mappings": []}
    mappings = data.get("mappings")
    if not isinstance(mappings, list):
        mappings = []
    normalized: list[dict[str, Any]] = []
    for item in mappings:
        if not isinstance(item, dict):
            continue
        try:
            normalized.append(normalize_layer_mapping(item))
        except ValueError:
            continue
    return {"mappings": normalized}


def save_layer_mappings(packet: dict[str, Any]) -> None:
    mappings = []
    for item in packet.get("mappings") or []:
        if isinstance(item, dict):
            mappings.append(normalize_layer_mapping(item))
    path = layer_mappings_path()
    path.write_text(
        json.dumps({"mappings": sorted(mappings, key=lambda row: row["mapping_id"])}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _clean_column_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text and text not in cleaned:
            validate_identifier(text, "mapping column")
            cleaned.append(text)
    return cleaned


def _mapping_id(config_ref: str, connection_ref: str, table: str, layer_id: str) -> str:
    safe_parts = [
        re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(config_ref).stem),
        re.sub(r"[^A-Za-z0-9_.-]+", "_", connection_ref),
        re.sub(r"[^A-Za-z0-9_.-]+", "_", table),
        re.sub(r"[^A-Za-z0-9_.-]+", "_", layer_id),
    ]
    return "__".join(part.strip("._") or "route" for part in safe_parts)


def normalize_layer_mapping(value: dict[str, Any]) -> dict[str, Any]:
    config_ref = normalize_config_ref(str(value.get("config_path") or value.get("config_ref") or ""))
    connection_ref = str(value.get("connection_ref") or "").strip()
    table = str(value.get("table") or value.get("table_ref") or "").strip()
    database = str(value.get("database") or "").strip()
    layer_id = str(value.get("layer_id") or "").strip().lower()
    label = str(value.get("label") or layer_id or table).strip()
    if not connection_ref:
        raise ValueError("mapping connection_ref is required")
    validate_identifier(connection_ref, "mapping connection_ref")
    validate_identifier(table, "mapping table")
    if database:
        validate_identifier(database, "mapping database")
    if not DATA_LAYER_ID_PATTERN.match(layer_id):
        raise ValueError("mapping layer_id is invalid")
    roles = value.get("roles") if isinstance(value.get("roles"), dict) else {}
    normalized_roles: dict[str, str] = {}
    for role in ("time", "lat", "lon", "id"):
        column = str(roles.get(role) or value.get(f"{role}_column") or "").strip()
        if column:
            validate_identifier(column, f"mapping {role}_column")
            normalized_roles[role] = column
    selected_columns = _clean_column_list(value.get("selected_columns"))
    display_columns = _clean_column_list(value.get("display_columns"))
    metric_columns = _clean_column_list(value.get("metric_columns"))
    category_columns = _clean_column_list(value.get("category_columns"))
    for column in normalized_roles.values():
        if column not in selected_columns:
            selected_columns.append(column)
    for column in [*display_columns, *metric_columns, *category_columns]:
        if column not in selected_columns:
            selected_columns.append(column)
    return {
        "mapping_id": str(value.get("mapping_id") or _mapping_id(config_ref, connection_ref, table, layer_id)),
        "enabled": bool(value.get("enabled", True)),
        "config_path": config_ref,
        "connection_ref": connection_ref,
        "backend": str(value.get("backend") or "mysql").strip().lower(),
        "database": database,
        "table": table,
        "layer_id": layer_id,
        "label": label[:120],
        "roles": normalized_roles,
        "selected_columns": selected_columns,
        "display_columns": display_columns,
        "metric_columns": metric_columns,
        "category_columns": category_columns,
    }


def upsert_layer_mapping(mapping: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_layer_mapping(mapping)
    packet = load_layer_mappings()
    rows = [row for row in packet["mappings"] if row["mapping_id"] != normalized["mapping_id"]]
    rows.append(normalized)
    save_layer_mappings({"mappings": rows})
    manifest = load_router_manifest()
    layers = set(normalize_imported_layers(manifest.get("imported_layers")))
    layers.add(normalized["layer_id"])
    manifest["imported_layers"] = sorted(layers)
    save_router_manifest(manifest)
    return {"status": "ok", "mapping": normalized, "mappings": load_layer_mappings()["mappings"], "manifest": load_router_manifest()}


def set_layer_mapping_enabled(mapping_id: str, enabled: bool) -> dict[str, Any]:
    packet = load_layer_mappings()
    changed = False
    for row in packet["mappings"]:
        if row["mapping_id"] == mapping_id:
            row["enabled"] = bool(enabled)
            changed = True
            break
    if not changed:
        raise ValueError("unknown mapping_id")
    save_layer_mappings(packet)
    return {"status": "ok", "mappings": load_layer_mappings()["mappings"]}


def normalize_config_group(value: str) -> str:
    group = str(value or "").strip().lower()
    if group in {"db", "sql", "mysql", "hive", "database"}:
        return "database"
    if group in {"ws", "websocket", "collector", "ais", "stream"}:
        return "websocket"
    if group in {"spatial", "postgis", "gis", "overlay", "mvt"}:
        return "spatial"
    if group in {"demo", "example", "sample"}:
        return "demo"
    return ""


def infer_config_group(path: Path, data: dict[str, Any] | None = None) -> str:
    name = path.name.lower()
    if name.endswith(".example.json"):
        return "demo"
    if name == "adapter.local.json":
        return "demo"
    if "collector" in name or "ais_" in name or "stream" in name:
        return "websocket"
    if isinstance(data, dict):
        schema = str(data.get("schema") or "").lower()
        role = str(data.get("role") or "").lower()
        if "spatial" in schema or role.startswith("spatial"):
            return "spatial"
        if "websocket" in schema or role.startswith("websocket"):
            return "websocket"
        if "database" in schema or role.startswith("database"):
            return "database"
        if "profile" in schema or role.endswith("profile"):
            return "demo"
        if any(key in data for key in ("provider", "stream_url", "ingest", "collector")) and not data.get("connections"):
            return "websocket"
        if data.get("kind") in {"spatial_postgis", "postgis_overlay"}:
            return "spatial"
        overlays = data.get("overlays")
        if isinstance(overlays, dict) and isinstance(overlays.get("eez"), dict):
            eez = overlays["eez"]
            if eez.get("provider") == "postgis" or eez.get("postgis"):
                return "spatial"
    return "database"


def normalize_config_ref(value: str | Path) -> str:
    root = config_root()
    path = Path(value)
    if not path.is_absolute():
        path = (Path(__file__).resolve().parent / path).resolve()
    else:
        path = path.resolve()
    try:
        rel = path.relative_to(root)
    except ValueError as exc:
        raise ValueError("config path must stay under config/") from exc
    return str((CONFIG_ROOT / rel).as_posix())


def resolve_config_ref(config_ref: str) -> Path:
    root = config_root()
    path = (Path(__file__).resolve().parent / config_ref).resolve()
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


def unique_managed_config_path(filename: str) -> Path:
    directory = MANAGED_CONFIG_DIR.resolve()
    base_name = safe_import_name(filename)
    stem = Path(base_name).stem
    suffix = Path(base_name).suffix
    candidate = directory / base_name
    index = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{index}{suffix}"
        index += 1
    return candidate


def read_config_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        return None, str(exc)
    if not isinstance(data, dict):
        return None, "config root must be a JSON object"
    return data, None


def summarize_config_file(path: Path, active_refs: set[str], locked_refs: set[str] | None = None) -> dict[str, Any]:
    ref = normalize_config_ref(path)
    locked_refs = locked_refs or set()
    manifest = load_router_manifest()
    note = str((manifest.get("config_notes") or {}).get(ref, ""))
    data, error = read_config_json(path)
    group = str((manifest.get("config_groups") or {}).get(ref) or infer_config_group(path, data))
    managed_dir = MANAGED_CONFIG_DIR.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(managed_dir)
        is_managed = True
    except ValueError:
        is_managed = False
    is_example = group == "demo" or path.name.endswith(".example.json")
    is_locked = ref in locked_refs
    summary: dict[str, Any] = {
        "path": ref,
        "name": path.name,
        "active": group != "demo" and ref in active_refs,
        "locked": is_locked,
        "managed": is_managed,
        "example": is_example,
        "group": group,
        "routable": group != "demo",
        "delete_allowed": is_managed and not is_locked,
        "edit_allowed": not is_locked and group != "demo",
        "group_edit_allowed": not is_locked and (is_managed or not is_example),
        "note": note,
        "size_bytes": path.stat().st_size,
        "mtime": path.stat().st_mtime,
        "parse_ok": error is None,
        "error": error,
        "connections": [],
        "datasets": [],
    }
    if data:
        connections = data.get("connections") or {}
        if isinstance(connections, dict) and connections:
            summary["connections"] = sorted(str(key) for key in connections.keys())
        elif "mysql" in data:
            summary["connections"] = ["local_mysql"]
        datasets = data.get("datasets") or {}
        if isinstance(datasets, dict):
            summary["datasets"] = sorted(str(key) for key in datasets.keys())
    return summary


def discover_config_files() -> list[Path]:
    root = config_root()
    excluded_names = {
        "adapter.schema.json",
        "test_data.example.json",
        "router_manifest.local.json",
        "router_manifest.example.json",
        "adapter.local.json",
    }
    files = list(root.glob("*.json")) + list(MANAGED_CONFIG_DIR.glob("*.json"))
    return sorted(
        {path.resolve() for path in files if path.is_file() and path.name not in excluded_names},
        key=lambda item: str(item).lower(),
    )


def delete_managed_config(config_ref: str) -> dict[str, Any]:
    path = resolve_config_ref(config_ref)
    managed_dir = MANAGED_CONFIG_DIR.resolve()
    try:
        path.relative_to(managed_dir)
    except ValueError as exc:
        raise ValueError("only imported configs under config/managed/ can be deleted") from exc
    if not path.exists():
        raise FileNotFoundError("config file not found")
    normalized = normalize_config_ref(path)
    manifest = load_router_manifest()
    if normalized in set(manifest["locked_configs"]):
        raise ValueError("locked config cannot be deleted")
    path.unlink()
    active_refs = {ref for ref in manifest["active_configs"] if ref != normalized}
    locked_refs = {ref for ref in manifest["locked_configs"] if ref != normalized}
    notes = dict(manifest.get("config_notes") or {})
    notes.pop(normalized, None)
    groups = dict(manifest.get("config_groups") or {})
    groups.pop(normalized, None)
    save_router_manifest({"active_configs": sorted(active_refs), "locked_configs": sorted(locked_refs), "config_notes": notes, "config_groups": groups})
    return {"deleted": normalized, "manifest": load_router_manifest()}


def set_config_locked(config_ref: str, locked: bool) -> dict[str, Any]:
    path = resolve_config_ref(config_ref)
    if not path.exists():
        raise FileNotFoundError("config file not found")
    if path.name.endswith(".example.json"):
        raise ValueError("example config is demo-only and cannot be locked")
    normalized = normalize_config_ref(path)
    manifest = load_router_manifest()
    active_refs = set(manifest["active_configs"])
    locked_refs = set(manifest["locked_configs"])
    if locked:
        locked_refs.add(normalized)
    else:
        locked_refs.discard(normalized)
    save_router_manifest(
        {
            "active_configs": sorted(active_refs),
            "locked_configs": sorted(locked_refs),
            "config_notes": dict(manifest.get("config_notes") or {}),
            "config_groups": dict(manifest.get("config_groups") or {}),
        }
    )
    return {"status": "ok", "manifest": load_router_manifest()}


def set_config_note(config_ref: str, note: str) -> dict[str, Any]:
    path = resolve_config_ref(config_ref)
    if not path.exists():
        raise FileNotFoundError("config file not found")
    normalized = normalize_config_ref(path)
    manifest = load_router_manifest()
    notes = dict(manifest.get("config_notes") or {})
    cleaned = str(note or "").strip()
    if cleaned:
        notes[normalized] = cleaned[:500]
    else:
        notes.pop(normalized, None)
    save_router_manifest(
        {
            "active_configs": manifest["active_configs"],
            "locked_configs": manifest["locked_configs"],
            "config_notes": notes,
            "config_groups": dict(manifest.get("config_groups") or {}),
        }
    )
    active_refs = set(load_router_manifest()["active_configs"])
    locked_refs = set(load_router_manifest()["locked_configs"])
    return {"status": "ok", "config": summarize_config_file(path, active_refs, locked_refs)}


def set_config_group(config_ref: str, group: str) -> dict[str, Any]:
    path = resolve_config_ref(config_ref)
    if not path.exists():
        raise FileNotFoundError("config file not found")
    normalized = normalize_config_ref(path)
    selected_group = normalize_config_group(group)
    if not selected_group:
        raise ValueError("config group must be database, websocket, spatial, or demo")
    manifest = load_router_manifest()
    active_refs = set(manifest["active_configs"])
    groups = dict(manifest.get("config_groups") or {})
    groups[normalized] = selected_group
    if selected_group == "demo":
        active_refs.discard(normalized)
    save_router_manifest(
        {
            "active_configs": sorted(active_refs),
            "locked_configs": manifest["locked_configs"],
            "config_notes": dict(manifest.get("config_notes") or {}),
            "config_groups": groups,
        }
    )
    active_refs = set(load_router_manifest()["active_configs"])
    locked_refs = set(load_router_manifest()["locked_configs"])
    return {"status": "ok", "config": summarize_config_file(path, active_refs, locked_refs), "manifest": load_router_manifest()}


def write_config_json_content(config_ref: str, content: str) -> dict[str, Any]:
    path = resolve_config_ref(config_ref)
    if not path.exists():
        raise FileNotFoundError("config file not found")
    if path.name.endswith(".example.json"):
        raise ValueError("example config is demo-only and cannot be edited")
    normalized = normalize_config_ref(path)
    manifest = load_router_manifest()
    if (manifest.get("config_groups") or {}).get(normalized) == "demo":
        raise ValueError("demo config is read-only")
    if normalized in set(manifest["locked_configs"]):
        raise ValueError("locked config cannot be edited")
    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        raise ValueError("config root must be a JSON object")
    path.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    active_refs = set(load_router_manifest()["active_configs"])
    locked_refs = set(load_router_manifest()["locked_configs"])
    return {"status": "ok", "config": summarize_config_file(path, active_refs, locked_refs)}


def connection_status_from_config(config_ref: str, data: dict[str, Any], active: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    connections = data.get("connections")
    if isinstance(connections, dict) and connections:
        connection_items = [(str(ref), conn) for ref, conn in connections.items() if isinstance(conn, dict)]
    elif isinstance(data.get("mysql"), dict):
        connection_items = [("local_mysql", data["mysql"])]
    else:
        connection_items = []

    for connection_ref, connection in connection_items:
        kind = str(connection.get("kind") or data.get("sql_backend", {}).get("kind") or "mysql").lower()
        connected = False
        detail = "尚未測試"
        if kind == "mysql":
            try:
                database = connection.get("database")
                with mysql_connection(data, database, dict_cursor=True, connection=connection) as conn, conn.cursor() as cur:
                    cur.execute("SELECT 1 AS ok")
                    connected = bool(cur.fetchone()["ok"])
                detail = "連線成功" if connected else "連線失敗"
            except Exception as exc:
                detail = str(exc)
        else:
            detail = f"{kind} 連線測試尚未實作"
        rows.append(
            {
                "config_path": config_ref,
                "connection_ref": connection_ref,
                "backend": kind,
                "enabled": active,
                "connected": connected,
                "detail": detail,
            }
        )
    return rows


def _table_exists_and_has_rows(cursor: psycopg.Cursor[Any], table: str) -> tuple[bool, bool]:
    safe_table = validate_identifier(table, "PostGIS table")
    cursor.execute("SELECT to_regclass(%s)", (safe_table,))
    exists = cursor.fetchone()[0] is not None
    if not exists:
        return False, False
    cursor.execute(f"SELECT EXISTS (SELECT 1 FROM {safe_table} LIMIT 1)")
    return True, bool(cursor.fetchone()[0])


def spatial_status_from_config(config_ref: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    settings = overlay_settings(data)
    if settings.get("provider") != "postgis" and not settings.get("postgis"):
        return rows

    pg = settings.get("postgis") or {}
    base_table = str(pg.get("table") or "eez_v12")
    tile_table = str(pg.get("tile_table") or f"{base_table}_tile")
    boundary_table = str(pg.get("boundary_table") or f"{base_table}_boundary")
    expected_tables = [base_table, tile_table, boundary_table]
    enabled = bool(settings.get("enabled", True))
    connected = False
    ready = False
    table_detail = "-"
    detail = "尚未測試"

    if not pg:
        detail = "overlays.eez.postgis 缺失"
    else:
        try:
            for table in expected_tables:
                validate_identifier(table, "PostGIS table")
            with psycopg.connect(postgis_dsn(pg), connect_timeout=5) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT PostGIS_Version()")
                    postgis_version = cur.fetchone()[0]
                    connected = True
                    table_states = []
                    all_ready = True
                    for table in expected_tables:
                        exists, has_rows = _table_exists_and_has_rows(cur, table)
                        if not exists:
                            table_states.append(f"{table}:missing")
                            all_ready = False
                        elif not has_rows:
                            table_states.append(f"{table}:empty")
                            all_ready = False
                        else:
                            table_states.append(f"{table}:ok")
                    ready = all_ready
                    table_detail = ", ".join(table_states)
                    detail = f"PostGIS {postgis_version}"
        except Exception as exc:
            detail = str(exc)

    rows.append(
        {
            "config_path": config_ref,
            "overlay_ref": "eez",
            "backend": "postgis",
            "provider": str(settings.get("provider") or "-"),
            "enabled": enabled,
            "connected": connected,
            "ready": ready,
            "tables": table_detail,
            "detail": detail,
        }
    )
    return rows
