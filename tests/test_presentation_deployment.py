from __future__ import annotations

import json
import unittest
from pathlib import Path

from common_adapter.developer.artifacts.layer_mappings import LayerMappingStore


ROOT = Path(__file__).resolve().parents[1]
PRESENTATION_MANIFEST = ROOT / "config/presentation/router_manifest.presentation.json"
PRESENTATION_MAPPINGS = ROOT / "config/presentation/layer_mappings.presentation.json"
SPARK_SOURCE = ROOT / "config/sources/database/spark-thrift.presentation.json"
EEZ_SOURCE = ROOT / "config/sources/spatial/eez.presentation.json"
PRESENTATION_RUNTIME = ROOT / "config/presentation/adapter.runtime.json"
DEPLOYMENT_PROFILE = ROOT / "config/presentation/deployment.profile.json"

EXPECTED_DATASETS = {
    "pipeline_iceberg.chlor_a": ("CHL", "chlor_a"),
    "pipeline_iceberg.fishing_hours": ("GFW", "fishing_hours"),
    "pipeline_iceberg.ocean_productivity_score": (
        "PRODUCTIVITY",
        "ocean_productivity_score",
    ),
    "pipeline_iceberg.sea_temperature": ("SST", "sea_temperature"),
    "pipeline_iceberg.sustainability_pressure": (
        "SUSTAINABILITY",
        "sustainability_pressure",
    ),
}


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


