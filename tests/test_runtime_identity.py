from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from common_adapter.db.connect import load_config
from common_adapter.http.interface import create_flask_app
from common_adapter.http.routes.developer import register_developer_routes
from common_adapter.http.routes.system import SystemRoutes
from common_adapter.layers.runtime import (
    active_config_files_by_group,
    layer_mappings_with_runtime,
    manifest_with_runtime,
)
from common_adapter.runtime.identity import capture_runtime_config_snapshot


class _LayerRegistry:
    def snapshot(self, *, force: bool = False):
        return {"generation": 1, "datasets": {}, "layers": [], "source_errors": []}

    def invalidate(self) -> None:
        return None


class _StatusRegistry:
    def snapshot(self, *, force: bool = False):
        return {"generation": 1, "routes": [], "layers": [], "source_errors": []}

    def invalidate(self) -> None:
        return None


class _UrlResponse:
    def __init__(self, packet: dict) -> None:
        self.payload = json.dumps(packet).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.payload


class RuntimeIdentityTests(unittest.TestCase):
    def test_local_and_presentation_profiles_expose_different_effective_backends(self) -> None:
        with patch.dict(
            os.environ,
            {
                "BDDE38_RUNTIME_GENERATION": "3",
                "BDDE38_RUNTIME_INSTANCE_ID": "local-instance",
            },
            clear=False,
        ):
            local = capture_runtime_config_snapshot(
                load_config("config/runtime/adapter.local.json"),
                http_port=5085,
                developer_port=5086,
            ).public_identity()
        with patch.dict(
            os.environ,
            {
                "BDDE38_RUNTIME_GENERATION": "4",
                "BDDE38_RUNTIME_INSTANCE_ID": "presentation-instance",
            },
            clear=False,
        ):
            presentation = capture_runtime_config_snapshot(
                load_config("config/presentation/adapter.runtime.json"),
                http_port=5085,
                developer_port=5086,
            ).public_identity()

        self.assertEqual("LOCAL", local["profile"])
        self.assertEqual("sampled_grid_http", local["query_backend"])
        self.assertEqual("PRESENTATION", presentation["profile"])
        self.assertEqual("hive", presentation["query_backend"])
        self.assertNotEqual(local["runtime_fingerprint"], presentation["runtime_fingerprint"])

    def test_runtime_consumers_use_captured_control_artifacts_without_disk_reload(self) -> None:
        config_ref = "config/sources/database/snapshot.json"
        manifest = {
            "active_configs": [config_ref],
            "locked_configs": [config_ref],
            "imported_layers": [],
        }
        mappings = {"mappings": [{"mapping_id": "snapshot.mapping"}]}
        source = {
            "role": "database",
            "name": "snapshot",
            "connections": {"primary": {"kind": "mysql"}},
        }
        runtime_config = {
            "__runtime_manifest_snapshot": manifest,
            "__runtime_mapping_snapshot": mappings,
            "__runtime_source_snapshots": {config_ref: source},
        }

        with patch(
            "common_adapter.layers.runtime.load_router_manifest",
            side_effect=AssertionError("manifest disk reload"),
        ), patch(
            "common_adapter.layers.runtime.load_layer_mappings",
            side_effect=AssertionError("mapping disk reload"),
        ), patch(
            "common_adapter.layers.runtime.read_config_json",
            side_effect=AssertionError("source disk reload"),
        ):
            self.assertEqual(manifest, manifest_with_runtime(runtime_config))
            self.assertEqual(mappings, layer_mappings_with_runtime(runtime_config))
            rows = active_config_files_by_group("database", runtime_config)

        self.assertEqual(1, len(rows))
        self.assertEqual(config_ref, rows[0][0])
        self.assertEqual(source, rows[0][2])

    def test_presentation_profile_owns_explicit_artifacts_and_backend(self) -> None:
        environment = {
            "BDDE38_RUNTIME_INSTANCE_ID": "presentation-instance",
            "BDDE38_RUNTIME_GENERATION": "17",
            "BDDE38_PUBLIC_HTTP_PORT": "5185",
            "BDDE38_PUBLIC_DEVELOPER_PORT": "5186",
            "BDDE38_IMAGE_DIGEST": "sha256:image",
            "BDDE38_COMPOSE_HASH": "compose-hash",
            "BDDE38_BRIDGE_OWNER_TOKEN": "bridge-token",
        }
        with patch.dict(os.environ, environment, clear=False):
            config = load_config("config/presentation/adapter.runtime.json")
            snapshot = capture_runtime_config_snapshot(config, http_port=5085, developer_port=5086)

        identity = snapshot.public_identity()
        self.assertEqual("PRESENTATION", identity["profile"])
        self.assertEqual("presentationctl", identity["managed_by"])
        self.assertEqual(5185, identity["http_port"])
        self.assertEqual(5186, identity["developer_port"])
        self.assertEqual("hive", identity["query_backend"])
        self.assertEqual("spark_thrift", identity["connection_ref"])
        self.assertEqual(
            "config/sources/database/spark-thrift.presentation.json",
            identity["source_config_path"],
        )
        self.assertTrue(identity["manifest_path"].endswith("router_manifest.presentation.json"))
        self.assertTrue(identity["mapping_path"].endswith("layer_mappings.presentation.json"))
        self.assertNotIn(".local.json", identity["manifest_path"])
        self.assertNotIn(".local.json", identity["mapping_path"])
        self.assertNotEqual(identity["config_bundle_hash"], identity["runtime_fingerprint"])

    def test_deployment_evidence_changes_runtime_but_not_config_bundle_identity(self) -> None:
        config = load_config("config/presentation/adapter.runtime.json")
        common_environment = {
            "BDDE38_RUNTIME_INSTANCE_ID": "presentation-instance",
            "BDDE38_RUNTIME_GENERATION": "17",
            "BDDE38_PUBLIC_HTTP_PORT": "5185",
            "BDDE38_PUBLIC_DEVELOPER_PORT": "5186",
            "BDDE38_COMPOSE_HASH": "compose-hash",
            "BDDE38_BRIDGE_OWNER_TOKEN": "bridge-token",
        }
        with patch.dict(
            os.environ,
            {**common_environment, "BDDE38_IMAGE_DIGEST": "sha256:image-a"},
            clear=False,
        ):
            first = capture_runtime_config_snapshot(config, http_port=5085, developer_port=5086).public_identity()
        with patch.dict(
            os.environ,
            {**common_environment, "BDDE38_IMAGE_DIGEST": "sha256:image-b"},
            clear=False,
        ):
            second = capture_runtime_config_snapshot(config, http_port=5085, developer_port=5086).public_identity()

        self.assertEqual(first["config_bundle_hash"], second["config_bundle_hash"])
        self.assertNotEqual(first["runtime_fingerprint"], second["runtime_fingerprint"])

    def test_consumer_and_developer_expose_one_runtime_generation(self) -> None:
        identity = {
            "schema": "bdde38.runtime_identity.v1",
            "runtime_instance_id": "instance-1",
            "runtime_generation": 9,
            "runtime_fingerprint": "fingerprint-1",
            "profile": "PRESENTATION",
            "query_backend": "hive",
            "connection_ref": "spark_thrift",
        }
        config = {"__runtime_identity": identity}
        layer_registry = _LayerRegistry()
        status_registry = _StatusRegistry()

        consumer_app = create_flask_app()
        SystemRoutes(
            config,
            layer_registry=layer_registry,
            route_status_registry=status_registry,
        ).register(consumer_app)
        consumer_identity = consumer_app.test_client().get("/api/runtime/identity").get_json()

        developer_app = create_flask_app()
        register_developer_routes(
            developer_app,
            config,
            layer_registry=layer_registry,
            route_status_registry=status_registry,
            consumer_probe_url="http://consumer.internal:5085",
        )
        with patch(
            "common_adapter.http.routes.developer.urlopen",
            return_value=_UrlResponse(consumer_identity),
        ), patch(
            "common_adapter.http.routes.developer.RuntimeConfigStateStore.snapshot",
            return_value={"status": "effective", "generation": 9, "pending": {}},
        ):
            packet = developer_app.test_client().get("/api/developer/runtime/identity").get_json()

        self.assertTrue(packet["identity_match"])
        self.assertEqual("ok", packet["consistency_status"])
        self.assertEqual(identity["runtime_instance_id"], packet["runtime_instance_id"])
        self.assertEqual(identity["runtime_fingerprint"], packet["runtime_fingerprint"])
        self.assertEqual(identity["runtime_generation"], packet["runtime_generation"])

    def test_mismatched_consumer_generation_blocks_acceptance(self) -> None:
        identity = {
            "runtime_instance_id": "instance-1",
            "runtime_generation": 9,
            "runtime_fingerprint": "fingerprint-9",
        }
        config = {"__runtime_identity": identity}
        developer_app = create_flask_app()
        register_developer_routes(
            developer_app,
            config,
            layer_registry=_LayerRegistry(),
            route_status_registry=_StatusRegistry(),
            consumer_probe_url="http://consumer.internal:5085",
        )
        old_identity = {**identity, "runtime_generation": 8, "runtime_fingerprint": "fingerprint-8"}
        with patch(
            "common_adapter.http.routes.developer.urlopen",
            return_value=_UrlResponse(old_identity),
        ):
            packet = developer_app.test_client().get("/api/developer/runtime/identity").get_json()

        self.assertFalse(packet["identity_match"])
        self.assertEqual("blocked", packet["consistency_status"])
        self.assertIn("禁止用於驗收", packet["warning"])


if __name__ == "__main__":
    unittest.main()
