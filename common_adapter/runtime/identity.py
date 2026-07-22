from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

from common_adapter.config.atomic_json import read_json_object
from common_adapter.config.paths import ROOT, canonical_config_path


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _sha256_bytes(payload.encode("utf-8"))


def _file_hash(path: Path) -> str:
    return _sha256_bytes(path.read_bytes()) if path.exists() else "missing"


def _load_sources(manifest: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    documents: dict[str, dict[str, Any]] = {}
    hashes: dict[str, str] = {}
    for raw_ref in manifest.get("active_configs") or []:
        ref = str(raw_ref).strip().replace("\\", "/")
        if not ref:
            continue
        path = canonical_config_path(ref)
        documents[ref] = read_json_object(path)
        hashes[ref] = _file_hash(path)
    return documents, hashes


def _primary_source(
    manifest: dict[str, Any],
    mappings: dict[str, Any],
    sources: dict[str, dict[str, Any]],
) -> tuple[str | None, dict[str, Any], dict[str, Any]]:
    imported = {str(value).strip().lower() for value in manifest.get("imported_layers") or []}
    scores: dict[str, int] = {}
    first_mapping: dict[str, dict[str, Any]] = {}
    for mapping in mappings.get("mappings") or []:
        if not isinstance(mapping, dict) or not mapping.get("enabled", True):
            continue
        ref = str(mapping.get("config_path") or "").strip().replace("\\", "/")
        if ref not in sources:
            continue
        layer_id = str(mapping.get("layer_id") or "").strip().lower()
        score = sum(1 for layer in imported if layer == layer_id or layer.startswith(f"{layer_id}."))
        scores[ref] = scores.get(ref, 0) + max(1, score)
        first_mapping.setdefault(ref, mapping)
    database_refs = [
        ref for ref, document in sources.items()
        if str(document.get("role") or "").strip().lower() == "database"
    ]
    candidates = [ref for ref in scores if ref in database_refs] or database_refs
    if not candidates:
        return None, {}, {}
    ref = min(candidates, key=lambda item: (-scores.get(item, 0), item))
    return ref, sources[ref], first_mapping.get(ref, {})


def _query_identity(source: dict[str, Any], mapping: dict[str, Any]) -> tuple[str, str | None]:
    adapter = source.get("adapter") if isinstance(source.get("adapter"), dict) else {}
    adapter_kind = str(adapter.get("kind") or "").strip().lower()
    if adapter_kind in {"http", "http_endpoint", "rest"}:
        backend = "sampled_grid_http"
    else:
        sql_backend = source.get("sql_backend") if isinstance(source.get("sql_backend"), dict) else {}
        declared_backend = source.get("backend") if isinstance(source.get("backend"), dict) else {}
        backend = str(sql_backend.get("kind") or declared_backend.get("kind") or "unknown").strip().lower()
    connection_ref = str(mapping.get("connection_ref") or "").strip() or None
    if connection_ref is None:
        connections = source.get("connections") if isinstance(source.get("connections"), dict) else {}
        connection_ref = next(iter(sorted(connections)), None)
    if connection_ref is None and adapter_kind:
        connection_ref = str(source.get("name") or source.get("id") or "").strip() or None
    return backend, connection_ref


@dataclass(frozen=True)
class RuntimeConfigSnapshot:
    config: dict[str, Any] = field(repr=False, compare=False)
    identity: Mapping[str, Any]

    def public_identity(self) -> dict[str, Any]:
        return deepcopy(dict(self.identity))


def capture_runtime_config_snapshot(
    config: dict[str, Any],
    *,
    http_port: int,
    developer_port: int | None,
) -> RuntimeConfigSnapshot:
    frozen_config = deepcopy(config)
    config_path = canonical_config_path(str(frozen_config.get("__config_path") or "config/runtime/adapter.local.json"))
    manifest_path = canonical_config_path(
        str(frozen_config.get("__router_manifest_path") or "config/state/router_manifest.local.json")
    )
    mapping_path = canonical_config_path(
        str(frozen_config.get("__layer_mappings_path") or "config/artifacts/layer_mappings.local.json")
    )
    manifest = read_json_object(manifest_path)
    mappings = read_json_object(mapping_path, missing={"mappings": []})
    source_documents, source_hashes = _load_sources(manifest)
    source_ref, source, primary_mapping = _primary_source(manifest, mappings, source_documents)
    query_backend, connection_ref = _query_identity(source, primary_mapping)

    generation_text = os.environ.get("BDDE38_RUNTIME_GENERATION") or ""
    try:
        generation = int(generation_text)
    except ValueError:
        generation = int(time.time_ns() // 1_000_000)
    public_http_port = int(os.environ.get("BDDE38_PUBLIC_HTTP_PORT") or http_port)
    public_developer_port = int(
        os.environ.get("BDDE38_PUBLIC_DEVELOPER_PORT")
        or developer_port
        or (public_http_port + 1)
    )
    profile = str(frozen_config.get("__runtime_profile") or "LOCAL").strip().upper()
    managed_by = str(frozen_config.get("__managed_by") or "core.py").strip()
    evidence = {
        "image_digest": os.environ.get("BDDE38_IMAGE_DIGEST") or "unmanaged",
        "compose_hash": os.environ.get("BDDE38_COMPOSE_HASH") or "unmanaged",
        "bridge_owner_token": os.environ.get("BDDE38_BRIDGE_OWNER_TOKEN") or "unmanaged",
        "deployment_profile_hash": (
            os.environ.get("BDDE38_DEPLOYMENT_PROFILE_HASH") or "unmanaged"
        ),
        "deployment_environment": (
            os.environ.get("BDDE38_DEPLOYMENT_ENVIRONMENT") or "unmanaged"
        ),
        "deployment_target": (
            os.environ.get("BDDE38_DEPLOYMENT_TARGET") or "unmanaged"
        ),
    }
    config_bundle = {
        "effective_config_hash": _file_hash(config_path),
        "manifest_hash": _file_hash(manifest_path),
        "mapping_hash": _file_hash(mapping_path),
        "source_hashes": source_hashes,
        "profile": profile,
        "query_backend": query_backend,
        "connection_ref": connection_ref,
        "source_config_path": source_ref,
    }
    config_bundle_hash = _sha256_json(config_bundle)
    deployment_identity = {
        "config_bundle_hash": config_bundle_hash,
        "generation": generation,
        "http_port": public_http_port,
        "developer_port": public_developer_port,
        **evidence,
    }
    fingerprint = _sha256_json(deployment_identity)
    instance_id = os.environ.get("BDDE38_RUNTIME_INSTANCE_ID") or str(uuid.uuid4())
    identity = {
        "schema": "bdde38.runtime_identity.v1",
        "runtime_instance_id": instance_id,
        "runtime_generation": generation,
        "runtime_fingerprint": fingerprint,
        "effective_config_path": str(config_path),
        "effective_config_hash": config_bundle["effective_config_hash"],
        "manifest_path": str(manifest_path),
        "manifest_hash": config_bundle["manifest_hash"],
        "mapping_path": str(mapping_path),
        "mapping_hash": config_bundle["mapping_hash"],
        "config_bundle_hash": config_bundle_hash,
        "profile": profile,
        "http_port": public_http_port,
        "developer_port": public_developer_port,
        "query_backend": query_backend,
        "connection_ref": connection_ref,
        "source_config_path": source_ref,
        "managed_by": managed_by,
        "deployment_profile_path": (
            os.environ.get("BDDE38_DEPLOYMENT_PROFILE") or "unmanaged"
        ),
        **evidence,
    }
    frozen_config["__runtime_manifest_snapshot"] = manifest
    frozen_config["__runtime_mapping_snapshot"] = mappings
    frozen_config["__runtime_source_snapshots"] = source_documents
    frozen_config["__runtime_identity"] = deepcopy(identity)
    return RuntimeConfigSnapshot(
        config=frozen_config,
        identity=MappingProxyType(identity),
    )
