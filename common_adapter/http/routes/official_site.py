from __future__ import annotations

from pathlib import Path

from flask import Flask, abort, send_from_directory


OFFICIAL_PAGE_FILES = (
    "about.html",
    "data-sources.html",
    "index.html",
    "intro.html",
    "member.html",
    "product.html",
    "tech-stack.html",
)

OFFICIAL_ENTRY_FILE = "intro.html"
OFFICIAL_HOME_FILE = "index.html"

OFFICIAL_ROOT_ASSETS = (
    "about-panorama.js",
    "hero-seam-sampler.js",
    "intro.css",
    "intro.js",
    "member-evolution.mmd",
    "member-evolution.svg",
    "member-evolution.js",
    "product-visual.js",
    "satellite.js",
    "script.js",
    "styles.css",
    "tech-network.js",
    "vortex-flow.js",
)


class OfficialSiteRoutes:
    """Owns the public website routes served by the consumer application."""

    def __init__(self, site_root: Path) -> None:
        self.site_root = site_root.resolve()

    def register(self, app: Flask) -> None:
        site_root = self.site_root
        for required_file in (OFFICIAL_ENTRY_FILE, OFFICIAL_HOME_FILE):
            if not (site_root / required_file).is_file():
                raise RuntimeError(f"Official site is missing {required_file}: {site_root}")

        def send_site_file(filename: str):
            target = (site_root / filename).resolve()
            if site_root not in target.parents or not target.is_file():
                abort(404)
            return send_from_directory(site_root, filename)

        @app.get("/")
        def official_site_index():
            return send_site_file(OFFICIAL_ENTRY_FILE)

        for page_name in OFFICIAL_PAGE_FILES:
            app.add_url_rule(
                f"/{page_name}",
                endpoint=f"official_site_page_{page_name.removesuffix('.html').replace('-', '_')}",
                view_func=lambda page_name=page_name: send_site_file(page_name),
                methods=["GET"],
            )

        for asset_name in OFFICIAL_ROOT_ASSETS:
            app.add_url_rule(
                f"/{asset_name}",
                endpoint=f"official_site_asset_{asset_name.replace('.', '_')}",
                view_func=lambda asset_name=asset_name: send_site_file(asset_name),
                methods=["GET"],
            )

        @app.get("/assets/<path:asset_name>")
        def official_site_asset(asset_name: str):
            return send_site_file(f"assets/{asset_name}")


def register_official_site_routes(app: Flask, *, site_root: Path) -> None:
    OfficialSiteRoutes(site_root).register(app)
