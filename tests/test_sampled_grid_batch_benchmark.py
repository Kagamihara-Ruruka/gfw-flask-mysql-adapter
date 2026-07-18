from __future__ import annotations

import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from scripts import sampled_grid_batch_benchmark as benchmark


class SampledGridBatchBenchmarkTests(unittest.TestCase):
    def test_direct_source_formats_integral_resolution_without_decimal_suffix(self) -> None:
        with patch.object(
            benchmark,
            "read_response",
            return_value=(200, b'{"grid": []}', {}),
        ) as read_response:
            benchmark.direct_source_snapshot(
                "http://source/api/v1",
                date="2020-01-01",
                aoi="northwest_pacific",
                product="nasa_ocean_color",
                metric="chlor_a",
                resolution=4.0,
                timeout=10,
            )

        request = read_response.call_args.args[0]
        parameters = parse_qs(urlparse(request.full_url).query)
        self.assertEqual(["4"], parameters["resolution"])


if __name__ == "__main__":
    unittest.main()
