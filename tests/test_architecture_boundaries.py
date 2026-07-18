from __future__ import annotations

import ast
import unittest
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ArchitectureBoundaryTests(unittest.TestCase):
    def test_core_does_not_depend_on_legacy_python_import_entrypoints(self) -> None:
        wrappers = [
            "AisHubProvider.py",
            "AisIngestService.py",
            "AisLiveService.py",
            "AisStreamProvider.py",
            "ConfigContracts.py",
            "DatabaseConnect.py",
            "DependencyCheck.py",
            "DeveloperConfigService.py",
            "EezBootstrapService.py",
            "Interface.py",
            "LayerContractService.py",
            "LayerRuntimeService.py",
            "LodOverlayService.py",
            "RenderCapability.py",
            "SchemaInspector.py",
            "SnapshotSplitService.py",
            "SpatialOverlay.py",
            "common_adapter/db/registry.py",
            "database/registry.py",
        ]
        for relative_path in wrappers:
            self.assertFalse((ROOT / relative_path).exists(), relative_path)
        self.assertFalse((ROOT / "compat/legacy_modules").exists())
        self.assertFalse((ROOT / "common_adapter/config/materialize.py").exists())

    def test_database_routes_do_not_accept_the_removed_top_level_mysql_shape(self) -> None:
        connect_source = (ROOT / "common_adapter/db/connect.py").read_text(encoding="utf-8")
        probe_source = (ROOT / "common_adapter/developer/probes/status.py").read_text(encoding="utf-8")
        self.assertNotIn('config.get("mysql")', connect_source)
        self.assertNotIn('data.get("mysql")', probe_source)
        self.assertNotIn('"default_mysql"', connect_source)

    def test_runtime_connections_are_explicit_and_have_no_local_mysql_fallback(self) -> None:
        connect_source = (ROOT / "common_adapter/db/connect.py").read_text(encoding="utf-8")
        runtime_source = (ROOT / "common_adapter/layers/runtime.py").read_text(encoding="utf-8")
        dataset_routes = (ROOT / "common_adapter/http/routes/datasets.py").read_text(encoding="utf-8")
        ais_source = (ROOT / "common_adapter/ais/live.py").read_text(encoding="utf-8")
        combined = "\n".join((connect_source, runtime_source, dataset_routes, ais_source))

        self.assertNotIn("DEFAULT_MYSQL_CONNECTION_REF", combined)
        self.assertNotIn("default_connection_ref", combined)
        self.assertNotIn("unmapped_database_route", combined)
        self.assertNotIn("resolve_runtime_dataset", runtime_source)
        self.assertIn('dataset.get("connection_ref") or ""', connect_source)
        self.assertIn('raise ValueError("live.ais.connection_ref is required")', ais_source)

        wizard_source = (ROOT / "static/js/ui/developer/developer-wizard.js").read_text(encoding="utf-8")
        hive_example = (ROOT / "config/examples/sources/database/hive.example.json").read_text(encoding="utf-8")
        self.assertNotIn("default_connection_ref", wizard_source)
        self.assertNotIn("default_connection_ref", hive_example)

    def test_status_views_consume_the_shared_route_status_registry(self) -> None:
        developer_source = (ROOT / "common_adapter/http/routes/developer.py").read_text(encoding="utf-8")
        system_source = (ROOT / "common_adapter/http/routes/system.py").read_text(encoding="utf-8")
        self.assertNotIn("connection_status_from_config", developer_source)
        self.assertNotIn("endpoint_status_from_config", developer_source)
        self.assertNotIn("spatial_status_from_config", developer_source)
        self.assertIn("route_status_registry.rows", developer_source)
        self.assertIn("route_status_registry.snapshot", system_source)

    def test_database_adapters_use_the_query_registry_directly(self) -> None:
        paths = [
            ROOT / "common_adapter/db/connect.py",
            ROOT / "common_adapter/db/backends/hive.py",
            ROOT / "common_adapter/db/backends/mysql.py",
            ROOT / "common_adapter/db/backends/spark.py",
        ]
        for path in paths:
            source = path.read_text(encoding="utf-8")
            self.assertNotIn("common_adapter.db.registry", source, str(path))
            self.assertIn("common_adapter.query.registry", source, str(path))

    def test_frontend_cache_uses_only_the_canonical_data_frame_pipeline(self) -> None:
        canonical_files = [
            ROOT / "static/js/services/frame-identity.js",
            ROOT / "static/js/services/data-frame-store.js",
            ROOT / "static/js/services/frame-demand-service.js",
            ROOT / "static/js/services/layer-query-coordinator.js",
        ]
        for canonical in canonical_files:
            self.assertTrue(canonical.exists(), str(canonical))
        self.assertFalse((ROOT / "static/js/services/gfw-record-cache.js").exists())
        self.assertFalse((ROOT / "static/js/services/sampled-grid-record-cache.js").exists())
        self.assertFalse((ROOT / "static/js/playback/playback-prefetch-controller.js").exists())
        cache_source = "\n".join(path.read_text(encoding="utf-8") for path in canonical_files)
        playback_source = (ROOT / "static/js/playback/playback-cache-service.js").read_text(encoding="utf-8")
        self.assertNotIn("GfwRecordCache", cache_source)
        self.assertNotIn("GfwRecordCache", playback_source)
        self.assertNotIn("SampledGridRecordCache", cache_source)

    def test_sampled_grid_runtime_has_no_gfw_compatibility_modules(self) -> None:
        legacy_paths = [
            "static/js/layers/gfw-layer-effects.js",
            "static/js/layers/gfw-layer.js",
            "static/js/rendering/gfw-paint.js",
            "static/js/rendering/gfw-webgl-renderer.js",
            "static/js/services/gfw-render-artifact-cache.js",
            "static/js/ui/layers/gfw-settings.js",
        ]
        for relative_path in legacy_paths:
            self.assertFalse((ROOT / relative_path).exists(), relative_path)

        demo_smoke = (ROOT / "scripts/demo_smoke.py").read_text(encoding="utf-8")
        for relative_path in legacy_paths:
            self.assertNotIn(Path(relative_path).name, demo_smoke, relative_path)

        generic_paths = [
            ROOT / "static/js/layers/sampled-grid-layer-effects.js",
            ROOT / "static/js/layers/sampled-grid-layer.js",
            ROOT / "static/js/rendering/sampled-grid-paint.js",
            ROOT / "static/js/rendering/sampled-grid-webgl-renderer.js",
            ROOT / "static/js/services/sampled-grid-render-artifact-cache.js",
            ROOT / "static/js/ui/layers/sampled-grid-settings.js",
        ]
        for path in generic_paths:
            source = path.read_text(encoding="utf-8")
            self.assertNotIn("window.Gfw", source, str(path))

        styles = (ROOT / "static/styles.css").read_text(encoding="utf-8")
        self.assertNotIn(".gfw-webgl-layer", styles)

    def test_sampled_grid_batch_transport_has_no_row_inflation_shim(self) -> None:
        source = (ROOT / "common_adapter/query/transport.py").read_text(encoding="utf-8")
        self.assertNotIn("inflate_sampled_grid", source)
        self.assertNotIn("canonical_grid_frame_from_rows", source)
        self.assertIn("has no canonical_frame", source)

    def test_config_layout_has_no_runtime_migration_shim(self) -> None:
        source = (ROOT / "common_adapter/config/paths.py").read_text(encoding="utf-8")
        self.assertNotIn("LEGACY_", source)
        self.assertNotIn("_move_if_needed", source)
        self.assertNotIn("_migrate_managed_sources", source)

        canonical_sources = [
            ROOT / "core.py",
            ROOT / "common_adapter/http/routes/datasets.py",
            ROOT / "common_adapter/http/routes/system.py",
            ROOT / "config/schemas/adapter.schema.json",
        ]
        for path in canonical_sources:
            self.assertNotIn("default_dataset", path.read_text(encoding="utf-8"), str(path))

    def test_ais_uses_registered_connections_without_inline_compatibility(self) -> None:
        source = (ROOT / "common_adapter/ais/live.py").read_text(encoding="utf-8")
        source_config = (ROOT / "config/sources/websocket/aisstream.local.json").read_text(encoding="utf-8")
        self.assertNotIn('settings.get("connection")', source)
        self.assertNotIn('"live.ais.connection"', source)
        self.assertNotIn('"connection":', source_config)
        self.assertIn('"connection_ref": "local_mysql"', source_config)

    def test_ais_has_one_runtime_source_path(self) -> None:
        paths = [
            ROOT / "common_adapter/http/routes/live.py",
            ROOT / "static/js/services/api-client.js",
            ROOT / "static/js/ui/layers/ais-settings.js",
            ROOT / "templates/index.html",
            ROOT / "config/sources/websocket/aisstream.local.json",
        ]
        self.assertFalse((ROOT / "common_adapter/ais/aishub.py").exists())
        for path in paths:
            self.assertNotIn("aishub", path.read_text(encoding="utf-8").lower(), str(path))

    def test_common_adapter_import_graph_is_acyclic(self) -> None:
        modules: dict[str, Path] = {}
        for path in (ROOT / "common_adapter").rglob("*.py"):
            module = path.relative_to(ROOT).with_suffix("").as_posix().replace("/", ".")
            if module.endswith(".__init__"):
                module = module[: -len(".__init__")]
            modules[module] = path

        edges: dict[str, set[str]] = defaultdict(set)
        for module, path in modules.items():
            tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
            for node in ast.walk(tree):
                names: list[str] = []
                if isinstance(node, ast.Import):
                    names = [item.name for item in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names = [node.module]
                for name in names:
                    candidates = [
                        candidate
                        for candidate in modules
                        if name == candidate or name.startswith(candidate + ".")
                    ]
                    if candidates:
                        target = max(candidates, key=len)
                        if target != module:
                            edges[module].add(target)

        indices: dict[str, int] = {}
        low: dict[str, int] = {}
        stack: list[str] = []
        on_stack: set[str] = set()
        cycles: list[list[str]] = []

        def visit(module: str) -> None:
            indices[module] = low[module] = len(indices)
            stack.append(module)
            on_stack.add(module)
            for target in edges[module]:
                if target not in indices:
                    visit(target)
                    low[module] = min(low[module], low[target])
                elif target in on_stack:
                    low[module] = min(low[module], indices[target])
            if low[module] != indices[module]:
                return
            component: list[str] = []
            while True:
                target = stack.pop()
                on_stack.remove(target)
                component.append(target)
                if target == module:
                    break
            if len(component) > 1:
                cycles.append(sorted(component))

        for module in modules:
            if module not in indices:
                visit(module)

        self.assertEqual([], cycles)


if __name__ == "__main__":
    unittest.main()
