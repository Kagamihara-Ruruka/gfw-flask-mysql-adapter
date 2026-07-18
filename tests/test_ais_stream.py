from __future__ import annotations

import json
import unittest

from common_adapter.ais.ingest import AisIngestWorker
from common_adapter.ais.stream import merge_ais_updates, normalize_aisstream_message


def _message(message_type: str, payload: dict, *, metadata: dict | None = None) -> str:
    return json.dumps(
        {
            "MessageType": message_type,
            "Message": {message_type: payload},
            "MetaData": metadata
            or {
                "MMSI": payload.get("UserID"),
                "time_utc": "2024-01-02 03:04:05.123456 +0000 UTC",
            },
        }
    )


class AisStreamTests(unittest.TestCase):
    def test_position_update_uses_source_time_and_preserves_only_present_values(self) -> None:
        row = normalize_aisstream_message(
            _message(
                "PositionReport",
                {
                    "UserID": 123456789,
                    "Latitude": 25.5,
                    "Longitude": 121.25,
                    "Sog": 8.5,
                },
            )
        )

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual("2024-01-02T03:04:05.123+00:00", row["position_event_time"])
        self.assertEqual("position", row["update_kind"])
        self.assertEqual(8.5, row["speed"])
        self.assertNotIn("course", row)
        self.assertNotIn("heading", row)

    def test_static_update_is_kept_without_position_coordinates(self) -> None:
        row = normalize_aisstream_message(
            _message(
                "ShipStaticData",
                {"UserID": 123456789, "Name": " TEST VESSEL@@@@ "},
                metadata={
                    "MMSI": 123456789,
                    "latitude": 20,
                    "longitude": 120,
                    "time_utc": "2024-01-02 03:04:05 +0000 UTC",
                },
            )
        )

        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual("static", row["update_kind"])
        self.assertEqual("TEST VESSEL", row["name"])
        self.assertNotIn("lat", row)
        self.assertNotIn("lon", row)

    def test_delta_merge_keeps_independent_position_and_static_truths(self) -> None:
        position = {
            "mmsi": "123",
            "position_event_time": "2024-01-02T00:00:00+00:00",
            "received_at": "2024-01-02T00:00:01+00:00",
            "lat": 20.0,
            "lon": 120.0,
            "speed": 7.0,
            "source": "aisstream",
            "message_type": "PositionReport",
        }
        static = {
            "mmsi": "123",
            "static_event_time": "2024-01-02T00:00:02+00:00",
            "received_at": "2024-01-02T00:00:03+00:00",
            "name": "VESSEL",
            "source": "aisstream",
            "message_type": "ShipStaticData",
        }
        stale_position = {
            "mmsi": "123",
            "position_event_time": "2024-01-01T23:59:59+00:00",
            "received_at": "2024-01-02T00:00:04+00:00",
            "lat": 1.0,
            "lon": 2.0,
            "source": "aisstream",
            "message_type": "PositionReport",
        }

        merged = merge_ais_updates(position, static)
        merged = merge_ais_updates(merged, stale_position)

        self.assertEqual("mixed", merged["update_kind"])
        self.assertEqual(20.0, merged["lat"])
        self.assertEqual(120.0, merged["lon"])
        self.assertEqual("VESSEL", merged["name"])

    def test_sql_update_plan_does_not_null_missing_delta_fields(self) -> None:
        config = {
            "live": {
                "ais": {
                    "enabled": True,
                    "provider": "aisstream",
                    "connection_ref": "mysql",
                    "database": "ocean",
                    "table": "ais_latest",
                    "time_column": "event_time",
                    "static_time_column": "static_event_time",
                    "received_time_column": "received_at",
                    "lat_column": "lat",
                    "lon_column": "lon",
                    "mmsi_column": "mmsi",
                    "speed_column": "sog",
                    "name_column": "vessel_name",
                }
            }
        }
        worker = AisIngestWorker(config)
        updates = worker._eligible_updates(
            {
                "mmsi": "123",
                "position_event_time": "2024-01-02T00:00:00+00:00",
                "received_at": "2024-01-02T00:00:01+00:00",
                "lat": 20.0,
                "lon": 120.0,
            },
            {"position_event_time": None, "static_event_time": None},
        )

        self.assertEqual(20.0, updates["lat"])
        self.assertNotIn("sog", updates)
        self.assertNotIn("vessel_name", updates)


if __name__ == "__main__":
    unittest.main()
