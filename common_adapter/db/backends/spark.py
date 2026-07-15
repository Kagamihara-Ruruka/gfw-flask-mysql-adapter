from __future__ import annotations

from typing import Any

from common_adapter.db.connect import dataset_backend_info
from common_adapter.query.registry import UnsupportedQueryOperation, query_adapter


@query_adapter("spark")
class SparkReadBackend:
    def __init__(self, config: dict[str, Any], dataset: dict[str, Any]) -> None:
        self.config = config
        self.dataset = dataset
        self.kind, self.connection_ref, self.connection = dataset_backend_info(config, dataset)

    def schema_packet(self) -> dict[str, Any]:
        raise UnsupportedQueryOperation(
            "spark",
            "schema_packet",
            "define the Spark/Iceberg read-model contract before enabling this dataset",
        )

    def records_packet(
        self,
        *,
        date_value: str | None,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        offset: int,
        column_profile: str | None = None,
        query_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raise UnsupportedQueryOperation(
            "spark",
            "records_packet",
            "define the Spark/Iceberg viewport query contract before enabling this dataset",
        )

    def records_range_packet(
        self,
        *,
        start_date: str,
        end_date: str,
        bbox: tuple[float, float, float, float] | None,
        limit: int,
        column_profile: str | None = None,
        query_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raise UnsupportedQueryOperation(
            "spark",
            "records_range_packet",
            "define the Spark/Iceberg range query contract before enabling this dataset",
        )

    def time_series_packet(
        self,
        *,
        start_date: str,
        end_date: str,
        bbox: tuple[float, float, float, float] | None,
        metric: str | None = None,
        aggregation: str | None = None,
        identity_column: str | None = None,
        identity_value: str | None = None,
        query_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raise UnsupportedQueryOperation(
            "spark",
            "time_series_packet",
            "define the Spark/Iceberg time-series aggregation contract before enabling this dataset",
        )
