from __future__ import annotations

import tempfile
import threading
import time
import unittest
import inspect
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from shapely.geometry import MultiPolygon, Polygon, box

from common_adapter.http.routes.overlays import register_overlay_routes
from common_adapter.spatial.land_mask import (
    EezLodOceanTile,
    EezDomainMaskService,
    classify_complement_components,
    classify_local_complement_components,
    xyz_geographic_bleed_bounds,
    xyz_geographic_bounds,
)


def service_config(cache_path: Path) -> dict:
    return {
        "overlays": {
            "eez": {
                "enabled": True,
                "provider": "postgis",
                "source": {"version": "v12_20231025"},
                "domain_mask": {
                    "enabled": True,
                    "tile_query_concurrency": 2,
                    "topology_precision_degrees": 0.025,
                    "cache_path": str(cache_path),
                },
                "postgis": {
                    "host": "unused",
                    "port": 5432,
                    "database": "unused",
                    "user": "unused",
                    "password": "unused",
                    "table": "eez_v12",
                    "geometry_column": "geom",
                },
            }
        }
    }


class EezLandMaskTests(unittest.TestCase):
    def test_local_component_classification_does_not_cut_precision_slivers(self) -> None:
        land_component = box(0, 0, 2, 2)
        high_seas_component = box(4, 0, 10, 10)
        imprecise_high_seas = box(4.05, 0.05, 9.95, 9.95)

        land, high_seas = classify_local_complement_components(
            MultiPolygon((land_component, high_seas_component)),
            (imprecise_high_seas,),
        )

        self.assertEqual((land_component,), land)
        self.assertEqual((high_seas_component,), high_seas)

    def test_versioned_seeds_split_high_seas_from_land_components(self) -> None:
        land_component = box(-10, -10, -5, -5)
        high_seas_component = box(5, 5, 10, 10)

        land, high_seas = classify_complement_components(
            (land_component, high_seas_component),
            ((1, 7.0, 7.0),),
        )

        self.assertEqual((land_component,), land)
        self.assertEqual((high_seas_component,), high_seas)

    def test_duplicate_seed_component_is_rejected(self) -> None:
        component = box(5, 5, 10, 10)
        with self.assertRaisesRegex(ValueError, "unique"):
            classify_complement_components(
                (component,),
                ((1, 6.0, 6.0), (2, 7.0, 7.0)),
            )

    def test_service_persists_derived_artifact_and_renders_semantic_svg_tiles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory)
            components = (
                box(-170, -80, -160, -70),
                box(-145, -25, -140, -20),
            )
            service = EezDomainMaskService(
                service_config(cache_path),
                component_loader=lambda: components,
                lod_ocean_loader=lambda _z, _x, _y: box(-180, -85.05112878, 180, 85.05112878),
            )
            # Use the service's versioned mapping while making all other seeds
            # resolve to unique tiny components for this isolated fixture.
            seeds = service._seed_rows()
            generated = [box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1) for _, lon, lat in seeds]
            service.component_loader = lambda: (box(-10, -10, -5, -5), *generated)

            artifact = service.artifact()
            tile, metadata = service.tile_svg("high_seas", 0, 0, 0)

            self.assertEqual(21, len(artifact.high_seas))
            self.assertEqual(0.025, artifact.precision_degrees)
            self.assertIn(b"<svg", tile)
            self.assertIn(b'shape-rendering="crispEdges"', tile)
            self.assertEqual("high_seas", metadata["kind"])
            self.assertEqual("eez_lod", metadata["geometry_mode"])
            self.assertEqual(2, metadata["bleed_pixels"])
            self.assertIn(b'viewBox="-2 -2 260 260"', tile)
            self.assertTrue(any(cache_path.glob("*.high-seas.wkb")))

            land_result = service.classify_bbox((-9, -9, -6, -6))
            high_seas_result = service.classify_bbox((seeds[0][1] - 0.05, seeds[0][2] - 0.05, seeds[0][1] + 0.05, seeds[0][2] + 0.05))
            self.assertEqual("land", land_result["kind"])
            self.assertEqual("high_seas", high_seas_result["kind"])

    def test_lod_mask_dissolves_subdivided_lod_fragments_before_reducing_precision(self) -> None:
        source = inspect.getsource(EezDomainMaskService._load_lod_ocean_tile)

        self.assertIn("ST_Expand", source)
        self.assertIn("eez_lod_source", source)
        self.assertIn("source.table", source)
        self.assertIn("source.geometry_srid", source)
        self.assertIn("ST_ClipByBox2D", source)
        self.assertIn("ST_ReducePrecision", source)
        self.assertIn("ST_SnapToGrid", source)
        self.assertIn('"lwgeom_reduceprecision" not in str(error).casefold()', source)
        self.assertIn(
            "ST_MakeValid(ST_UnaryUnion(ST_Collect(geom)))",
            source,
        )
        self.assertNotIn("ST_Simplify(", source)
        self.assertIn("self._tile_query_slot(request_kind)", source)

    def test_domain_mask_owns_a_source_capacity_separate_from_eez_render_tiles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = EezDomainMaskService(
                service_config(Path(directory)),
                component_loader=lambda: (),
            )

        self.assertEqual(2, service.domain_tile_query_concurrency)
        self.assertEqual(1, service.high_seas_tile_query_concurrency)

    def test_high_seas_decoration_cannot_consume_the_reserved_land_mask_slot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = EezDomainMaskService(
                service_config(Path(directory)),
                component_loader=lambda: (),
            )
            first_high_seas_started = threading.Event()
            release_first_high_seas = threading.Event()
            second_high_seas_started = threading.Event()
            land_started = threading.Event()

            def high_seas_task(started: threading.Event) -> None:
                with service._tile_query_slot("high_seas"):
                    started.set()
                    release_first_high_seas.wait(timeout=2)

            def land_task() -> None:
                with service._tile_query_slot("land"):
                    land_started.set()

            with ThreadPoolExecutor(max_workers=3) as executor:
                first = executor.submit(high_seas_task, first_high_seas_started)
                self.assertTrue(first_high_seas_started.wait(timeout=1))
                second = executor.submit(high_seas_task, second_high_seas_started)
                land = executor.submit(land_task)

                self.assertTrue(land_started.wait(timeout=1))
                self.assertFalse(second_high_seas_started.is_set())
                release_first_high_seas.set()
                first.result(timeout=1)
                second.result(timeout=1)
                land.result(timeout=1)

    def test_land_and_high_seas_share_one_domain_tile_single_flight(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = EezDomainMaskService(
                service_config(Path(directory)),
                component_loader=lambda: (),
            )
            seeds = service._seed_rows()
            service.component_loader = lambda: (
                box(-10, -10, -5, -5),
                *(box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1) for _, lon, lat in seeds),
            )
            loader_started = threading.Event()
            release_loader = threading.Event()
            loader_calls = 0
            loader_lock = threading.Lock()

            def load_lod(z: int, x: int, y: int) -> EezLodOceanTile:
                nonlocal loader_calls
                with loader_lock:
                    loader_calls += 1
                loader_started.set()
                release_loader.wait(timeout=2)
                return EezLodOceanTile(
                    geometry=box(*xyz_geographic_bleed_bounds(z, x, y)),
                    source_table="fixture",
                    lod=f"fixture_z{z}",
                    simplify_meters=0.0,
                    query_ms=0.0,
                )

            service.lod_ocean_loader = load_lod
            with ThreadPoolExecutor(max_workers=2) as executor:
                high_seas = executor.submit(service._domain_tile, 6, 53, 27, "high_seas")
                self.assertTrue(loader_started.wait(timeout=1))
                land = executor.submit(service._domain_tile, 6, 53, 27, "land")
                time.sleep(0.05)
                self.assertEqual(1, loader_calls)
                release_loader.set()
                high_seas_result = high_seas.result(timeout=2)
                land_result = land.result(timeout=2)

            self.assertIs(high_seas_result, land_result)
            self.assertEqual(1, loader_calls)

    def test_domain_tile_cache_survives_service_restart_without_postgis(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory)
            config = service_config(cache_path)
            probe = EezDomainMaskService(config, component_loader=lambda: ())
            seeds = probe._seed_rows()
            components = (
                box(-10, -10, -5, -5),
                *(box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1) for _, lon, lat in seeds),
            )
            loader_calls = 0

            def load_lod(z: int, x: int, y: int) -> EezLodOceanTile:
                nonlocal loader_calls
                loader_calls += 1
                return EezLodOceanTile(
                    geometry=box(*xyz_geographic_bleed_bounds(z, x, y)),
                    source_table="fixture",
                    lod=f"fixture_z{z}",
                    simplify_meters=0.0,
                    query_ms=2.0,
                )

            first = EezDomainMaskService(
                config,
                component_loader=lambda: components,
                lod_ocean_loader=load_lod,
            )
            generated = first._domain_tile(6, 53, 27, "land")
            self.assertEqual("postgis", generated.cache_tier)
            self.assertEqual(1, loader_calls)

            second = EezDomainMaskService(
                config,
                component_loader=lambda: components,
                lod_ocean_loader=lambda *_: self.fail("persistent cache missed"),
            )
            restored = second._domain_tile(6, 53, 27, "high_seas")

            self.assertEqual("disk", restored.cache_tier)
            self.assertEqual(generated.land, restored.land)
            self.assertEqual(generated.high_seas, restored.high_seas)

    def test_domain_tile_prewarm_reuses_persistent_cache_on_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory)
            config = service_config(cache_path)
            domain = config["overlays"]["eez"]["domain_mask"]
            domain["prewarm"] = {
                "enabled": True,
                "max_tiles": 8,
                "views": [{"bbox": [120, 20, 121, 21], "zooms": [4]}],
            }
            probe = EezDomainMaskService(config, component_loader=lambda: ())
            seeds = probe._seed_rows()
            components = (
                box(-10, -10, -5, -5),
                *(box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1) for _, lon, lat in seeds),
            )
            loader_calls = 0

            def load_lod(z: int, x: int, y: int) -> EezLodOceanTile:
                nonlocal loader_calls
                loader_calls += 1
                return EezLodOceanTile(
                    geometry=box(*xyz_geographic_bleed_bounds(z, x, y)),
                    source_table="fixture",
                    lod=f"fixture_z{z}",
                    simplify_meters=0.0,
                    query_ms=1.0,
                )

            cold = EezDomainMaskService(
                config,
                component_loader=lambda: components,
                lod_ocean_loader=load_lod,
            ).prewarm_domain_tiles()
            cold_calls = loader_calls
            warm = EezDomainMaskService(
                config,
                component_loader=lambda: components,
                lod_ocean_loader=lambda *_: self.fail("restart should use disk tiles"),
            ).prewarm_domain_tiles()

            self.assertGreater(cold["tiles"], 0)
            self.assertEqual(cold["tiles"], cold["generated"])
            self.assertEqual(cold["tiles"], cold_calls)
            self.assertEqual(warm["tiles"], warm["cached"])
            self.assertEqual(0, warm["generated"])
            self.assertTrue(
                (cache_path / "domain-tiles" / "prewarm-manifest.json").is_file()
            )

    def test_invalid_lod_ocean_geometry_is_repaired_before_complement_overlay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = EezDomainMaskService(
                service_config(Path(directory)),
                component_loader=lambda: (),
            )
            seeds = service._seed_rows()
            generated = [
                box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1)
                for _, lon, lat in seeds
            ]
            service.component_loader = lambda: (box(-10, -10, -5, -5), *generated)
            bow_tie = Polygon(((0, 0), (10, 10), (10, 0), (0, 10), (0, 0)))
            self.assertFalse(bow_tie.is_valid)
            service.lod_ocean_loader = lambda _z, _x, _y: bow_tie

            tile, metadata = service.tile_svg("land", 0, 0, 0)

        self.assertIn(b"<svg", tile)
        self.assertGreater(metadata["feature_count"], 0)

    def test_concurrent_services_compile_one_shared_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory)
            config = service_config(cache_path)
            probe = EezDomainMaskService(config, component_loader=lambda: ())
            seeds = probe._seed_rows()
            components = (
                box(-10, -10, -5, -5),
                *(box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1) for _, lon, lat in seeds),
            )
            count_lock = threading.Lock()
            compile_count = 0

            def load_components():
                nonlocal compile_count
                with count_lock:
                    compile_count += 1
                time.sleep(0.15)
                return components

            services = [
                EezDomainMaskService(config, component_loader=load_components),
                EezDomainMaskService(config, component_loader=load_components),
            ]
            with ThreadPoolExecutor(max_workers=2) as executor:
                artifacts = list(executor.map(lambda service: service.artifact(), services))

            self.assertEqual(1, compile_count)
            self.assertEqual(artifacts[0].provenance_digest, artifacts[1].provenance_digest)
            self.assertFalse(any(path.name.endswith(".lock") for path in cache_path.iterdir()))
            self.assertFalse(any(path.name.endswith(".tmp") for path in cache_path.iterdir()))

    def test_visual_land_tile_uses_requested_eez_lod_and_preserves_island_hole(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory)
            service = EezDomainMaskService(
                service_config(cache_path),
                component_loader=lambda: (),
            )
            seeds = service._seed_rows()
            generated = [
                box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1)
                for _, lon, lat in seeds
            ]
            service.component_loader = lambda: (box(-10, -10, -5, -5), *generated)
            calls: list[tuple[int, int, int]] = []
            z, x, y = 9, 426, 221
            west, south, east, north = xyz_geographic_bounds(z, x, y)
            island = box(
                west + ((east - west) * 0.42),
                south + ((north - south) * 0.42),
                west + ((east - west) * 0.58),
                south + ((north - south) * 0.58),
            )
            ocean = Polygon(
                box(west, south, east, north).exterior.coords,
                holes=[island.exterior.coords],
            )

            def load_lod(request_z: int, request_x: int, request_y: int) -> EezLodOceanTile:
                calls.append((request_z, request_x, request_y))
                return EezLodOceanTile(
                    geometry=ocean,
                    source_table="eez_v12_tile",
                    lod=f"web_mercator_subdivided_z{request_z}",
                    simplify_meters=305.7,
                    query_ms=7.0,
                )

            service.lod_ocean_loader = load_lod
            tile, metadata = service.tile_svg("land", z, x, y)

            self.assertEqual([(z, x, y)], calls)
            self.assertIn(b"<path", tile)
            self.assertGreater(metadata["feature_count"], 0)
            self.assertEqual("web_mercator_subdivided_z9", metadata["lod"])
            self.assertEqual("eez_v12_tile", metadata["source_table"])
            self.assertEqual("eez_lod", metadata["geometry_mode"])

    def test_adjacent_mask_tiles_share_an_overlapping_geographic_bleed(self) -> None:
        left = xyz_geographic_bleed_bounds(6, 52, 27)
        right = xyz_geographic_bleed_bounds(6, 53, 27)
        left_exact = xyz_geographic_bounds(6, 52, 27)
        right_exact = xyz_geographic_bounds(6, 53, 27)

        self.assertEqual(left_exact[2], right_exact[0])
        self.assertGreater(left[2], right_exact[0])
        self.assertLess(right[0], left_exact[2])

    def test_bbox_domain_classifies_only_the_exact_eez_complement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service = EezDomainMaskService(
                service_config(Path(directory)),
                component_loader=lambda: (),
            )
            seeds = service._seed_rows()
            generated = [
                box(lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1)
                for _, lon, lat in seeds
            ]
            service.component_loader = lambda: (box(-10, -10, -5, -5), *generated)

            result = service.classify_bbox((-9, -9, -6, -6), eez_coverage_ratio=0.93)

            self.assertEqual("land", result["kind"])
            self.assertEqual(0.93, result["eez_coverage_ratio"])
            self.assertEqual(
                [{"kind": "land", "overlap_ratio": 0.07}],
                result["regions"],
            )

    def test_http_route_exposes_domain_tile_without_creating_another_source(self) -> None:
        class FakeService:
            source_version = "v12_20231025"

            def tile_svg(self, kind, z, x, y):
                return b'<svg xmlns="http://www.w3.org/2000/svg"/>', {
                    "kind": kind,
                    "artifact_version": "rrkal.eez_domain.v1",
                    "source_version": "v12_20231025",
                    "tile_ms": 1.25,
                    "feature_count": 1,
                }

            def classify_bbox(self, bbox, *, eez_coverage_ratio=0.0):
                return {
                    "schema": "rrkal.eez_domain_attribution.v1",
                    "kind": "high_seas",
                    "regions": [{"kind": "high_seas", "overlap_ratio": 1.0}],
                }

        app = Flask(__name__)
        register_overlay_routes(app, {}, domain_mask_service=FakeService())
        response = app.test_client().get("/api/overlays/eez/domain/high_seas/tiles/6/53/27.svg")

        self.assertEqual(200, response.status_code)
        self.assertEqual("image/svg+xml", response.mimetype)
        self.assertEqual("high_seas", response.headers["X-EEZ-Domain-Kind"])

        with patch(
            "common_adapter.http.routes.overlays.eez_attribution_packet",
            return_value={
                "attribution": [],
                "query": {"eez_coverage_ratio": 0.0},
                "fallback": "high_seas_or_no_eez_match",
            },
        ):
            attribution = app.test_client().get(
                "/api/overlays/eez/attribution?bbox=130,20,131,21"
            ).get_json()
        self.assertEqual("high_seas", attribution["classification"]["kind"])
        self.assertEqual("high_seas", attribution["domain"]["kind"])
        self.assertIsNone(attribution["fallback"])

        with patch(
            "common_adapter.http.routes.overlays.eez_attribution_packet",
            return_value={
                "attribution": [{"pol_type": "Overlapping claim"}],
                "query": {"eez_coverage_ratio": 0.93},
                "fallback": None,
            },
        ):
            mixed_attribution = app.test_client().get(
                "/api/overlays/eez/attribution?bbox=130,20,131,21"
            ).get_json()
        self.assertEqual("eez", mixed_attribution["classification"]["kind"])
        self.assertEqual("high_seas", mixed_attribution["domain"]["kind"])


if __name__ == "__main__":
    unittest.main()
