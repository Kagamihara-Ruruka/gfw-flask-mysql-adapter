from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER_PATH = ROOT / "scripts" / "presentation" / "presentation_launcher.py"
SPEC = importlib.util.spec_from_file_location("presentation_launcher", LAUNCHER_PATH)
assert SPEC is not None and SPEC.loader is not None
launcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = launcher
SPEC.loader.exec_module(launcher)


class PresentationLauncherTests(unittest.TestCase):
    def test_default_ports_identify_the_presentation_runtime(self) -> None:
        ports = launcher.PortConfig()
        self.assertEqual(11000, ports.tunnel)
        self.assertEqual(5185, ports.http)
        self.assertEqual(5186, ports.developer)

    def test_start_command_uses_stable_controller_contract(self) -> None:
        command = launcher.build_controller_command(
            "python.exe",
            Path("presentationctl.py"),
            "start",
            launcher.PortConfig(tunnel=11000, http=5185, developer=5186),
            open_browser=True,
        )

        self.assertEqual(
            [
                "python.exe",
                "presentationctl.py",
                "--json",
                "--deployment-profile",
                str(launcher.DEFAULT_DEPLOYMENT_PROFILE.path),
                "start",
                "--tunnel-port",
                "11000",
                "--http-port",
                "5185",
                "--developer-port",
                "5186",
                "--open-browser",
            ],
            command,
        )

    def test_stop_command_has_no_irrelevant_port_arguments(self) -> None:
        command = launcher.build_controller_command(
            "python.exe",
            Path("presentationctl.py"),
            "stop",
            launcher.PortConfig(),
        )
        self.assertEqual(
            [
                "python.exe",
                "presentationctl.py",
                "--json",
                "--deployment-profile",
                str(launcher.DEFAULT_DEPLOYMENT_PROFILE.path),
                "stop",
            ],
            command,
        )

    def test_launcher_identity_is_loaded_from_the_formal_profile(self) -> None:
        profile = launcher.DEFAULT_DEPLOYMENT_PROFILE

        self.assertEqual("sea1", profile.environment)
        self.assertEqual("bigred@192.168.32.201", profile.ssh_target)
        self.assertEqual(profile.credential_target, launcher.CREDENTIAL_TARGET)
        self.assertEqual(profile.ssh_username, launcher.SSH_USERNAME)

    def test_port_config_rejects_duplicate_or_invalid_ports(self) -> None:
        with self.assertRaises(ValueError):
            launcher.PortConfig(tunnel=5085, http=5085, developer=5086).validate()
        with self.assertRaises(ValueError):
            launcher.PortConfig(tunnel=0, http=5085, developer=5086).validate()

    def test_json_event_is_preserved(self) -> None:
        source = {
            "schema": launcher.EVENT_SCHEMA,
            "command": "start",
            "stage": "spark_thrift",
            "status": "ok",
            "message": "Spark Thrift ready.",
            "details": {"port": 11000},
        }
        event = launcher.parse_controller_line(json.dumps(source))
        self.assertEqual(source, event)

    def test_non_protocol_output_becomes_a_log_event(self) -> None:
        event = launcher.parse_controller_line("plain PowerShell output")
        self.assertEqual(launcher.EVENT_SCHEMA, event["schema"])
        self.assertEqual("log", event["status"])
        self.assertEqual("plain PowerShell output", event["message"])

    def test_launcher_does_not_duplicate_infrastructure_clients(self) -> None:
        source = LAUNCHER_PATH.read_text(encoding="utf-8")
        self.assertIn("shell=False", source)
        self.assertNotIn("import docker", source)
        self.assertNotIn("import paramiko", source)
        self.assertNotIn("import kubernetes", source)

    def test_launcher_readiness_includes_spatial_assets_and_cancel_delegates_cleanup(self) -> None:
        source = LAUNCHER_PATH.read_text(encoding="utf-8")
        self.assertIn('"spatial_dependencies"', source)
        self.assertIn('self.live_checks["spatial_dependencies"]', source)
        self.assertIn('self._run_command("stop", automatic=True)', source)
        self.assertIn("self.runner.cancel()", source)

    def test_askpass_environment_never_contains_plaintext_password(self) -> None:
        environment = launcher.build_askpass_environment(
            Path(r"C:\runtime\presentation-askpass.exe"),
            "credential-target",
        )
        self.assertEqual("credential-target", environment["BDDE38_SSH_CREDENTIAL_TARGET"])
        self.assertEqual("force", environment["SSH_ASKPASS_REQUIRE"])
        self.assertNotIn("PASSWORD", " ".join(environment))
        self.assertNotIn("secret", " ".join(environment.values()))

    def test_launcher_uses_windows_credential_manager_not_plaintext_files(self) -> None:
        source = LAUNCHER_PATH.read_text(encoding="utf-8")
        credential_source = (
            ROOT / "scripts" / "presentation" / "windows_credentials.py"
        ).read_text(encoding="utf-8")
        askpass_source = (
            ROOT / "scripts" / "presentation" / "presentation_askpass.cs"
        ).read_text(encoding="utf-8")
        self.assertIn("WindowsCredentialStore", source)
        self.assertIn("CredWriteW", credential_source)
        self.assertIn("CredRead", askpass_source)
        self.assertNotIn("BDDE38_SSH_PASSWORD", source)
        self.assertNotIn("BDDE38_SSH_PASSWORD", askpass_source)


if __name__ == "__main__":
    unittest.main()
