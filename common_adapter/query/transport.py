from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any


SAMPLED_GRID_RENDER_TRANSPORT_VERSION = "rrkal.sampled_grid.render.v1"
SAMPLED_GRID_FRAME_FIELDS = ("date", "resolution_km")


def _elapsed_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1000, 3)


def project_sampled_grid_render_packet(packet: dict[str, Any]) -> dict[str, Any]:
    """Project a canonical packet for transport without mutating canonical rows."""

    if packet.get("row_contract_version") != "rrkal.sampled_grid.v1":
        return packet
    if str(packet.get("column_profile") or "render") != "render":
        return packet
    rows = packet.get("rows")
    if not isinstance(rows, list) or not rows:
        return packet
    if not all(isinstance(row, Mapping) for row in rows):
        return packet
    row_fields = tuple(rows[0].keys())
    if not row_fields or any(tuple(row.keys()) != row_fields for row in rows[1:]):
        return packet

    started_at = time.perf_counter()
    frame_fields: dict[str, Any] = {}
    for field in SAMPLED_GRID_FRAME_FIELDS:
        if field not in row_fields:
            continue
        first_value = rows[0][field]
        if all(row[field] == first_value for row in rows[1:]):
            frame_fields[field] = first_value
    projected_fields = tuple(field for field in row_fields if field not in frame_fields)
    projected_rows = [[row[field] for field in projected_fields] for row in rows]
    projection_ms = _elapsed_ms(started_at)

    timing = dict(packet.get("timing") or {})
    timing["packet_projection_ms"] = round(
        float(timing.get("packet_projection_ms") or 0) + projection_ms,
        3,
    )
    if timing.get("api_total_ms") is not None:
        timing["api_total_ms"] = round(float(timing["api_total_ms"]) + projection_ms, 3)
        timing["api_accounted_ms"] = timing["api_total_ms"]
    timing["pipeline_total_ms"] = round(
        float(timing.get("api_total_ms") or 0)
        + float(timing.get("source_capacity_wait_ms") or 0),
        3,
    )
    return {
        **packet,
        "rows": projected_rows,
        "timing": timing,
        "transport_projection": {
            "schema": SAMPLED_GRID_RENDER_TRANSPORT_VERSION,
            "row_fields": list(projected_fields),
            "frame_fields": frame_fields,
        },
    }


def inflate_sampled_grid_render_packet(packet: dict[str, Any]) -> dict[str, Any]:
    """Test/reference decoder for the browser-side render transport projection."""

    projection = packet.get("transport_projection")
    if not isinstance(projection, Mapping):
        return packet
    if projection.get("schema") != SAMPLED_GRID_RENDER_TRANSPORT_VERSION:
        return packet
    row_fields = projection.get("row_fields")
    frame_fields = projection.get("frame_fields")
    rows = packet.get("rows")
    if not isinstance(row_fields, list) or not isinstance(frame_fields, Mapping):
        raise ValueError("invalid sampled-grid render projection metadata")
    if not isinstance(rows, list):
        raise ValueError("invalid sampled-grid render projection rows")
    inflated_rows = []
    for values in rows:
        if not isinstance(values, list) or len(values) != len(row_fields):
            raise ValueError("sampled-grid render projection row width mismatch")
        row = dict(zip(row_fields, values, strict=True))
        row.update(frame_fields)
        inflated_rows.append(row)
    inflated = {**packet, "rows": inflated_rows}
    inflated.pop("transport_projection", None)
    return inflated
