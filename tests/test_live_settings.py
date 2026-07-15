from __future__ import annotations

import unittest
from unittest.mock import patch

from common_adapter.http.interface import create_app


class LiveSettingsTests(unittest.TestCase):
    def test_ais_density_grid_is_exposed_from_config(self) -> None:
        config = {
            "live": {
                "ais": {
                    "enabled": True,
                    "provider": "mysql",
                    "density_cells_per_tile": 12,
                }
            }
        }
        with (
            patch("common_adapter.http.routes.live.get_ais_ingest_status", return_value={"key_gate": "ready"}),
            patch("common_adapter.http.routes.live.ais_collector_handoff_status", return_value={"has_api_key": False}),
        ):
            response = create_app(config).test_client().get("/api/live/ais/settings")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["rendering"]["density_cells_per_tile"], 12)

    def test_ais_density_grid_has_a_named_default(self) -> None:
        config = {"live": {"ais": {"enabled": False, "provider": "mysql"}}}
        with (
            patch("common_adapter.http.routes.live.get_ais_ingest_status", return_value={"key_gate": "disabled"}),
            patch("common_adapter.http.routes.live.ais_collector_handoff_status", return_value={"has_api_key": False}),
        ):
            response = create_app(config).test_client().get("/api/live/ais/settings")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["rendering"]["density_cells_per_tile"], 8)


if __name__ == "__main__":
    unittest.main()