class PresentationDeploymentTests(unittest.TestCase):
    def test_presentation_playback_uses_calendar_month_watermarks(self) -> None:
        runtime = load_json(PRESENTATION_RUNTIME)
        template = (ROOT / "templates/index.html").read_text(encoding="utf-8")
        composition = (
            ROOT / "static/js/runtime/runtime-composition-root.js"
        ).read_text(encoding="utf-8")

        self.assertEqual(
            {
                "buffer_unit": "calendar_month",
                "low_watermark_months": 1,
                "high_watermark_months": 2,
                "rated_frame_bytes": 16777216,
                "cache_headroom_frames": 8,
                "cache_max_bytes": 1342177280,
            },
            runtime["playback"],
        )
        self.assertIn("data-playback-buffer-unit", template)
        self.assertIn("data-playback-low-watermark-months", template)
        self.assertIn("data-playback-high-watermark-months", template)
        self.assertIn("playbackBufferUnit", composition)
        self.assertIn("playbackLowWatermarkMonths", composition)
        self.assertIn("playbackHighWatermarkMonths", composition)

    def test_manifest_activates_only_presentation_sources(self) -> None:
        manifest = load_json(PRESENTATION_MANIFEST)
        expected_sources = {
            "config/sources/database/spark-thrift.presentation.json",
            "config/sources/spatial/eez.presentation.json",
        }

        self.assertEqual(expected_sources, set(manifest["active_configs"]))
        self.assertEqual(expected_sources, set(manifest["locked_configs"]))
        self.assertEqual(
            {"eez", *EXPECTED_DATASETS},
            set(manifest["imported_layers"]),
        )

    def test_five_metrics_share_one_canonical_sampled_grid_contract(self) -> None:
        mappings = load_json(PRESENTATION_MAPPINGS)["mappings"]
        by_dataset = {mapping["dataset_id"]: mapping for mapping in mappings}

        self.assertEqual(set(EXPECTED_DATASETS), set(by_dataset))
        for dataset_id, (product, metric) in EXPECTED_DATASETS.items():
            with self.subTest(dataset_id=dataset_id):
                mapping = by_dataset[dataset_id]
                sampled_grid = mapping["sampled_grid"]
                self.assertEqual("rrkal.sampled_grid.v1", mapping["target_contract"])
                self.assertEqual("viewport", sampled_grid["query_scope"])
                self.assertEqual([4, 16, 32], sampled_grid["available_resolutions_km"])
                self.assertEqual(
                    {"product": product, "metric": metric},
                    sampled_grid["source_parameters"],
                )
                self.assertEqual("northwest_pacific", sampled_grid["default_aoi"])
                self.assertEqual(
                    {"start": "2022-01-01", "end": "2024-12-31"},
                    sampled_grid["date_range"],
                )
                self.assertNotIn("status", mapping["roles"])
                self.assertEqual(1, sampled_grid["visualization"]["color_scale"]["zero_opacity"])
                self.assertIn("bbox", sampled_grid["snapshot_cache"]["identity_roles"])
                self.assertEqual(96, sampled_grid["snapshot_cache"]["max_entries"])

    def test_presentation_mappings_survive_runtime_normalization(self) -> None:
        store = LayerMappingStore(lambda: PRESENTATION_MAPPINGS)
        mappings = store.load()["mappings"]

        self.assertEqual(set(EXPECTED_DATASETS), {row["dataset_id"] for row in mappings})
        self.assertTrue(all(row["database"] == "ocean" for row in mappings))

    def test_container_uses_host_tunnel_and_compose_postgis(self) -> None:
        spark_source = load_json(SPARK_SOURCE)
        spark_connection = spark_source["connections"]["spark_thrift"]
        eez_source = load_json(EEZ_SOURCE)
        postgis = eez_source["overlays"]["eez"]["postgis"]
        compose = (ROOT / "compose.presentation.yaml").read_text(encoding="utf-8")

        self.assertEqual("host.docker.internal", spark_connection["host"])
        self.assertEqual(11000, spark_connection["port"])
        self.assertEqual("lake.ocean.gold_map_metric", spark_source["tables"]["gold_map_metric"])
        self.assertEqual("postgis", postgis["host"])
        self.assertEqual(5432, postgis["port"])
        self.assertIn('"host.docker.internal:host-gateway"', compose)
        self.assertIn("postgis/postgis:16-3.4", compose)
        self.assertIn('"${PRESENTATION_HTTP_PORT:-5185}:5085"', compose)
        self.assertIn('"${PRESENTATION_DEVELOPER_PORT:-5186}:5086"', compose)
        self.assertIn("./config:/app/config:ro", compose)
        self.assertIn("./.runtime:/app/.runtime", compose)
        self.assertIn("BDDE38_RUNTIME_GENERATION", compose)
        self.assertIn("BDDE38_RUNTIME_INSTANCE_ID", compose)
        self.assertIn("BDDE38_BRIDGE_OWNER_TOKEN", compose)

    def test_upstream_history_and_serving_snapshot_are_not_conflated(self) -> None:
        spark_source = load_json(SPARK_SOURCE)
        contract = spark_source["data_contract"]

        self.assertEqual(
            {"start": "2020-01-01", "end": "2024-12-31"},
            contract["research_period"],
        )
        self.assertEqual("parquet", contract["bronze_storage"]["format"])
        self.assertEqual(
            ["year", "month"],
            contract["bronze_storage"]["partition_keys"],
        )
        self.assertEqual("month", contract["gold_processing"]["batch_unit"])
        self.assertEqual(
            {
                "table": "lake.ocean.gold_map_metric",
                "warehouse": "hdfs:///dataset/ocean/warehouse",
                "snapshot_id": "6665865250480704800",
                "start": "2022-01-01",
                "end": "2024-12-31",
                "distinct_days": 1096,
                "validated_at": "2026-07-22",
                "environment": "sea1",
                "ssh_target": "bigred@192.168.32.201",
            },
            contract["validated_serving_snapshot"],
        )
        self.assertEqual(
            {
                "start_date": "2022-01-01",
                "end_date": "2024-12-31",
                "date": "2022-01-01",
                "aoi": "northwest_pacific",
                "product": "SST",
                "metric": "sea_temperature",
                "resolution": 4,
                "heatmap_limit": 20000,
                "grid_features_limit": 1000,
            },
            spark_source["defaults"],
        )

    def test_deployment_profile_is_the_formal_sea1_truth(self) -> None:
        profile = load_json(DEPLOYMENT_PROFILE)

        self.assertEqual("bdde38.presentation.deployment.v1", profile["schema"])
        self.assertEqual("PRESENTATION", profile["profile"])
        self.assertEqual("presentationctl", profile["managed_by"])
        self.assertEqual("sea1", profile["cluster"]["environment"])
        self.assertEqual("bigred@192.168.32.201", profile["cluster"]["ssh_target"])
        self.assertEqual("kubernetes-admin@sea1", profile["cluster"]["kubernetes_context"])
        self.assertEqual("reuse_required", profile["cluster"]["spark_lifecycle"])
        self.assertEqual(5185, profile["ports"]["host_http"])
        self.assertEqual(5085, profile["ports"]["container_http"])
        self.assertEqual("6665865250480704800", profile["data"]["snapshot_id"])
        self.assertEqual(1096, profile["data"]["distinct_days"])

    def test_image_has_one_fixed_presentation_entrypoint(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")

        self.assertNotIn("router_manifest.local.json", dockerfile)
        self.assertNotIn("layer_mappings.local.json", dockerfile)
        self.assertIn('"/app/config/presentation/adapter.runtime.json"', dockerfile)
        self.assertIn('"--port", "5085"', dockerfile)
        self.assertIn('"--developer-port", "5086"', dockerfile)
        self.assertTrue(dockerignore.startswith("**\n"))
        self.assertIn("!official_site/**", dockerignore)
        self.assertIn("!scripts/import_eez_to_postgis.py", dockerignore)
        self.assertIn(
            "!config/sources/database/spark-thrift.presentation.json",
            dockerignore,
        )
        self.assertNotIn("!config/sources/database/local.json", dockerignore)

    def test_human_entrypoint_runs_tunnel_compose_and_smoke(self) -> None:
        start_script = (ROOT / "scripts/presentation/start-presentation.ps1").read_text(
            encoding="utf-8"
        )
        bridge_script = (ROOT / "scripts/presentation/presentation-bridge.ps1").read_text(
            encoding="utf-8"
        )
        restore_script = (
            ROOT / "scripts/presentation/restore-cluster-services.ps1"
        ).read_text(encoding="utf-8")
        smoke_script = (ROOT / "scripts/presentation/test-presentation.ps1").read_text(
            encoding="utf-8"
        )
        stop_script = (ROOT / "scripts/presentation/stop-presentation.ps1").read_text(
            encoding="utf-8"
        )
        controller = (
            ROOT / "scripts/presentation/presentationctl.py"
        ).read_text(encoding="utf-8")

        self.assertIn("deployment.profile.json", start_script)
        self.assertNotIn("192.168.32.200", start_script)
        self.assertIn("presentation-bridge.ps1", start_script)
        self.assertIn("Get-OwnedBridgeProcess", start_script)
        self.assertIn("docker compose -f $composePath up -d postgis", start_script)
        self.assertIn("docker compose -f $composePath up -d app", start_script)
        for stage in (
            "preflight",
            "cluster_access",
            "hdfs_yarn",
            "spark_thrift",
            "ssh_tunnel",
            "docker_postgis",
            "spatial_dependencies",
            "docker_app",
            "application_health",
            "smoke_test",
            "ready",
        ):
            self.assertIn(f"BDDE38_STAGE {stage}", start_script)

        compose = (ROOT / "compose.presentation.yaml").read_text(encoding="utf-8")
        self.assertIn("eez-bootstrap:", compose)
        self.assertIn("bootstrap-eez", compose)
        self.assertIn("http://127.0.0.1:5085/api/runtime/identity", compose)
        self.assertNotIn("http://127.0.0.1:5085/api/health', timeout=5", compose)
        self.assertIn('$livenessUrl = "http://127.0.0.1:$HttpPort/api/runtime/identity"', start_script)
        self.assertIn("run --rm --name $bootstrapContainerName eez-bootstrap", start_script)
        self.assertLess(
            start_script.index("run --rm --name $bootstrapContainerName eez-bootstrap"),
            start_script.index("up -d app"),
        )
        self.assertIn("stop app", start_script)
        self.assertIn("Remove-OwnedBootstrapContainer", stop_script)
        self.assertIn('EndsWith(".part")', stop_script)
        self.assertIn('EndsWith(".lock")', stop_script)

        self.assertIn('TARGET="__TARGET__"', bridge_script)
        self.assertIn('kubectl -n "$NAMESPACE" port-forward "$TARGET"', bridge_script)
        self.assertIn('"$REMOTE_BRIDGE_PORT:$SPARK_SERVICE_PORT"', bridge_script)
        self.assertNotIn("--master yarn", bridge_script)
        self.assertNotIn("--deploy-mode client", bridge_script)
        self.assertIn("reuse_required forbids starting another owner", bridge_script)
        self.assertIn("Using the existing shared Spark Thrift Server", bridge_script)
        self.assertIn('WAREHOUSE="__WAREHOUSE__"', bridge_script)
        self.assertIn('GOLD_TABLE="__GOLD_TABLE__"', bridge_script)
        self.assertIn("BDDE38_ENDPOINT_COUNT=", bridge_script)
        self.assertIn("BDDE38_ENDPOINT_COUNT=2", bridge_script)
        self.assertIn("ENDPOINT_MARKER=", bridge_script)
        self.assertIn("grep -o", bridge_script)
        self.assertNotIn('tr -d "[:space:]" | grep -qx "2"', bridge_script)
        self.assertIn("Beeline validation output (tail):", bridge_script)
        self.assertIn("BDDE38_BRIDGE_READY", bridge_script)
        self.assertIn('OWNER_TOKEN="__OWNER_TOKEN__"', bridge_script)
        self.assertIn('RECLAIM_OWNER_TOKEN="__RECLAIM_OWNER_TOKEN__"', bridge_script)
        self.assertIn("bdde38.presentation.remote_bridge.v1", bridge_script)
        self.assertIn('STATE_FILE="$STATE_DIR/bridge-${REMOTE_BRIDGE_PORT}.state"', bridge_script)
        self.assertIn('grep -q "pid=${FORWARD_PID},"', bridge_script)
        self.assertIn("Kubernetes port-forward did not remain stable", bridge_script)
        self.assertIn("refusing to stop it", bridge_script)
        self.assertIn("ssh_target={1}", bridge_script)
        self.assertIn("profile_hash={4}", bridge_script)
        self.assertIn("this launcher will not start or stop it", bridge_script)
        self.assertNotIn(":dtadm:10000", bridge_script)
        self.assertIn("-ReclaimOwnerToken", start_script)
        self.assertIn("-ExpectedOwnerToken $requestedOwnerToken", start_script)
        self.assertIn("Read-BridgeOwnerToken", start_script)
        self.assertIn("presentation-bridge-owner.json", start_script)
        self.assertIn("bdde38.presentation.bridge_owner.v1", start_script)
        self.assertIn("Read-PersistedBridgeOwnerToken", start_script)
        self.assertIn("Read-EffectiveRuntimeBridgeOwnerToken", start_script)
        self.assertIn("last accepted Runtime generation", start_script)
        self.assertIn("-WindowStyle Hidden", start_script)
        self.assertIn('$bridgeArguments += "-Headless"', start_script)
        self.assertIn("[switch]$Headless", bridge_script)
        self.assertIn("if (-not $Headless)", bridge_script)
        self.assertIn('"ServerAliveInterval=5"', bridge_script)
        self.assertIn("BDDE38_BRIDGE_RECONNECT", bridge_script)
        self.assertIn("$script:BridgeEverReady", bridge_script)
        self.assertIn("retry_in_seconds=", bridge_script)

        self.assertIn("AcknowledgeSharedClusterMutation", restore_script)
        self.assertIn("ShouldProcess", restore_script)
        self.assertNotIn("namenode -format", restore_script.lower())
        self.assertNotIn("hdfs namenode -format", restore_script.lower())

        self.assertIn("aoi=northwest_pacific", smoke_script)
        self.assertNotIn("/api/spark/availability", smoke_script)
        self.assertIn("validated_samples", smoke_script)
        self.assertIn("DeploymentProfilePath", smoke_script)
        self.assertIn("deploymentProfile.ports.host_http", smoke_script)
        self.assertIn("deploymentProfile.ports.host_developer", smoke_script)
        self.assertIn('"2022-01-31", "2022-02-01"', smoke_script)
        self.assertIn("bdde38.presentation.smoke.v2", smoke_script)
        self.assertIn("/api/runtime/identity", smoke_script)
        self.assertIn("/api/developer/runtime/identity", smoke_script)
        self.assertNotIn(
            'http_probe(\n        f"http://127.0.0.1:{http_port}/api/health"',
            controller,
        )
        self.assertIn("bridge_owner_token", smoke_script)
        self.assertIn(
            "$developerIdentity.runtime_fingerprint -eq $runtimeIdentity.runtime_fingerprint",
            smoke_script,
        )
        self.assertIn('"config_bundle_hash"', smoke_script)
        self.assertIn('"config_bundle_hash"', controller)
        self.assertNotIn("$developerIdentity.runtime_identity.runtime_fingerprint", smoke_script)
        self.assertIn("presentation-smoke-state.json", smoke_script)
        self.assertNotIn("aoi=taiwan", smoke_script)
        for dataset_id in EXPECTED_DATASETS:
            self.assertIn(dataset_id, smoke_script)

        self.assertIn('"compose", "-f", $composePath, "down"', stop_script)
        self.assertIn("presentation-bridge.pid", stop_script)
        self.assertIn("Get-OwnedOrphanedSshProcess", stop_script)
        self.assertIn("OWNER_TOKEN=", stop_script)
        self.assertIn("Multiple SSH processes match", stop_script)
        self.assertIn("presentation-bridge-owner.json", stop_script)
        self.assertIn("owner evidence was retained for safe recovery", stop_script)
        self.assertNotIn("kubectl delete", stop_script)
        self.assertNotIn("yarn application -kill", stop_script)

        start_cmd = (ROOT / "scripts/presentation/start-presentation.cmd").read_text(
            encoding="utf-8"
        )
        self.assertIn("presentation-launcher.cmd", start_cmd)
        self.assertNotIn("presentationctl.py", start_cmd)


if __name__ == "__main__":
    unittest.main()
