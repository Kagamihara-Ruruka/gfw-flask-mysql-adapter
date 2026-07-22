from __future__ import annotations

import json
from copy import deepcopy
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

from flask import Flask, jsonify, request

from common_adapter.developer.config_service import (
    create_source_group,
    delete_staging_config,
    is_routable_config_group,
    load_layer_mappings,
    normalize_config_ref,
    normalize_imported_layers,
    normalize_layer_mapping,
    read_config_json,
    resolve_config_ref,
    source_group_cards,
    stage_config_file,
    staging_config_machine,
    summarize_config_file,
    update_source_group_card,
)
from common_adapter.developer.schema_inspector import inspect_relational_routes
from common_adapter.endpoint.supervisor import ManagedEndpointSupervisor
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.layers.runtime import (
    active_config_files_by_group,
    active_refs_with_runtime,
    config_paths_with_runtime,
    locked_refs_with_runtime,
    manifest_with_runtime,
    runtime_config_refs,
)
from common_adapter.layers.status import RouteStatusRegistry
from common_adapter.runtime.config_state import RuntimeConfigStateStore


def response_manifest(runtime_config: dict[str, Any] | None) -> dict[str, Any]:
    manifest = manifest_with_runtime(runtime_config)
    runtime_refs = sorted(runtime_config_refs(runtime_config))
    if runtime_refs:
        manifest["runtime_configs"] = runtime_refs
        manifest["locked_configs"] = sorted(set(manifest["locked_configs"]) | set(runtime_refs))
    return manifest


def route_provided_layer_rows(layer_registry: RuntimeLayerRegistry) -> list[dict[str, Any]]:
    return layer_registry.snapshot(force=True)["layers"]


