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


def project_sampled_grid_batch_packet(packet: dict[str, Any]) -> dict[str, Any]:
    """Validate either one canonical frame or a range of canonical frames."""

    if str(packet.get("snapshot_profile") or "") != "canonical_frame":
        return project_sampled_grid_render_packet(packet)
    snapshots = packet.get("snapshots")
    if not isinstance(snapshots, dict):
        raise ValueError("canonical sampled-grid range packet has no snapshots")
    projected = {
        str(date_value): project_sampled_grid_render_packet(snapshot)
        for date_value, snapshot in snapshots.items()
        if isinstance(snapshot, dict)
    }
    if len(projected) != len(snapshots):
        raise ValueError("canonical sampled-grid range packet contains an invalid snapshot")
    return {**packet, "snapshots": projected}
