from __future__ import annotations

import json
from typing import Any

from flask import Flask, jsonify, request

from common_adapter.developer.config_service import (
    create_source_group,
    delete_managed_config,
    delete_staging_config,
    is_routable_config_group,
    load_layer_mappings,
    load_router_manifest,
    migrate_layer_mapping_config_ref,
    move_config_to_source_group,
    normalize_config_ref,
    read_config_json,
    resolve_config_ref,
    save_router_manifest,
    set_config_locked,
    set_config_note,
    set_layer_import,
    set_layer_mapping_enabled,
    source_group_cards,
    stage_config_file,
    staging_config_machine,
    promote_staging_config,
    summarize_config_file,
    update_source_group_card,
    upsert_layer_mapping,
    write_config_json_content,
)
from common_adapter.developer.schema_inspector import inspect_relational_routes
from common_adapter.endpoint.supervisor import ManagedEndpointSupervisor
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.layers.runtime import (
    active_config_files_by_group,
    active_refs_with_runtime,
    config_paths_with_runtime,
    locked_refs_with_runtime,
    runtime_config_refs,
)
from common_adapter.layers.status import RouteStatusRegistry


def response_manifest(runtime_config: dict[str, Any] | None) -> dict[str, Any]:
    manifest = dict(load_router_manifest())
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
) -> None:
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
                    "configs": files,
                    "staging": staging_config_machine(),
                    "source_groups": source_group_cards(),
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
            return jsonify(
                {
                    "path": normalize_config_ref(path),
                    "name": path.name,
                    "parse_ok": error is None,
                    "error": error,
                    "content": path.read_text(encoding="utf-8"),
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
            if not current_summary.get("edit_allowed"):
                raise ValueError("this config is read-only")

            move_result = None
            mapping_migration = None
            if requested_group:
                parsed["role"] = requested_group
                move_result = move_config_to_source_group(config_ref, requested_group)
                next_ref = str(move_result.get("moved") or config_ref)
                mapping_migration = migrate_layer_mapping_config_ref(config_ref, next_ref)
                config_ref = next_ref
            normalized_content = json.dumps(parsed, ensure_ascii=False, indent=2) + "\n"
            saved = write_config_json_content(config_ref, normalized_content)
            route_status_registry.invalidate()
            return jsonify(
                {
                    **saved,
                    "path": config_ref,
                    "move": move_result,
                    "mapping_migration": mapping_migration,
                    "manifest": response_manifest(runtime_config),
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
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            group = str(payload.get("group") or "")
            result = move_config_to_source_group(config_ref, group)
            moved = str(result.get("moved") or "")
            old_path = str(result.get("old_path") or config_ref)
            mapping_migration = None
            if moved:
                mapping_migration = migrate_layer_mapping_config_ref(old_path, moved)
            config_summary = None
            if moved:
                path = resolve_config_ref(moved)
                config_summary = summarize_config_file(
                    path,
                    active_refs_with_runtime(runtime_config),
                    locked_refs_with_runtime(runtime_config),
                    runtime_config_refs(runtime_config),
                )
            route_status_registry.invalidate()
            return jsonify(
                {
                    **result,
                    "config": config_summary,
                    "mapping_migration": mapping_migration,
                    "manifest": response_manifest(runtime_config),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/config-staging")
    def developer_config_staging():
        try:
            return jsonify(staging_config_machine())
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/config-staging/promote")
    def developer_config_staging_promote():
        try:
            payload = request.get_json(silent=True) or {}
            staging_ref = str(payload.get("path") or payload.get("staging_id") or "")
            group = str(payload.get("group") or "")
            result = promote_staging_config(staging_ref, group)
            promoted = str(result.get("promoted") or "")
            config_summary = None
            if promoted:
                path = resolve_config_ref(promoted)
                config_summary = summarize_config_file(
                    path,
                    active_refs_with_runtime(runtime_config),
                    locked_refs_with_runtime(runtime_config),
                    runtime_config_refs(runtime_config),
                )
            route_status_registry.invalidate()
            return jsonify({**result, "config": config_summary, "manifest": response_manifest(runtime_config)})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

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
            manifest = load_router_manifest()
            active_refs = set(manifest["active_configs"])
            if active:
                active_refs.add(normalized)
            else:
                active_refs.discard(normalized)
            save_router_manifest(
                {
                    "active_configs": sorted(active_refs),
                    "locked_configs": manifest["locked_configs"],
                    "config_notes": manifest.get("config_notes") or {},
                    "imported_layers": manifest.get("imported_layers") or [],
                }
            )
            route_status_registry.invalidate()
            updated_manifest = response_manifest(runtime_config)
            return jsonify({"status": "ok", "manifest": updated_manifest})
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
            return jsonify(set_config_locked(config_ref, locked))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/configs/note")
    def developer_config_note():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            note = str(payload.get("note") or "")
            return jsonify(set_config_note(config_ref, note))
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.delete("/api/developer/configs")
    def developer_config_delete():
        try:
            payload = request.get_json(silent=True) or {}
            config_ref = str(payload.get("path") or "")
            result = delete_managed_config(config_ref)
            route_status_registry.invalidate()
            return jsonify({"status": "ok", **result})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

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
            result = set_layer_import(layer_id, imported)
            route_status_registry.invalidate()
            return jsonify({"rows": route_provided_layer_rows(layer_registry), **result})
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
                    "mappings": load_layer_mappings()["mappings"],
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-mappings")
    def developer_layer_mappings():
        try:
            return jsonify(load_layer_mappings())
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-mappings")
    def developer_layer_mappings_upsert():
        try:
            payload = request.get_json(silent=True) or {}
            result = upsert_layer_mapping(payload)
            route_status_registry.invalidate()
            return jsonify(
                {
                    **result,
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
            result = set_layer_mapping_enabled(mapping_id, enabled)
            route_status_registry.invalidate()
            return jsonify(
                {
                    **result,
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
