from __future__ import annotations

import unittest

from common_adapter.ais.live import ais_mysql_connection_info
from common_adapter.db.connect import dataset_backend_info


class ExplicitConnectionContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = {
            "sql_backend": {"kind": "mysql"},
            "connections": {
                "primary": {
                    "kind": "mysql",
                    "host": "127.0.0.1",
                    "port": 3306,
                    "user": "root",
                    "database": "ocean",
                },
            },
        }

    def test_dataset_does_not_fall_back_to_a_default_connection(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires connection_ref"):
            dataset_backend_info(self.config, {"backend": "mysql"})

    def test_dataset_resolves_its_declared_connection(self) -> None:
        kind, connection_ref, connection = dataset_backend_info(
            self.config,
            {"backend": "mysql", "connection_ref": "primary"},
        )

        self.assertEqual("mysql", kind)
        self.assertEqual("primary", connection_ref)
        self.assertEqual("ocean", connection["database"])

    def test_ais_read_model_requires_an_explicit_connection(self) -> None:
        with self.assertRaisesRegex(ValueError, "live.ais.connection_ref is required"):
            ais_mysql_connection_info(self.config, {})


if __name__ == "__main__":
    unittest.main()
