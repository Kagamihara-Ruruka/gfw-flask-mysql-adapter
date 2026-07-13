from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path
from typing import Any

import psycopg

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from common_adapter.db.connect import load_config
from common_adapter.spatial.overlay import gpkg_geometry_to_geojson, overlay_settings, validate_identifier


def ring_wkt(ring: list[list[float]]) -> str:
    return "(" + ",".join(f"{point[0]} {point[1]}" for point in ring) + ")"


def polygon_wkt(polygon: list[list[list[float]]]) -> str:
    return "(" + ",".join(ring_wkt(ring) for ring in polygon) + ")"


def geometry_wkt(geometry: dict[str, Any]) -> str:
    if geometry["type"] == "Polygon":
        return "POLYGON " + polygon_wkt(geometry["coordinates"])
    if geometry["type"] == "MultiPolygon":
        return "MULTIPOLYGON (" + ",".join(polygon_wkt(poly) for poly in geometry["coordinates"]) + ")"
    raise ValueError(f"unsupported geometry type: {geometry['type']}")


def postgis_dsn(settings: dict[str, Any]) -> str:
    return (
        f"host={settings['host']} "
        f"port={int(settings['port'])} "
        f"dbname={settings['database']} "
        f"user={settings['user']} "
        f"password={settings['password']}"
    )


