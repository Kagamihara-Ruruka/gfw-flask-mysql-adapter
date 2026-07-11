from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

from common_adapter.developer.config_service import (
    connection_status_from_config,
    create_source_group,
    delete_managed_config,
    delete_staging_config,
    discover_config_files,
    endpoint_status_from_config,
    has_builtin_probe,
    is_routable_config_group,
    load_layer_mappings,
    load_router_manifest,
    move_config_to_source_group,
    normalize_config_ref,
    read_config_json,
    resolve_config_ref,
    save_router_manifest,
    set_config_locked,
    set_config_note,
    set_layer_import,
    set_layer_mapping_enabled,
    spatial_status_from_config,
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
from common_adapter.layers.contracts import build_layer_contracts
from common_adapter.layers.runtime import imported_layer_ids


def runtime_config_ref(runtime_config: dict[str, Any] | None) -> str | None:
    if not runtime_config:
        return None
    config_path = runtime_config.get("__config_path")
    if not config_path:
        return None
    try:
        ref = normalize_config_ref(str(config_path))
        path = resolve_config_ref(ref)
    except Exception:
        return None
    return ref if path.exists() else None


def runtime_config_refs(runtime_config: dict[str, Any] | None) -> set[str]:
    ref = runtime_config_ref(runtime_config)
    return {ref} if ref else set()


def active_refs_with_runtime(runtime_config: dict[str, Any] | None) -> set[str]:
    manifest = load_router_manifest()
    return set(manifest["active_configs"])


def locked_refs_with_runtime(runtime_config: dict[str, Any] | None) -> set[str]:
    manifest = load_router_manifest()
    return set(manifest["locked_configs"]) | runtime_config_refs(runtime_config)


def config_paths_with_runtime(runtime_config: dict[str, Any] | None) -> list[Path]:
    return sorted({path.resolve() for path in discover_config_files()}, key=lambda item: str(item).lower())


def config_supports_group(data: dict[str, Any], summary: dict[str, Any], group: str) -> bool:
    summary_group = str(summary.get("group") or "")
    if summary_group != group:
        return False
    if not has_builtin_probe(group):
        return False
    return True


def response_manifest(runtime_config: dict[str, Any] | None) -> dict[str, Any]:
    manifest = dict(load_router_manifest())
    runtime_refs = sorted(runtime_config_refs(runtime_config))
    if runtime_refs:
        manifest["runtime_configs"] = runtime_refs
        manifest["locked_configs"] = sorted(set(manifest["locked_configs"]) | set(runtime_refs))
    return manifest


def active_config_files_by_group(group: str, runtime_config: dict[str, Any] | None = None) -> list[tuple[str, Path, dict[str, Any]]]:
    manifest = load_router_manifest()
    active_refs = active_refs_with_runtime(runtime_config)
    locked_refs = locked_refs_with_runtime(runtime_config)
    runtime_refs = runtime_config_refs(runtime_config)
    rows: list[tuple[str, Path, dict[str, Any]]] = []
    for path in config_paths_with_runtime(runtime_config):
        ref = normalize_config_ref(path)
        if ref not in active_refs:
            continue
        summary = summarize_config_file(path, active_refs, locked_refs, runtime_refs)
        data, error = read_config_json(path)
        if error or data is None:
            continue
        if not config_supports_group(data, summary, group):
            continue
        rows.append((ref, path, data))
    return rows


def route_provided_layer_rows(runtime_config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    manifest = load_router_manifest()
    imported_layers = imported_layer_ids()
    contracts = build_layer_contracts(
        database_routes=active_config_files_by_group("database", runtime_config),
        websocket_routes=active_config_files_by_group("websocket", runtime_config),
        spatial_routes=active_config_files_by_group("spatial", runtime_config),
    )
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for contract in contracts:
        layer_id = str(contract.get("layer_id") or "").strip().lower()
        if not layer_id or layer_id in seen:
            continue
        seen.add(layer_id)
        rows.append({**contract, "imported": layer_id in imported_layers})
    return rows


def database_router_status_rows(runtime_config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    active_refs = active_refs_with_runtime(runtime_config)
    locked_refs = locked_refs_with_runtime(runtime_config)
    runtime_refs = runtime_config_refs(runtime_config)
    rows: list[dict[str, Any]] = []
    for path in config_paths_with_runtime(runtime_config):
        if path.name.endswith(".example.json"):
            continue
        ref = normalize_config_ref(path)
        if ref not in active_refs:
            continue
        summary = summarize_config_file(path, active_refs, locked_refs, runtime_refs)
        data, error = read_config_json(path)
        if error or data is None:
            rows.append(
                {
                    "config_path": ref,
                    "connection_ref": "-",
                    "backend": "unknown",
                    "enabled": ref in active_refs,
                    "connected": False,
                    "schema_inspectable": False,
                    "detail": error,
                }
            )
            continue
        if not config_supports_group(data, summary, "database"):
            continue
        for row in connection_status_from_config(ref, data, ref in active_refs):
            backend = str(row.get("backend") or "").lower()
            row["schema_inspectable"] = bool(row.get("enabled") and row.get("connected") and backend == "mysql")
            rows.append(row)
    return rows


def endpoint_router_status_rows(runtime_config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    active_refs = active_refs_with_runtime(runtime_config)
    locked_refs = locked_refs_with_runtime(runtime_config)
    runtime_refs = runtime_config_refs(runtime_config)
    rows: list[dict[str, Any]] = []
    for path in config_paths_with_runtime(runtime_config):
        if path.name.endswith(".example.json"):
            continue
        ref = normalize_config_ref(path)
        if ref not in active_refs:
            continue
        summary = summarize_config_file(path, active_refs, locked_refs, runtime_refs)
        data, error = read_config_json(path)
        if error or data is None:
            rows.append(
                {
                    "config_path": ref,
                    "endpoint_ref": "-",
                    "base_url": "-",
                    "enabled": ref in active_refs,
                    "configured": False,
                    "reachable": False,
                    "contract_detected": False,
                    "detail": error,
                }
            )
            continue
        if not config_supports_group(data, summary, "endpoint"):
            continue
        rows.extend(endpoint_status_from_config(ref, data, ref in active_refs))
    return rows


def register_developer_routes(app: Flask, runtime_config: dict[str, Any] | None = None) -> None:
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
            return jsonify(write_config_json_content(config_ref, content))
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
            config_summary = None
            if moved:
                path = resolve_config_ref(moved)
                config_summary = summarize_config_file(
                    path,
                    active_refs_with_runtime(runtime_config),
                    locked_refs_with_runtime(runtime_config),
                    runtime_config_refs(runtime_config),
                )
            return jsonify({**result, "config": config_summary, "manifest": response_manifest(runtime_config)})
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
                    "config_groups": manifest.get("config_groups") or {},
                }
            )
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
            return jsonify({"status": "ok", **delete_managed_config(config_ref)})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/router-status")
    def developer_router_status():
        try:
            manifest = response_manifest(runtime_config)
            rows = database_router_status_rows(runtime_config)
            return jsonify({"manifest": manifest, "rows": rows})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/websocket-status")
    def developer_websocket_status():
        try:
            manifest = response_manifest(runtime_config)
            active_refs = active_refs_with_runtime(runtime_config)
            locked_refs = locked_refs_with_runtime(runtime_config)
            runtime_refs = runtime_config_refs(runtime_config)
            rows: list[dict[str, Any]] = []
            for path in config_paths_with_runtime(runtime_config):
                ref = normalize_config_ref(path)
                if ref not in active_refs:
                    continue
                summary = summarize_config_file(path, active_refs, locked_refs, runtime_refs)
                data, error = read_config_json(path)
                if not data or not config_supports_group(data, summary, "websocket"):
                    continue
                provider = "-"
                endpoint = "-"
                configured = False
                enabled = False
                if data:
                    live_ais = data.get("live", {}).get("ais", {}) if isinstance(data.get("live"), dict) else {}
                    provider = str(
                        data.get("provider")
                        or data.get("stream_provider")
                        or live_ais.get("provider")
                        or "websocket"
                    )
                    endpoint = str(
                        data.get("stream_url")
                        or data.get("url")
                        or data.get("endpoint")
                        or live_ais.get("stream_url")
                        or "-"
                    )
                    ingest = data.get("ingest") if isinstance(data.get("ingest"), dict) else {}
                    enabled = bool(ingest.get("enabled", live_ais.get("enabled", True)))
                    configured = bool(provider and endpoint != "-")
                rows.append(
                    {
                        "config_path": ref,
                        "provider": provider,
                        "endpoint": endpoint,
                        "enabled": enabled,
                        "configured": configured and not error,
                        "detail": error or ("設定可用" if configured else "缺少 provider 或 endpoint"),
                    }
                )
            return jsonify({"manifest": manifest, "rows": rows})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/endpoint-status")
    def developer_endpoint_status():
        try:
            manifest = response_manifest(runtime_config)
            return jsonify({"manifest": manifest, "rows": endpoint_router_status_rows(runtime_config)})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/spatial-status")
    def developer_spatial_status():
        try:
            manifest = response_manifest(runtime_config)
            active_refs = active_refs_with_runtime(runtime_config)
            locked_refs = locked_refs_with_runtime(runtime_config)
            runtime_refs = runtime_config_refs(runtime_config)
            rows: list[dict[str, Any]] = []
            for path in config_paths_with_runtime(runtime_config):
                if path.name.endswith(".example.json"):
                    continue
                ref = normalize_config_ref(path)
                if ref not in active_refs:
                    continue
                summary = summarize_config_file(path, active_refs, locked_refs, runtime_refs)
                data, error = read_config_json(path)
                if error or data is None:
                    continue
                if not config_supports_group(data, summary, "spatial"):
                    continue
                rows.extend(spatial_status_from_config(ref, data))
            return jsonify({"manifest": manifest, "rows": rows})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-imports")
    def developer_layer_imports():
        try:
            return jsonify({"manifest": response_manifest(runtime_config), "rows": route_provided_layer_rows(runtime_config)})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.post("/api/developer/layer-imports")
    def developer_layer_imports_update():
        try:
            payload = request.get_json(silent=True) or {}
            layer_id = str(payload.get("layer_id") or "")
            imported = bool(payload.get("imported"))
            result = set_layer_import(layer_id, imported)
            return jsonify({"rows": route_provided_layer_rows(runtime_config), **result})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/schema-profiles")
    def developer_schema_profiles():
        try:
            router_rows = database_router_status_rows(runtime_config)
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
            return jsonify(
                {
                    **result,
                    "layer_rows": route_provided_layer_rows(runtime_config),
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
            return jsonify(
                {
                    **result,
                    "layer_rows": route_provided_layer_rows(runtime_config),
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/developer/layer-contracts")
    def developer_layer_contracts():
        try:
            return jsonify(
                {
                    "contracts": build_layer_contracts(
                        database_routes=active_config_files_by_group("database", runtime_config),
                        websocket_routes=active_config_files_by_group("websocket", runtime_config),
                        spatial_routes=active_config_files_by_group("spatial", runtime_config),
                    )
                }
            )
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400
