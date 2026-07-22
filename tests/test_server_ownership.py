from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from common_adapter.http.server import (
    free_configured_port_if_needed,
    read_server_pid_file,
    remove_server_pid_file,
    server_pid_path,
    write_server_pid_file,
)


class ServerOwnershipTests(unittest.TestCase):
    def config(self, profile: str = "LOCAL") -> dict:
        return {
            "__config_path": f"config/runtime/adapter.{profile.lower()}.json",
            "__runtime_profile": profile,
            "__runtime_identity": {
                "profile": profile,
                "runtime_instance_id": f"{profile.lower()}-instance",
            },
        }

    def test_pid_state_is_scoped_by_runtime_profile_and_ports(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"BDDE38_CONTROL_DIR": directory},
            clear=False,
        ):
            local_path = server_pid_path(self.config("LOCAL"), port=5085, developer_port=5086)
            presentation_path = server_pid_path(
                self.config("PRESENTATION"),
                port=5185,
                developer_port=5186,
            )

        self.assertNotEqual(local_path, presentation_path)
        self.assertNotEqual("flask_pid.txt", local_path.name)

    def test_owner_state_is_atomic_and_only_current_pid_removes_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"BDDE38_CONTROL_DIR": directory},
            clear=False,
        ):
            config = self.config()
            path = server_pid_path(config, port=5085, developer_port=5086)
            write_server_pid_file(
                path,
                config,
                host="127.0.0.1",
                port=5085,
                developer_port=5086,
            )
            packet = read_server_pid_file(path)
            self.assertEqual(os.getpid(), packet["pid"])
            self.assertEqual("bdde38.server_owner.v1", packet["schema"])

            remove_server_pid_file(path)
            self.assertFalse(path.exists())

    def test_busy_external_port_is_never_terminated(self) -> None:
        with patch("common_adapter.http.server.port_is_busy", return_value=True), patch(
            "common_adapter.http.server.subprocess.run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "does not own"):
                free_configured_port_if_needed("127.0.0.1", 5085, enabled=True)

        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
