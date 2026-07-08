from __future__ import annotations

from typing import Any

from common_adapter.db.connect import dataset_backend_info
from common_adapter.db.registry import UnsupportedBackendOperation, database_backend


@database_backend("spark")
class SparkReadBackend:
    def __init__(self, config: dict[str, Any], dataset: dict[str, Any]) -> None:
        self.config = config
        self.dataset = dataset
        self.kind, self.connection_ref, self.connection = dataset_backend_info(config, dataset)

    def schema_packet(self) -> dict[str, Any]:
        raise UnsupportedBackendOperation(
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
    ) -> dict[str, Any]:
        raise UnsupportedBackendOperation(
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
    ) -> dict[str, Any]:
        raise UnsupportedBackendOperation(
            "spark",
            "records_range_packet",
            "define the Spark/Iceberg range query contract before enabling this dataset",
        )
