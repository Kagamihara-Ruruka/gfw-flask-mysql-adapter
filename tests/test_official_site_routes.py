from __future__ import annotations

import unittest
from pathlib import Path

from common_adapter.http.interface import ROOT, create_flask_app
from common_adapter.http.routes.official_site import (
    OFFICIAL_PAGE_FILES,
    register_official_site_routes,
)
from common_adapter.http.routes.system import register_system_routes


class _LayerRegistryStub:
    def snapshot(self) -> dict[str, object]:
        return {"datasets": {}}


class _RouteStatusRegistryStub:
    def snapshot(self) -> dict[str, object]:
        return {
            "generation": 1,
            "layers": [],
            "routes": [],
            "source_errors": [],
        }


class OfficialSiteRoutesTests(unittest.TestCase):
    def setUp(self) -> None:
        app = create_flask_app()
        app.config.update(TESTING=True)
        register_official_site_routes(app, site_root=ROOT / "official_site")
        register_system_routes(
            app,
            {},
            layer_registry=_LayerRegistryStub(),
            route_status_registry=_RouteStatusRegistryStub(),
            developer_url="http://127.0.0.1:5086",
        )
        self.client = app.test_client()

    def test_root_serves_official_site_and_dashboard_has_its_own_route(self) -> None:
        intro_response = self.client.get("/")
        official_response = self.client.get("/index.html")
        dashboard_response = self.client.get("/dashboard/")
        intro_script_response = self.client.get("/intro.js")

        self.assertEqual(intro_response.status_code, 200)
        self.assertIn(b"BDDE38 Intro", intro_response.data)
        self.assertIn(b'const targetUrl = "/index.html"', intro_script_response.data)

        self.assertEqual(official_response.status_code, 200)
        self.assertIn(b"BDDE38 Group 01 - Ocean Data Lakehouse", official_response.data)
        self.assertIn(b'href="/dashboard/"', official_response.data)

        self.assertEqual(dashboard_response.status_code, 200)
        self.assertIn("海事資料儀表板", dashboard_response.get_data(as_text=True))
        self.assertNotIn("大可愛", dashboard_response.get_data(as_text=True))
        self.assertIn("http://127.0.0.1:5086", dashboard_response.get_data(as_text=True))
        intro_response.close()
        intro_script_response.close()
        official_response.close()
        dashboard_response.close()

    def test_every_public_page_uses_the_same_dashboard_link(self) -> None:
        for page_name in OFFICIAL_PAGE_FILES:
            path = "/" if page_name == "intro.html" else f"/{page_name}"
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertNotIn(b"index.html", response.data)
                self.assertNotIn(b"127.0.0.1", response.data)
                self.assertNotIn(b"localhost", response.data)
                if page_name != "intro.html":
                    self.assertIn(b'href="/dashboard/"', response.data)
                response.close()

    def test_official_assets_are_served_without_exposing_other_files(self) -> None:
        for path, expected_status in (
            ("/about-panorama.js", 200),
            ("/hero-seam-sampler.js", 200),
            ("/member-evolution.mmd", 200),
            ("/member-evolution.svg", 200),
            ("/member-evolution.js", 200),
            ("/product-visual.js", 200),
            ("/styles.css", 200),
            ("/tech-network.js", 200),
            ("/vortex-flow.js", 200),
            ("/assets/ispan-logo.svg", 200),
            ("/assets/ambient-soundscape.js", 200),
            ("/assets/data-howling-wind-cc0.ogg", 200),
            ("/assets/product-sea-surface-ambience.ogg", 200),
            ("/server.log", 404),
            ("/.preview-server.pid", 404),
        ):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, expected_status)
                response.close()

    def test_member_evolution_is_prebuilt_and_has_no_runtime_mermaid_dependency(self) -> None:
        response = self.client.get("/member.html")
        page = response.get_data(as_text=True)
        source = (ROOT / "official_site" / "member-evolution.js").read_text(encoding="utf-8")

        self.assertIn('src="./member-evolution.svg?v=1"', page)
        self.assertIn('src="./member-evolution.js?v=7"', page)
        self.assertNotIn("mermaid.min.js", page)
        self.assertNotIn("cdn.jsdelivr.net", page)
        self.assertNotIn("<canvas class=\"member-evolution", page)
        self.assertIn("trackCopy.style.top = `${trackHeight}px`;", source)
        self.assertNotIn('trackCopy.style.top = "100%";', source)
        response.close()

    def test_member_github_link_is_dialog_data(self) -> None:
        response = self.client.get("/member.html")
        page = response.get_data(as_text=True)
        source = (ROOT / "official_site" / "script.js").read_text(encoding="utf-8")

        self.assertIn('data-member-github="https://github.com/montagnahuanghsiao"', page)
        self.assertIn('data-member-github="https://github.com/work20210412-commits"', page)
        self.assertIn('data-member-github="https://github.com/jeeset"', page)
        self.assertIn('data-member-github="https://github.com/Kagamihara-Ruruka"', page)
        self.assertIn('data-member-github="https://github.com/ltmcliao-cmyk"', page)
        self.assertIn("data-member-dialog-github", page)
        self.assertIn("member-dialog-github-icon", page)
        self.assertIn("member-dialog-github-external", page)
        self.assertIn("data-member-dialog-github-handle", page)
        self.assertIn("card.dataset.memberGithub", source)
        self.assertIn("github.hidden = !githubUrl", source)
        self.assertIn('githubHandle.textContent = githubUrl.replace(/^https?:\\/\\//, "").replace(/\\/$/, "")', source)
        response.close()

    def test_detail_pages_share_footer_geometry(self) -> None:
        styles = (ROOT / "official_site" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("--site-footer-block-size: 4.5svh;", styles)
        self.assertIn(".detail-page .site-footer {", styles)
        self.assertIn("block-size: var(--site-footer-block-size);", styles)
        self.assertNotIn(".detail-page:not(.member-page) > .site-footer", styles)

        for page_name in (
            "index.html",
            "about.html",
            "data-sources.html",
            "tech-stack.html",
            "product.html",
            "member.html",
        ):
            with self.subTest(page=page_name):
                page = (ROOT / "official_site" / page_name).read_text(encoding="utf-8")
                self.assertIn('href="./styles.css?v=86"', page)

    def test_official_pages_clip_horizontal_overflow_without_nested_body_scroll(self) -> None:
        styles = (ROOT / "official_site" / "styles.css").read_text(encoding="utf-8")
        intro_styles = (ROOT / "official_site" / "intro.css").read_text(encoding="utf-8")

        self.assertRegex(styles, r"(?ms)^html\s*\{[^}]*overflow-x:\s*clip;")
        self.assertRegex(styles, r"(?ms)^body\s*\{[^}]*overflow-x:\s*clip;")
        self.assertRegex(intro_styles, r"(?ms)^html\s*\{[^}]*overflow-x:\s*clip;")
        self.assertRegex(intro_styles, r"(?ms)^body\.intro-page\s*\{[^}]*overflow-x:\s*clip;")

    def test_satellite_vertical_drag_tracks_pointer_direction(self) -> None:
        response = self.client.get("/index.html")
        page = response.get_data(as_text=True)
        source = (ROOT / "official_site" / "satellite.js").read_text(encoding="utf-8")

        self.assertIn('src="./satellite.js?v=12"', page)
        self.assertIn("targetPitch += (event.clientY - previousY)", source)
        self.assertNotIn("targetPitch -= (event.clientY - previousY)", source)
        self.assertNotIn("MathUtils.clamp(targetPitch", source)
        response.close()

    def test_site_root_must_exist(self) -> None:
        app = create_flask_app()
        missing_root = Path(__file__).parent / "missing-official-site"
        with self.assertRaises(RuntimeError):
            register_official_site_routes(app, site_root=missing_root)


if __name__ == "__main__":
    unittest.main()
