from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
CONTROLLER_PATH = ROOT / "scripts" / "presentation" / "presentationctl.py"
SPEC = importlib.util.spec_from_file_location("presentationctl", CONTROLLER_PATH)
assert SPEC is not None and SPEC.loader is not None
presentationctl = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = presentationctl
SPEC.loader.exec_module(presentationctl)


class PresentationControllerTests(unittest.TestCase):
    def test_json_event_protocol_is_stable(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            reporter = presentationctl.Reporter(json_lines=True)
            reporter.emit("start", "preflight", "ok", "Ready", port=5085)

        event = json.loads(output.getvalue())
        self.assertEqual("bdde38.presentation.event.v1", event["schema"])
        self.assertEqual("start", event["command"])
        self.assertEqual("preflight", event["stage"])
        self.assertEqual("ok", event["status"])
        self.assertEqual({"port": 5085}, event["details"])

    def test_reporter_is_safe_on_a_strict_cp950_console(self) -> None:
        byte_output = io.BytesIO()
        output = io.TextIOWrapper(byte_output, encoding="cp950", errors="strict")
        with redirect_stdout(output):
            presentationctl.Reporter(json_lines=True).emit(
                "start",
                "smoke_test",
                "failed",
                "invalid byte decoded as \ufffd",
            )
            presentationctl.Reporter().emit(
                "start",
                "smoke_test",
                "failed",
                "invalid byte decoded as \ufffd",
            )
        output.flush()

        lines = byte_output.getvalue().decode("cp950").splitlines()
        self.assertEqual("invalid byte decoded as \ufffd", json.loads(lines[0])["message"])
        self.assertIn("invalid byte decoded as ?", lines[1])

    def test_state_store_writes_atomic_readable_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            state_path = Path(temporary_dir) / "runtime" / "state.json"
            store = presentationctl.StateStore(state_path)
            store.write(
                command="start",
                stage="ready",
                status="ok",
                message="Presentation environment is ready.",
            )

            state = store.read()
            self.assertEqual("bdde38.presentation.state.v1", state["schema"])
            self.assertEqual("start", state["command"])
            self.assertEqual("ready", state["stage"])
            self.assertEqual([], list(state_path.parent.glob("state.json.*.tmp")))

    def test_state_store_tolerates_concurrent_status_updates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            state_path = Path(temporary_dir) / "runtime" / "state.json"
            store = presentationctl.StateStore(state_path)

            def write(index: int) -> None:
                store.write(
                    command="status",
                    stage=f"probe-{index}",
                    status="ok",
                    message=f"Probe {index}",
                )

            with ThreadPoolExecutor(max_workers=8) as executor:
                list(executor.map(write, range(32)))

            state = store.read()
            self.assertEqual("bdde38.presentation.state.v1", state["schema"])
            self.assertTrue(str(state["stage"]).startswith("probe-"))
            self.assertEqual([], list(state_path.parent.glob("state.json.*.tmp")))

    def test_adapter_builds_a_non_shell_powershell_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            script_dir = root / "scripts" / "presentation"
            script_dir.mkdir(parents=True)
            (script_dir / "start-presentation.ps1").write_text("exit 0\n", encoding="utf-8")
            (root / "compose.presentation.yaml").write_text("services: {}\n", encoding="utf-8")
            adapter = presentationctl.PowerShellAdapter(
                presentationctl.RepositoryLayout(root),
                presentationctl.Reporter(),
                executable="powershell.exe",
            )

            command = adapter.command("start", ["-NoBuild"])
            self.assertEqual("powershell.exe", command[0])
            self.assertIn("-File", command)
            self.assertEqual("-NoBuild", command[-1])
            self.assertNotIn("shell=True", command)

    def test_output_classification_exposes_gui_stages(self) -> None:
        cases = {
            "Opening a visible SSH bridge window.": "cluster_access",
            "Validating HDFS warehouse and YARN workers": "hdfs_yarn",
            "Using the existing shared Spark Thrift Server": "spark_thrift",
            "Spark tunnel is ready": "ssh_tunnel",
            "Starting PostGIS": "docker_postgis",
            "Docker Compose startup": "docker_app",
            "Prewarming EEZ domain tiles": "spatial_dependencies",
            "Waiting for the presentation service": "application_health",
            "PASS official site": "smoke_test",
            "Official site: http://127.0.0.1:5185/": "ready",
            "arbitrary output": "preflight",
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                self.assertEqual(expected, presentationctl.classify_output_stage(line))

    def test_explicit_stage_marker_preserves_status_and_message(self) -> None:
        self.assertEqual(
            ("spark_thrift", "ok", "Iceberg is queryable."),
            presentationctl.parse_output_event(
                "BDDE38_STAGE spark_thrift ok Iceberg is queryable."
            ),
        )

    def test_contract_exposes_tk_commands_and_readiness_truth(self) -> None:
        layout = presentationctl.RepositoryLayout(ROOT)
        contract = presentationctl.contract_payload(layout)

        self.assertEqual("bdde38.presentation.contract.v2", contract["schema"])
        self.assertEqual(list(presentationctl.STAGES), contract["stages"])
        self.assertEqual(
            ["app", "postgis"],
            contract["required_compose_services"],
        )
        self.assertEqual(
            "scripts/presentation/start-presentation.cmd",
            contract["commands"]["start"],
        )
        self.assertIn("controller_test", contract["commands"])
        self.assertIn("accepted", contract["ready_criteria"])
        self.assertEqual("smoke_test_failed", contract["exit_codes"]["22"])
        self.assertEqual(
            "bigred@192.168.32.201",
            contract["network_topology"]["ssh_target"],
        )
        self.assertIn("tailscale_route", contract["stages"])
        self.assertEqual(
            "tailscale_subnet_direct",
            contract["deployment_profile"]["connectivity"]["mode"],
        )
        self.assertEqual("Tailscale direct subnet", contract["network_topology"]["route"])
        self.assertEqual("kubernetes-admin@sea1", contract["network_topology"]["kubernetes_context"])
        self.assertEqual("dt", contract["network_topology"]["kubernetes_namespace"])
        self.assertEqual("deployment/dtadm", contract["network_topology"]["spark_target"])
        self.assertEqual("reuse_required", contract["network_topology"]["spark_lifecycle"])
        self.assertEqual("2022-01-01", contract["data_contract"]["serving_start"])
        self.assertEqual("2024-12-31", contract["data_contract"]["serving_end"])
        self.assertIn("existing Spark Thrift Server", contract["shared_resources"][1])
        self.assertEqual(["eez-bootstrap"], contract["one_shot_compose_services"])
        self.assertFalse(contract["interactive"]["visible_terminal_required"])
        self.assertTrue(
            contract["state_files"]["bridge_owner_evidence"].endswith(
                "presentation-bridge-owner.json"
            )
        )

    def test_spatial_state_requires_manifest_and_every_tile_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            layout = presentationctl.RepositoryLayout(Path(temporary_dir))
            identity = "fixture-cache"
            tile_directory = layout.spatial_manifest.parent / identity / "6" / "53"
            tile_directory.mkdir(parents=True)
            manifest = {
                "schema": "rrkal.eez_domain_prewarm.v1",
                "complete": True,
                "cache_identity": identity,
                "source_version": "v12_20231025",
                "tiles": 1,
            }
            layout.spatial_manifest.write_text(json.dumps(manifest), encoding="utf-8")
            (tile_directory / "27.json").write_text("{}", encoding="utf-8")

            incomplete, details = presentationctl.spatial_state_probe(layout)
            self.assertFalse(incomplete)
            self.assertEqual(0, details["complete_tiles"])

            (tile_directory / "27.land.wkb").write_bytes(b"land")
            (tile_directory / "27.high-seas.wkb").write_bytes(b"sea")
            ready, details = presentationctl.spatial_state_probe(layout)
            self.assertTrue(ready)
            self.assertEqual(1, details["complete_tiles"])

    def test_matching_smoke_state_is_required_for_full_readiness(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            layout = presentationctl.RepositoryLayout(Path(temporary_dir))
            layout.runtime_dir.mkdir(parents=True)
            runtime_identity = {
                "runtime_instance_id": "runtime-1",
                "runtime_generation": 7,
                "runtime_fingerprint": "fingerprint-1",
                "config_bundle_hash": "config-bundle-1",
                "image_digest": "sha256:image-1",
                "compose_hash": "compose-1",
                "bridge_owner_token": "bridge-1",
            }
            state = {
                "schema": "bdde38.presentation.smoke.v2",
                "tunnel_port": 11000,
                "http_port": 5185,
                "developer_port": 5186,
                "datasets": sorted(presentationctl.EXPECTED_DATASETS),
                "runtime_identity": runtime_identity,
            }
            (layout.runtime_dir / "presentation-smoke-state.json").write_text(
                json.dumps(state),
                encoding="utf-8",
            )

            with patch.object(presentationctl, "runtime_identity_probe", return_value=runtime_identity):
                ready, details = presentationctl.smoke_state_probe(
                    layout,
                    tunnel_port=11000,
                    http_port=5185,
                    developer_port=5186,
                )
            self.assertTrue(ready)
            self.assertNotIn("reason", details)

            with patch.object(presentationctl, "runtime_identity_probe", return_value=runtime_identity):
                wrong_port, _ = presentationctl.smoke_state_probe(
                    layout,
                    tunnel_port=11001,
                    http_port=5185,
                    developer_port=5186,
                )
            self.assertFalse(wrong_port)

            replaced_identity = {**runtime_identity, "runtime_generation": 8}
            with patch.object(presentationctl, "runtime_identity_probe", return_value=replaced_identity):
                stale_smoke, stale_details = presentationctl.smoke_state_probe(
                    layout,
                    tunnel_port=11000,
                    http_port=5185,
                    developer_port=5186,
                )
            self.assertFalse(stale_smoke)
            self.assertEqual("runtime_identity_mismatch", stale_details["reason"])

    def test_normalize_passthrough_removes_separator_only(self) -> None:
        self.assertEqual(["-NoBuild"], presentationctl.normalize_passthrough(["--", "-NoBuild"]))
        self.assertEqual(["-NoBuild"], presentationctl.normalize_passthrough(["-NoBuild"]))

    def test_repository_layout_does_not_embed_compose_service_names(self) -> None:
        layout = presentationctl.RepositoryLayout(Path("C:/example/repo"))
        self.assertEqual(
            Path("C:/example/repo/compose.presentation.yaml"),
            layout.compose_file,
        )
        source = CONTROLLER_PATH.read_text(encoding="utf-8")
        self.assertNotIn('services["app"]', source)
        self.assertNotIn('services["postgis"]', source)


if __name__ == "__main__":
    unittest.main()
