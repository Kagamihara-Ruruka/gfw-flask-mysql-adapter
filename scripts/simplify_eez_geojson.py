from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "static" / "data" / "eez_asia.geojson"
TARGET = ROOT / "static" / "data" / "eez_asia_simplified.geojson"


def simplify_ring(ring: list[list[float]], *, step: int = 8) -> tuple[list[list[float]], int, int]:
    before = len(ring)
    if before <= 8:
        simplified = list(ring)
    else:
        simplified = list(ring[::step])
        if ring[-1] != simplified[-1]:
            simplified.append(ring[-1])
        if simplified[0] != simplified[-1]:
            simplified.append(simplified[0])
    rounded = [[round(float(point[0]), 4), round(float(point[1]), 4)] for point in simplified]
    return rounded, before, len(rounded)


def simplify_geometry(geometry: dict) -> tuple[dict, int, int]:
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    before = 0
    after = 0
    if kind == "Polygon":
        polygons = []
        for ring in coords:
            new_ring, ring_before, ring_after = simplify_ring(ring)
            polygons.append(new_ring)
            before += ring_before
            after += ring_after
        geometry["coordinates"] = polygons
    elif kind == "MultiPolygon":
        multi = []
        for polygon in coords:
            new_polygon = []
            for ring in polygon:
                new_ring, ring_before, ring_after = simplify_ring(ring)
                new_polygon.append(new_ring)
                before += ring_before
                after += ring_after
            multi.append(new_polygon)
        geometry["coordinates"] = multi
    return geometry, before, after


def main() -> int:
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    total_before = 0
    total_after = 0
    for feature in data.get("features", []):
        geometry, before, after = simplify_geometry(feature["geometry"])
        feature["geometry"] = geometry
        total_before += before
        total_after += after
    TARGET.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"source={SOURCE}")
    print(f"target={TARGET}")
    print(f"coord_pairs_before={total_before}")
    print(f"coord_pairs_after={total_after}")
    print(f"source_bytes={SOURCE.stat().st_size}")
    print(f"target_bytes={TARGET.stat().st_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
