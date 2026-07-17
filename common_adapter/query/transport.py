from __future__ import annotations

from typing import Any

from common_adapter.query.grid_frame import (
    CANONICAL_GRID_FRAME_VERSION,
)

def project_sampled_grid_render_packet(packet: dict[str, Any]) -> dict[str, Any]:
    """Expose the canonical columnar frame used by the internal batch transport."""

    if packet.get("row_contract_version") != "rrkal.sampled_grid.v1":
        return packet
    if str(packet.get("column_profile") or "render") != "render":
        return packet
    existing = packet.get("canonical_frame")
    if isinstance(existing, dict):
        if existing.get("schema") != CANONICAL_GRID_FRAME_VERSION:
            raise ValueError("unsupported canonical grid frame schema")
        return packet
    raise ValueError("canonical sampled-grid batch packet has no canonical_frame")
