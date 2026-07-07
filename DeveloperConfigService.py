from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from DatabaseConnect import mysql_connection

CONFIG_ROOT = Path("config")
MANAGED_CONFIG_DIR = CONFIG_ROOT / "managed"
ROUTER_MANIFEST_PATH = CONFIG_ROOT / "router_manifest.local.json"
CONFIG_NAME_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")
CONFIG_GROUPS = {"database", "websocket", "demo"}


def config_root() -> Path:
    root = CONFIG_ROOT.resolve()
    root.mkdir(parents=True, exist_ok=True)
    MANAGED_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return root


def router_manifest_path() -> Path:
    config_root()
    return ROUTER_MANIFEST_PATH.resolve()


def load_router_manifest() -> dict[str, Any]:
    path = router_manifest_path()
    if not path.exists():
        return {"active_configs": [], "locked_configs": [], "config_notes": {}, "config_groups": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"active_configs": [], "locked_configs": [], "config_notes": {}, "config_groups": {}}
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
    return {
        "active_configs": [str(item) for item in active],
        "locked_configs": [str(item) for item in locked],
        "config_notes": {str(key): str(value) for key, value in notes.items()},
        "config_groups": {
            str(key): normalize_config_group(str(value))
            for key, value in groups.items()
            if normalize_config_group(str(value))
        },
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
    active = sorted(ref for ref in active if groups.get(ref, "database") == "database")
    path.write_text(
        json.dumps(
            {"active_configs": active, "locked_configs": locked, "config_notes": notes, "config_groups": groups},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def normalize_config_group(value: str) -> str:
    group = str(value or "").strip().lower()
    if group in {"db", "sql", "mysql", "hive", "database"}:
        return "database"
    if group in {"ws", "websocket", "collector", "ais", "stream"}:
        return "websocket"
    if group in {"demo", "example", "sample"}:
        return "demo"
    return ""


def infer_config_group(path: Path, data: dict[str, Any] | None = None) -> str:
    name = path.name.lower()
    if name.endswith(".example.json"):
        return "demo"
    if "collector" in name or "ais_" in name or "stream" in name:
        return "websocket"
    if isinstance(data, dict):
        if any(key in data for key in ("provider", "stream_url", "ingest", "collector")) and not data.get("connections"):
            return "websocket"
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
        "active": group == "database" and ref in active_refs,
        "locked": is_locked,
        "managed": is_managed,
        "example": is_example,
        "group": group,
        "routable": group == "database",
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
        raise ValueError("config group must be database, websocket, or demo")
    manifest = load_router_manifest()
    active_refs = set(manifest["active_configs"])
    groups = dict(manifest.get("config_groups") or {})
    groups[normalized] = selected_group
    if selected_group != "database":
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
