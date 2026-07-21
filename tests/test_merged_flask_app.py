from __future__ import annotations

import unittest

from common_adapter.http.interface import create_app


class MergedFlaskAppTests(unittest.TestCase):
    def test_one_app_registers_gfw_dataset_eez_and_rrk_routes(self) -> None:
        config = {
            "sql_backend": {"kind": "hive", "driver": "pyhive"},
            "default_connection_ref": "spark_thrift",
            "connections": {
                "spark_thrift": {
                    "kind": "hive",
                    "driver": "pyhive",
                    "host": "dtadm",
                    "port": 10000,
                    "username": "bigred",
                    "auth": "NONE",
                }
            },
            "query_policy": {"snapshot_cache_max_rows": 800000},
            "overlays": {"eez": {"enabled": False}},
            "live": {"ais": {"enabled": False}},
        }
        app = create_app(config)
        rules = {rule.rule for rule in app.url_map.iter_rules()}

        self.assertIn("/", rules)
        self.assertIn("/api/datasets", rules)
        self.assertIn("/api/spark/health", rules)
        self.assertTrue(any(rule.startswith("/api/overlays/eez") for rule in rules))

        response = app.test_client().get("/api/spark/health")
        self.assertEqual(200, response.status_code)
        self.assertEqual("0.10.0", response.get_json()["version"])


if __name__ == "__main__":
    unittest.main()
