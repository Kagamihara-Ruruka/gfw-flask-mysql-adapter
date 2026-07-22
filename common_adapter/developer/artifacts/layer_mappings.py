from __future__ import annotations

import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from common_adapter.config.paths import layer_mappings_path as canonical_layer_mappings_path
from common_adapter.config.atomic_json import atomic_write_json, read_json_object
from common_adapter.developer.sources.configs import normalize_config_ref
from common_adapter.developer.state.manifest import (
    DATA_LAYER_ID_PATTERN,
    load_router_manifest,
)
from common_adapter.spatial.overlay import validate_identifier

MAPPING_LABEL_MAX_LENGTH = 120
SAMPLED_GRID_CONTRACT = "rrkal.sampled_grid.v1"


class LayerMappingStore:
    """Internal mapping contract artifacts produced by the Mapping Controller."""

    def __init__(self, path_provider: Callable[[], Path] = canonical_layer_mappings_path) -> None:
        self._path_provider = path_provider

    def path(self) -> Path:
        return self._path_provider()

    def load(self) -> dict[str, Any]:
        path = self.path()
        if not path.exists():
            return {"mappings": []}
        data = read_json_object(path, missing={"mappings": []})
        mappings = data.get("mappings")
        if not isinstance(mappings, list):
            mappings = []
        normalized: list[dict[str, Any]] = []
        for item in mappings:
            if not isinstance(item, dict):
                continue
            try:
                normalized.append(self.normalize(item))
            except ValueError:
                continue
        return {"mappings": normalized}

    def save(self, packet: dict[str, Any]) -> None:
        mappings = []
        for item in packet.get("mappings") or []:
            if isinstance(item, dict):
                mappings.append(self.normalize(item))
        path = self.path()
        atomic_write_json(
            path,
            {"mappings": sorted(mappings, key=lambda row: row["mapping_id"])},
        )

    def clean_column_list(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        cleaned: list[str] = []
        for item in value:
            text = str(item or "").strip()
            if text and text not in cleaned:
                validate_identifier(text, "mapping column")
                cleaned.append(text)
        return cleaned

    def mapping_id(self, config_ref: str, connection_ref: str, table: str, layer_id: str) -> str:
        config_parts = Path(config_ref).parts
        if len(config_parts) >= 4 and config_parts[0] == "config" and config_parts[1] == "sources":
            config_part = f"{config_parts[2]}.{Path(config_ref).stem}"
        else:
            config_part = Path(config_ref).stem
        safe_parts = [
            re.sub(r"[^A-Za-z0-9_.-]+", "_", config_part),
            re.sub(r"[^A-Za-z0-9_.-]+", "_", connection_ref),
            re.sub(r"[^A-Za-z0-9_.-]+", "_", table),
            re.sub(r"[^A-Za-z0-9_.-]+", "_", layer_id),
        ]
        return "__".join(part.strip("._") or "route" for part in safe_parts)

    def normalize(self, value: dict[str, Any]) -> dict[str, Any]:
        config_ref = normalize_config_ref(str(value.get("config_path") or value.get("config_ref") or ""))
        connection_ref = str(value.get("connection_ref") or "").strip()
        table = str(value.get("table") or value.get("table_ref") or "").strip()
        database = str(value.get("database") or "").strip()
        layer_id = str(value.get("layer_id") or "").strip().lower()
        dataset_id = str(value.get("dataset_id") or "").strip().lower()
        label = str(value.get("label") or layer_id or table).strip()
        sampled_grid = value.get("sampled_grid") if isinstance(value.get("sampled_grid"), dict) else None
        target_contract = str(value.get("target_contract") or "").strip()
        is_sampled_grid_catalog = bool(sampled_grid and isinstance(sampled_grid.get("catalog"), dict))
        if not connection_ref:
            raise ValueError("mapping connection_ref is required")
        validate_identifier(connection_ref, "mapping connection_ref")
        if table:
            validate_identifier(table, "mapping table")
        elif not is_sampled_grid_catalog:
            raise ValueError("mapping table is required")
        if database:
            validate_identifier(database, "mapping database")
        if not DATA_LAYER_ID_PATTERN.match(layer_id):
            raise ValueError("mapping layer_id is invalid")
        if dataset_id and not DATA_LAYER_ID_PATTERN.match(dataset_id):
            raise ValueError("mapping dataset_id is invalid")
        roles = value.get("roles") if isinstance(value.get("roles"), dict) else {}
        normalized_roles: dict[str, str] = {}
        for role in (
            "time",
            "lat",
            "lon",
            "id",
            "value",
            "resolution",
            "coverage",
            "status",
            "row",
            "column",
            "west",
            "south",
            "east",
            "north",
        ):
            column = str(roles.get(role) or value.get(f"{role}_column") or "").strip()
            if column:
                validate_identifier(column, f"mapping {role}_column")
                normalized_roles[role] = column
        selected_columns = self.clean_column_list(value.get("selected_columns"))
        display_columns = self.clean_column_list(value.get("display_columns"))
        metric_columns = self.clean_column_list(value.get("metric_columns"))
        category_columns = self.clean_column_list(value.get("category_columns"))
        for column in normalized_roles.values():
            if column not in selected_columns:
                selected_columns.append(column)
        for column in [*display_columns, *metric_columns, *category_columns]:
            if column not in selected_columns:
                selected_columns.append(column)
        normalized = {
            "mapping_id": str(value.get("mapping_id") or self.mapping_id(config_ref, connection_ref, table, layer_id)),
            "enabled": bool(value.get("enabled", True)),
            "config_path": config_ref,
            "connection_ref": connection_ref,
            "backend": str(value.get("backend") or "mysql").strip().lower(),
            "database": database,
            "table": table,
            "dataset_id": dataset_id or layer_id,
            "layer_id": layer_id,
            "label": label[:MAPPING_LABEL_MAX_LENGTH],
            "roles": normalized_roles,
            "selected_columns": selected_columns,
            "display_columns": display_columns,
            "metric_columns": metric_columns,
            "category_columns": category_columns,
        }
        if target_contract:
            normalized["target_contract"] = target_contract
        elif sampled_grid:
            normalized["target_contract"] = SAMPLED_GRID_CONTRACT
        if sampled_grid:
            normalized["sampled_grid"] = deepcopy(sampled_grid)
        source_ref = str(value.get("source_ref") or "").strip()
        if source_ref:
            normalized["source_ref"] = source_ref
        return normalized

    def upsert(self, mapping: dict[str, Any]) -> dict[str, Any]:
        normalized = self.normalize(mapping)
        packet = self.load()
        rows = [row for row in packet["mappings"] if row["mapping_id"] != normalized["mapping_id"]]
        rows.append(normalized)
        self.save({"mappings": rows})
        return {"status": "ok", "mapping": normalized, "mappings": self.load()["mappings"], "manifest": load_router_manifest()}

    def set_enabled(self, mapping_id: str, enabled: bool) -> dict[str, Any]:
        packet = self.load()
        changed = False
        for row in packet["mappings"]:
            if row["mapping_id"] == mapping_id:
                row["enabled"] = bool(enabled)
                changed = True
                break
        if not changed:
            raise ValueError("unknown mapping_id")
        self.save(packet)
        return {"status": "ok", "mappings": self.load()["mappings"]}

    def migrate_config_ref(self, old_config_ref: str, new_config_ref: str) -> dict[str, Any]:
        old_ref = normalize_config_ref(old_config_ref)
        new_ref = normalize_config_ref(new_config_ref)
        packet = self.load()
        changed = 0
        for row in packet["mappings"]:
            if row.get("config_path") != old_ref:
                continue
            row["config_path"] = new_ref
            changed += 1
        if changed:
            self.save(packet)
        return {
            "status": "ok",
            "old_config_path": old_ref,
            "new_config_path": new_ref,
            "updated_mappings": changed,
        }


DEFAULT_LAYER_MAPPING_STORE = LayerMappingStore()


def layer_mappings_path() -> Path:
    return DEFAULT_LAYER_MAPPING_STORE.path()


def load_layer_mappings() -> dict[str, Any]:
    return DEFAULT_LAYER_MAPPING_STORE.load()


def save_layer_mappings(packet: dict[str, Any]) -> None:
    DEFAULT_LAYER_MAPPING_STORE.save(packet)


def _clean_column_list(value: Any) -> list[str]:
    return DEFAULT_LAYER_MAPPING_STORE.clean_column_list(value)


def _mapping_id(config_ref: str, connection_ref: str, table: str, layer_id: str) -> str:
    return DEFAULT_LAYER_MAPPING_STORE.mapping_id(config_ref, connection_ref, table, layer_id)


def normalize_layer_mapping(value: dict[str, Any]) -> dict[str, Any]:
    return DEFAULT_LAYER_MAPPING_STORE.normalize(value)


def upsert_layer_mapping(mapping: dict[str, Any]) -> dict[str, Any]:
    return DEFAULT_LAYER_MAPPING_STORE.upsert(mapping)


def set_layer_mapping_enabled(mapping_id: str, enabled: bool) -> dict[str, Any]:
    return DEFAULT_LAYER_MAPPING_STORE.set_enabled(mapping_id, enabled)


def migrate_layer_mapping_config_ref(old_config_ref: str, new_config_ref: str) -> dict[str, Any]:
    return DEFAULT_LAYER_MAPPING_STORE.migrate_config_ref(old_config_ref, new_config_ref)