def import_eez(config_path: str | None, *, replace: bool) -> None:
    config = load_config(config_path)
    eez = overlay_settings(config)
    source = eez.get("full_gpkg_path")
    if not source:
        raise ValueError("overlays.eez.full_gpkg_path is required")
    source_path = Path(source)
    if not source_path.is_absolute():
        source_path = Path(__file__).resolve().parents[1] / source_path

    pg = eez["postgis"]
    target_table = validate_identifier(pg.get("table", "eez_v12"), "postgis table")
    tile_table = validate_identifier(pg.get("tile_table", f"{target_table}_tile"), "postgis tile table")
    fill_table = validate_identifier(pg.get("fill_table", f"{target_table}_fill"), "postgis fill table")
    boundary_table = validate_identifier(pg.get("boundary_table", f"{target_table}_boundary"), "postgis boundary table")
    target_geom = validate_identifier(pg.get("geometry_column", "geom"), "postgis geometry column")
    gpkg_table = validate_identifier(eez.get("gpkg_table", "eez_v12"), "gpkg table")
    gpkg_geom = validate_identifier(eez.get("gpkg_geometry_column", "geom"), "gpkg geometry column")

    with psycopg.connect(postgis_dsn(pg), autocommit=True) as pg_conn:
        with pg_conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS postgis")
            if replace:
                cur.execute(f"DROP TABLE IF EXISTS {target_table}")
                cur.execute(f"DROP TABLE IF EXISTS {tile_table}")
                cur.execute(f"DROP TABLE IF EXISTS {fill_table}")
                cur.execute(f"DROP TABLE IF EXISTS {boundary_table}")
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {target_table} (
                    fid integer PRIMARY KEY,
                    mrgid integer,
                    name text,
                    pol_type text,
                    territory text,
                    iso3 text,
                    sovereign text,
                    area_km2 double precision,
                    {target_geom} geometry(MultiPolygon, 4326)
                )
                """
            )

    with sqlite3.connect(str(source_path)) as gpkg_conn:
        gpkg_conn.row_factory = sqlite3.Row
        rows = gpkg_conn.execute(
            f"""
            SELECT
                fid,
                {gpkg_geom} AS geom,
                MRGID,
                GEONAME,
                POL_TYPE,
                TERRITORY1,
                ISO_TER1,
                SOVEREIGN1,
                ISO_SOV1,
                AREA_KM2
            FROM {gpkg_table}
            ORDER BY fid
            """
        ).fetchall()

    inserted = 0
    with psycopg.connect(postgis_dsn(pg), autocommit=False) as pg_conn:
        with pg_conn.cursor() as cur:
            for row in rows:
                geometry = gpkg_geometry_to_geojson(row["geom"])
                wkt = geometry_wkt(geometry)
                cur.execute(
                    f"""
                    INSERT INTO {target_table}
                        (fid, mrgid, name, pol_type, territory, iso3, sovereign, area_km2, {target_geom})
                    VALUES
                        (
                            %s, %s, %s, %s, %s, %s, %s, %s,
                            ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_GeomFromText(%s, 4326)), 3))
                        )
                    ON CONFLICT (fid) DO UPDATE SET
                        mrgid = EXCLUDED.mrgid,
                        name = EXCLUDED.name,
                        pol_type = EXCLUDED.pol_type,
                        territory = EXCLUDED.territory,
                        iso3 = EXCLUDED.iso3,
                        sovereign = EXCLUDED.sovereign,
                        area_km2 = EXCLUDED.area_km2,
                        {target_geom} = EXCLUDED.{target_geom}
                    """,
                    (
                        row["fid"],
                        row["MRGID"],
                        row["GEONAME"],
                        row["POL_TYPE"],
                        row["TERRITORY1"],
                        row["ISO_SOV1"] or row["ISO_TER1"],
                        row["SOVEREIGN1"],
                        row["AREA_KM2"],
                        wkt,
                    ),
                )
                inserted += 1
                if inserted % 25 == 0:
                    print(f"inserted={inserted}", flush=True)
            cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{target_table}_{target_geom}_gist ON {target_table} USING GIST ({target_geom})")
            cur.execute(f"ANALYZE {target_table}")
            def create_tile_table(name: str, source_expression: str, *, make_valid: bool = False) -> None:
                geometry_expression = (
                    f"ST_CollectionExtract(ST_MakeValid({source_expression}), 3)"
                    if make_valid
                    else source_expression
                )
                cur.execute(f"DROP TABLE IF EXISTS {name}")
                cur.execute(
                    f"""
                    CREATE TABLE {name} AS
                    SELECT
                        row_number() OVER ()::integer AS tile_id,
                        source.fid,
                        source.mrgid,
                        source.name,
                        source.pol_type,
                        source.territory,
                        source.iso3,
                        source.sovereign,
                        source.area_km2,
                        dumped.geom::geometry(Polygon, 4326) AS {target_geom}
                    FROM {target_table} AS source
                    CROSS JOIN LATERAL ST_Subdivide({geometry_expression}, 256) AS subdivided(geom)
                    CROSS JOIN LATERAL ST_Dump(subdivided.geom) AS dumped
                    WHERE NOT ST_IsEmpty(source.{target_geom})
                    """
                )
                cur.execute(f"CREATE INDEX idx_{name}_{target_geom}_gist ON {name} USING GIST ({target_geom})")
                cur.execute(f"ANALYZE {name}")

            create_tile_table(tile_table, f"source.{target_geom}")
            cur.execute(f"DROP TABLE IF EXISTS {fill_table}")
            cur.execute(
                f"""
                CREATE TABLE {fill_table} AS
                SELECT
                    source.fid,
                    source.mrgid,
                    source.name,
                    source.pol_type,
                    source.territory,
                    source.iso3,
                    source.sovereign,
                    source.area_km2,
                    ST_Multi(
                        ST_CollectionExtract(
                            ST_Transform(source.{target_geom}, 3857),
                            3
                        )
                    )::geometry(MultiPolygon, 3857) AS {target_geom}
                FROM {target_table} AS source
                WHERE NOT ST_IsEmpty(source.{target_geom})
                """
            )
            cur.execute(f"DELETE FROM {fill_table} WHERE ST_IsEmpty({target_geom})")
            cur.execute(f"CREATE INDEX idx_{fill_table}_{target_geom}_gist ON {fill_table} USING GIST ({target_geom})")
            cur.execute(f"ANALYZE {fill_table}")
            cur.execute(f"DROP TABLE IF EXISTS {boundary_table}")
            cur.execute(
                f"""
                CREATE TABLE {boundary_table} AS
                WITH dateline_mask AS (
                    SELECT ST_Union(ARRAY[
                        ST_Buffer(
                            ST_SetSRID(ST_MakeLine(ST_MakePoint(180, -90), ST_MakePoint(180, 90)), 4326),
                            0.03
                        ),
                        ST_Buffer(
                            ST_SetSRID(ST_MakeLine(ST_MakePoint(-180, -90), ST_MakePoint(-180, 90)), 4326),
                            0.03
                        )
                    ]) AS geom
                )
                SELECT
                    source.fid,
                    source.mrgid,
                    source.name,
                    source.pol_type,
                    source.territory,
                    source.iso3,
                    source.sovereign,
                    source.area_km2,
                    ST_Multi(
                        ST_CollectionExtract(
                            ST_Difference(ST_Boundary(source.{target_geom}), dateline_mask.geom),
                            2
                        )
                    )::geometry(MultiLineString, 4326) AS {target_geom}
                FROM {target_table} AS source
                CROSS JOIN dateline_mask
                WHERE NOT ST_IsEmpty(source.{target_geom})
                """
            )
            cur.execute(f"CREATE INDEX idx_{boundary_table}_{target_geom}_gist ON {boundary_table} USING GIST ({target_geom})")
            cur.execute(f"ANALYZE {boundary_table}")
        pg_conn.commit()
    print(f"import_complete rows={inserted} tile_table={tile_table} fill_table={fill_table} boundary_table={boundary_table}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Marine Regions EEZ GPKG into PostGIS.")
    parser.add_argument("--config", default=None)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    import_eez(args.config, replace=args.replace)


if __name__ == "__main__":
    main()