def register_developer_routes(
    app: Flask,
    runtime_config: dict[str, Any] | None = None,
    *,
    layer_registry: RuntimeLayerRegistry,
    route_status_registry: RouteStatusRegistry,
    endpoint_supervisor: ManagedEndpointSupervisor | None = None,
    consumer_probe_url: str | None = None,
) -> None:
    runtime_identity = dict((runtime_config or {}).get("__runtime_identity") or {})
    config_state_store = RuntimeConfigStateStore()
    manifest_ref = str(
        (runtime_config or {}).get("__router_manifest_path")
        or "config/state/router_manifest.local.json"
    )
    mappings_ref = str(
        (runtime_config or {}).get("__layer_mappings_path")
        or "config/artifacts/layer_mappings.local.json"
    )

    def desired_manifest() -> dict[str, Any]:
        return config_state_store.pending_document(manifest_ref) or manifest_with_runtime(runtime_config)

    def desired_mappings() -> dict[str, Any]:
        pending = config_state_store.pending_document(mappings_ref)
        if pending is not None:
            return deepcopy(pending)
        snapshot = (runtime_config or {}).get("__runtime_mapping_snapshot")
        return deepcopy(snapshot) if isinstance(snapshot, dict) else load_layer_mappings()

    def normalize_manifest_document(manifest: dict[str, Any]) -> dict[str, Any]:
        return {
            "active_configs": sorted(
                {normalize_config_ref(item) for item in manifest.get("active_configs") or []}
            ),
            "locked_configs": sorted(
                {normalize_config_ref(item) for item in manifest.get("locked_configs") or []}
            ),
            "config_notes": {
                normalize_config_ref(key): str(value).strip()[:500]
                for key, value in (manifest.get("config_notes") or {}).items()
                if str(value).strip()
            },
            "imported_layers": normalize_imported_layers(manifest.get("imported_layers")),
        }

    def manifest_stage_response(state: dict[str, Any]) -> dict[str, Any]:
        normalized = normalize_manifest_document(state.get("document") or {})
        return {
            **state,
            "manifest": normalized,
            "effective_manifest": response_manifest(runtime_config),
        }

    def mutate_manifest(update) -> dict[str, Any]:
        state = config_state_store.update_json(
            manifest_ref,
            lambda manifest: normalize_manifest_document(update(manifest)),
            effective=manifest_with_runtime(runtime_config),
        )
        return manifest_stage_response(state)

    def mutate_mappings(update) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        effective = (runtime_config or {}).get("__runtime_mapping_snapshot")
        if not isinstance(effective, dict):
            effective = load_layer_mappings()
        state = config_state_store.update_json(
            mappings_ref,
            update,
            effective=effective,
        )
        rows = deepcopy((state.get("document") or {}).get("mappings") or [])
        return state, rows

    def deployment_operation_blocked(operation: str):
        return jsonify(
            {
                "status": "pending_restart_required",
                "error": f"{operation} changes config topology and must be applied by presentationctl",
                "restart_required": True,
                "runtime_identity": runtime_identity,
            }
        ), 409

    def paired_consumer_identity() -> tuple[dict[str, Any] | None, str | None]:
        if not consumer_probe_url:
            return None, "consumer probe URL is not configured"
        try:
            with urlopen(f"{consumer_probe_url.rstrip('/')}/api/runtime/identity", timeout=1.5) as response:
                packet = json.loads(response.read().decode("utf-8"))
            if not isinstance(packet, dict):
                raise ValueError("consumer identity response is not an object")
            return packet, None
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError, URLError) as exc:
            return None, str(exc)

    @app.get("/api/runtime/identity")
    def developer_runtime_identity():
        return jsonify(runtime_identity)

    @app.get("/api/developer/runtime/identity")
    def developer_runtime_identity_consistency():
        consumer_identity, consumer_error = paired_consumer_identity()
        identity_match = bool(
            consumer_identity
            and consumer_identity.get("runtime_instance_id") == runtime_identity.get("runtime_instance_id")
            and consumer_identity.get("runtime_generation") == runtime_identity.get("runtime_generation")
            and consumer_identity.get("runtime_fingerprint") == runtime_identity.get("runtime_fingerprint")
        )
        warning = None
        if consumer_error:
            warning = f"配對 Dashboard 無法驗證：{consumer_error}"
        elif not identity_match:
            warning = "Dashboard 與 Developer 不屬於同一 Runtime generation，禁止用於驗收。"
        return jsonify(
            {
                **runtime_identity,
                "identity_match": identity_match,
                "consistency_status": "ok" if identity_match else "blocked",
                "consumer_identity": consumer_identity,
                "warning": warning,
                "config_state": config_state_store.snapshot(),
            }
        )

    @app.get("/api/developer/configs")
    def developer_configs():
        try:
            manifest = response_manifest(runtime_config)
            active_refs = active_refs_with_runtime(runtime_config)
            locked_refs = locked_refs_with_runtime(runtime_config)
            runtime_refs = runtime_config_refs(runtime_config)
            files = [
                summarize_config_file(path, active_refs, locked_refs, runtime_refs)
                for path in config_paths_with_runtime(runtime_config)
            ]
            return jsonify(
                {
                    "manifest": manifest,
                    "desired_manifest": desired_manifest(),
                    "configs": files,
                    "staging": staging_config_machine(),
                    "source_groups": source_group_cards(),
                    "runtime_identity": runtime_identity,
                    "config_state": config_state_store.snapshot(),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/source-groups")
    def developer_source_groups():
        try:
            return jsonify({"source_groups": source_group_cards()})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/source-groups")
    def developer_source_groups_create():
        try:
            payload = request.get_json(silent=True) or {}
            group = str(payload.get("group") or payload.get("name") or "")
            return jsonify(create_source_group(group))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.patch("/api/developer/source-groups")
    def developer_source_groups_update():
        try:
            payload = request.get_json(silent=True) or {}
            group = str(payload.get("group") or payload.get("name") or "")
            patch = {
                key: payload[key]
                for key in ("ignore", "note")
                if key in payload
            }
            return jsonify(update_source_group_card(group, patch))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/configs/content")
    def developer_config_content():
        try:
            config_ref = request.args.get("path", "")
            path = resolve_config_ref(config_ref)
            if not path.exists():
                return jsonify({"error": "config file not found"}), 404
            data, error = read_config_json(path)
            pending_content = config_state_store.pending_content(config_ref)
            content = pending_content if pending_content is not None else path.read_text(encoding="utf-8")
            if pending_content is not None:
                try:
                    data = json.loads(pending_content)
                    error = None
                except json.JSONDecodeError as exc:
                    error = str(exc)
            return jsonify(
                {
                    "path": normalize_config_ref(path),
                    "name": path.name,
                    "parse_ok": error is None,
                    "error": error,
                    "content": content,
                    "config_state": config_state_store.state_for(config_ref),
                    "restart_required": pending_content is not None,
                    "summary": summarize_config_file(
                        path,
                        active_refs_with_runtime(runtime_config),
                        locked_refs_with_runtime(runtime_config),
                        runtime_config_refs(runtime_config),
                    ),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.put("/api/developer/configs/content")
    def developer_config_content_update():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            content = str(payload.get("content") or "")
            requested_group = str(payload.get("group") or "").strip().lower()
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                raise ValueError("config root must be a JSON object")

            current_path = resolve_config_ref(config_ref)
            current_summary = summarize_config_file(
                current_path,
                active_refs_with_runtime(runtime_config),
                locked_refs_with_runtime(runtime_config),
                runtime_config_refs(runtime_config),
            )
            normalized_ref = normalize_config_ref(current_path)
            effective_locked = normalized_ref in locked_refs_with_runtime(runtime_config)
            if requested_group:
                current_group = str(current_summary.get("group") or "").strip().lower()
                if requested_group != current_group:
                    raise ValueError("moving configs is a deployment operation; stage it through presentationctl")
                parsed["role"] = requested_group
            if not current_summary.get("edit_allowed") and not effective_locked:
                raise ValueError("this config is read-only")
            saved = config_state_store.stage_json(config_ref, parsed)
            return jsonify(
                {
                    **saved,
                    "path": config_ref,
                    "move": None,
                    "mapping_migration": None,
                    "manifest": response_manifest(runtime_config),
                    "runtime_identity": runtime_identity,
                }
            )
        except json.JSONDecodeError as exc:
            return jsonify({"error": f"invalid JSON: {exc}"}), 400
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/import")
    def developer_config_import():
        try:
            uploaded = request.files.get("config")
            if uploaded is None or not uploaded.filename:
                return jsonify({"error": "missing config file"}), 400
            raw = uploaded.read()
            return jsonify(stage_config_file(uploaded.filename, raw))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/group")
    def developer_config_group_move():
        return deployment_operation_blocked("moving a config")

    @app.get("/api/developer/config-staging")
    def developer_config_staging():
        try:
            return jsonify(staging_config_machine())
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/config-staging/promote")
    def developer_config_staging_promote():
        return deployment_operation_blocked("promoting a staged config")

    @app.delete("/api/developer/config-staging")
    def developer_config_staging_delete():
        try:
            payload = request.get_json(silent=True) or {}
            staging_ref = str(payload.get("path") or payload.get("staging_id") or "")
            return jsonify(delete_staging_config(staging_ref))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/active")
    def developer_config_active():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            active = bool(payload.get("active"))
            path = resolve_config_ref(config_ref)
            if not path.exists():
                return jsonify({"error": "config file not found"}), 404
            if path.name.endswith(".example.json"):
                return jsonify({"error": "example config is demo-only and cannot be activated"}), 400
            runtime_refs = runtime_config_refs(runtime_config)
            normalized = normalize_config_ref(path)
            if normalized in runtime_refs and not active:
                return jsonify({"error": "runtime config is active for the running service and cannot be disabled here"}), 400
            summary = summarize_config_file(path, active_refs_with_runtime(runtime_config), locked_refs_with_runtime(runtime_config), runtime_refs)
            if not is_routable_config_group(str(summary.get("group") or "")):
                return jsonify({"error": "this JSON does not declare or imply a routable data source"}), 400
            data, error = read_config_json(path)
            if active and (error or data is None):
                return jsonify({"error": f"invalid config JSON: {error}"}), 400
            if active and not bool(summary.get("role_consistent")):
                return jsonify({"error": summary.get("error") or "config role does not match its source folder"}), 400
            def update_active(manifest: dict[str, Any]) -> dict[str, Any]:
                active_refs = set(manifest.get("active_configs") or [])
                if active:
                    active_refs.add(normalized)
                else:
                    active_refs.discard(normalized)
                manifest["active_configs"] = sorted(active_refs)
                return manifest

            return jsonify(mutate_manifest(update_active))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/locked")
    def developer_config_locked():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            locked = bool(payload.get("locked"))
            path = resolve_config_ref(config_ref)
            normalized = normalize_config_ref(path)
            if normalized in runtime_config_refs(runtime_config) and not locked:
                return jsonify({"error": "runtime config is locked by the running service and cannot be unlocked here"}), 400
            def update_locked(manifest: dict[str, Any]) -> dict[str, Any]:
                locked_refs = set(manifest.get("locked_configs") or [])
                if locked:
                    locked_refs.add(normalized)
                else:
                    locked_refs.discard(normalized)
                manifest["locked_configs"] = sorted(locked_refs)
                return manifest

            return jsonify(mutate_manifest(update_locked))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/note")
    def developer_config_note():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            note = str(payload.get("note") or "")
            normalized = normalize_config_ref(resolve_config_ref(config_ref))
            def update_note(manifest: dict[str, Any]) -> dict[str, Any]:
                notes = dict(manifest.get("config_notes") or {})
                if note.strip():
                    notes[normalized] = note.strip()
                else:
                    notes.pop(normalized, None)
                manifest["config_notes"] = notes
                return manifest

            return jsonify(mutate_manifest(update_note))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.delete("/api/developer/configs")
    def developer_config_delete():
        return deployment_operation_blocked("deleting a config")

    @app.get("/api/developer/router-status")
    def developer_router_status():
        try:
            manifest = response_manifest(runtime_config)
            rows = route_status_registry.rows("database")
            managed_endpoints = endpoint_supervisor.statuses() if endpoint_supervisor is not None else []
            managed_by_ref = {row["config_ref"]: row for row in managed_endpoints}
            for row in rows:
                managed_runtime = managed_by_ref.get(str(row.get("config_path") or ""))
                if managed_runtime is not None:
                    row["managed_runtime"] = managed_runtime
                    if not managed_runtime["ready"]:
                        row["connected"] = False
                        row["schema_inspectable"] = False
                        row["detail"] = managed_runtime.get("error") or "managed endpoint is unavailable"
            return jsonify(
                {
                    "manifest": manifest,
                    "desired_manifest": desired_manifest(),
                    "rows": rows,
                    "managed_endpoints": managed_endpoints,
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/websocket-status")
    def developer_websocket_status():
        try:
            return jsonify(
                {
                    "manifest": response_manifest(runtime_config),
                    "rows": route_status_registry.rows("websocket"),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/endpoint-status")
    def developer_endpoint_status():
        try:
            manifest = response_manifest(runtime_config)
            return jsonify({"manifest": manifest, "rows": route_status_registry.rows("endpoint")})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/spatial-status")
    def developer_spatial_status():
        try:
            return jsonify(
                {
                    "manifest": response_manifest(runtime_config),
                    "rows": route_status_registry.rows("spatial"),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-imports")
    def developer_layer_imports():
        try:
            return jsonify({"manifest": response_manifest(runtime_config), "rows": route_provided_layer_rows(layer_registry)})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-imports")
    def developer_layer_imports_update():
        try:
            payload = request.get_json(silent=True) or {}
            layer_id = str(payload.get("layer_id") or "")
            imported = bool(payload.get("imported"))
            if imported:
                available_layers = {
                    str(row.get("layer_id") or "").strip().lower()
                    for row in route_provided_layer_rows(layer_registry)
                }
                if layer_id.strip().lower() not in available_layers:
                    raise ValueError("data layer is not provided by an active route contract")
            normalized_layer = layer_id.strip().lower()

            def update_imports(manifest: dict[str, Any]) -> dict[str, Any]:
                layers = set(normalize_imported_layers(manifest.get("imported_layers")))
                if imported:
                    layers.add(normalized_layer)
                else:
                    layers.discard(normalized_layer)
                manifest["imported_layers"] = sorted(layers)
                return manifest

            return jsonify(
                {
                    "rows": route_provided_layer_rows(layer_registry),
                    **mutate_manifest(update_imports),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/schema-profiles")
    def developer_schema_profiles():
        try:
            router_rows = route_status_registry.rows("database")
            return jsonify(
                {
                    "source": "router-status",
                    "router_rows": router_rows,
                    "profiles": inspect_relational_routes(
                        active_config_files_by_group("database", runtime_config),
                        router_rows=router_rows,
                    ),
                    "mappings": desired_mappings().get("mappings") or [],
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-mappings")
    def developer_layer_mappings():
        try:
            return jsonify(
                {
                    **desired_mappings(),
                    "config_state": config_state_store.state_for(mappings_ref),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-mappings")
    def developer_layer_mappings_upsert():
        try:
            payload = request.get_json(silent=True) or {}
            normalized = normalize_layer_mapping(payload)
            def update_mapping(packet: dict[str, Any]) -> dict[str, Any]:
                rows = [
                    row
                    for row in packet.get("mappings") or []
                    if str(row.get("mapping_id") or "") != normalized["mapping_id"]
                ]
                rows.append(normalized)
                rows.sort(key=lambda row: str(row.get("mapping_id") or ""))
                return {"mappings": rows}

            state, rows = mutate_mappings(update_mapping)
            return jsonify(
                {
                    **state,
                    "mapping": normalized,
                    "mappings": rows,
                    "layer_rows": route_provided_layer_rows(layer_registry),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-mappings/enabled")
    def developer_layer_mappings_enabled():
        try:
            payload = request.get_json(silent=True) or {}
            mapping_id = str(payload.get("mapping_id") or "")
            enabled = bool(payload.get("enabled"))
            def update_enabled(packet: dict[str, Any]) -> dict[str, Any]:
                rows = deepcopy(packet.get("mappings") or [])
                for row in rows:
                    if str(row.get("mapping_id") or "") == mapping_id:
                        row["enabled"] = enabled
                        return {"mappings": rows}
                raise ValueError("unknown mapping_id")

            state, rows = mutate_mappings(update_enabled)
            return jsonify(
                {
                    **state,
                    "mappings": rows,
                    "layer_rows": route_provided_layer_rows(layer_registry),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-contracts")
    def developer_layer_contracts():
        try:
            return jsonify({"contracts": route_provided_layer_rows(layer_registry)})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400
