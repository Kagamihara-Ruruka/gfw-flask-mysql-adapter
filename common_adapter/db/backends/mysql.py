from __future__ import annotations

from typing import Any

from common_adapter.db.connect import (
    _mysql_records_packet,
    _mysql_records_range_packet,
    _mysql_schema_packet,
    dataset_backend_info,
)
from common_adapter.db.registry import database_backend


@database_backend("mysql")
class MySqlReadBackend:
    def __init__(self, config: dict[str, Any], dataset: dict[str, Any]) -> None:
        self.config = config
        self.dataset = dataset
        self.kind, self.connection_ref, self.connection = dataset_backend_info(config, dataset)
        if self.kind != "mysql":
            raise ValueError(f"MySqlReadBackend cannot serve backend {self.kind!r}")

    def schema_packet(self) -> dict[str, Any]:
        packet = _mysql_schema_packet(
            self.config,
            self.dataset,
            connection_ref=self.connection_ref,
            connection=self.connection,
        )
        packet["backend"] = {"kind": self.kind, "connection_ref": self.connection_ref}
        return packet

    def records_packet(
        self,
        *,
        date_value: str | None,
        bbox: tuple[float, float, float, float] | None,
        limit: Any,
        offset: int,
        column_profile: str | None = None,
    ) -> dict[str, Any]:
        packet = _mysql_records_packet(
            self.config,
            self.dataset,
            connection=self.connection,
            date_value=date_value,
            bbox=bbox,
            limit=limit,
            offset=offset,
            column_profile=column_profile,
        )
        packet["backend"] = {"kind": self.kind, "connection_ref": self.connection_ref}
        return packet

    def records_range_packet(
        self,
        *,
        start_date: str,
        end_date: str,
        bbox: tuple[float, float, float, float] | None,
        limit: Any,
        column_profile: str | None = None,
    ) -> dict[str, Any]:
        packet = _mysql_records_range_packet(
            self.config,
            self.dataset,
            connection=self.connection,
            start_date=start_date,
            end_date=end_date,
            bbox=bbox,
            limit=limit,
            column_profile=column_profile,
        )
        packet["backend"] = {"kind": self.kind, "connection_ref": self.connection_ref}
        return packet
