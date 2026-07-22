from __future__ import annotations

import unittest

from scripts.sampled_grid_month_storm import (
    DateRange,
    calendar_month,
    explicit_range,
    range_envelope,
    summarize,
    validate_availability,
)


class SampledGridMonthStormTest(unittest.TestCase):
    def test_calendar_month_uses_real_leap_year_boundaries(self) -> None:
        january = calendar_month("2024-01")
        february = calendar_month("2024-02")

        self.assertEqual(31, january.days)
        self.assertEqual(29, february.days)
        self.assertEqual(("2024-01",), january.month_keys)
        self.assertEqual("2024-02-29", february.end.isoformat())

    def test_cross_month_range_reports_both_calendar_months(self) -> None:
        selected = explicit_range("2024-01-15", "2024-02-14")

        self.assertEqual(31, selected.days)
        self.assertEqual(("2024-01", "2024-02"), selected.month_keys)

    def test_availability_requires_every_date_for_every_dataset(self) -> None:
        selected = explicit_range("2024-01-01", "2024-01-03")
        missing = validate_availability(
            {
                "complete": {"2024-01-01", "2024-01-02", "2024-01-03"},
                "incomplete": {"2024-01-01", "2024-01-03"},
            },
            selected,
        )

        self.assertEqual({"incomplete": ["2024-01-02"]}, missing)

    def test_range_envelope_uses_one_canonical_month_operation(self) -> None:
        selected: DateRange = calendar_month("2024-01")
        envelope = range_envelope(
            "pipeline_iceberg.chlor_a",
            selected,
            sequence=7,
            bbox="120,20,121,21",
            resolution=4,
        )

        self.assertEqual(1, len(envelope["operations"]))
        operation = envelope["operations"][0]
        self.assertEqual("sampled_grid.records_range", operation["kind"])
        self.assertEqual("2024-01-01", operation["params"]["start"])
        self.assertEqual("2024-01-31", operation["params"]["end"])

    def test_range_summary_counts_only_cache_misses_as_source_queries(self) -> None:
        rows = [
            {
                "dataset_id": "ocean",
                "ok": True,
                "elapsed_ms": 10,
                "wire_bytes": 100,
                "snapshot_count": 31,
                "source_request_count": 0,
                "source_query": index == 0,
                "cache_hit": index > 0,
                "cache_waited": False,
                "error": None,
            }
            for index in range(4)
        ]

        report = summarize(rows, 20)

        self.assertEqual(1, report["source_query_count"])
        self.assertEqual(3, report["cache_hits"])
        self.assertEqual([31], report["snapshot_counts"])


if __name__ == "__main__":
    unittest.main()
