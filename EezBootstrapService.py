from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from DependencyCheck import DependencyCheckError, check_eez_postgis_dependency
from SpatialOverlay import overlay_settings, validate_identifier
from scripts.import_eez_to_postgis import import_eez

ROOT = Path(__file__).resolve().parent
DEFAULT_EEZ_SOURCE_URL = (
    "https://www.marineregions.org/download_file.php?"
    "name=World_EEZ_v12_20231025_gpkg.zip"
)
DEFAULT_EEZ_SOURCE_PAGE = "https://www.marineregions.org/downloads.php"


def _resolve_path(value: str | Path | None, *, default: str | None = None) -> Path | None:
    if value is None:
        value = default
    if value is None:
        return None
    path = Path(value)
    if path.is_absolute():
        return path
    return (ROOT / path).resolve()


def _eez_config(config: dict[str, Any]) -> dict[str, Any]:
    overlays = config.get("overlays") or {}
    eez = overlays.get("eez") or {}
    return eez if isinstance(eez, dict) else {}


def _source_config(eez: dict[str, Any]) -> dict[str, Any]:
    source = eez.get("source") or {}
    return source if isinstance(source, dict) else {}


def _target_gpkg_path(eez: dict[str, Any]) -> Path:
    source = _source_config(eez)
    configured = eez.get("full_gpkg_path") or source.get("cache_path")
    return _resolve_path(configured, default="data/eez/eez_v12.gpkg")  # type: ignore[return-value]


def _archive_path(eez: dict[str, Any]) -> Path:
    source = _source_config(eez)
    return _resolve_path(
        source.get("archive_path"),
        default="data/eez/World_EEZ_v12_20231025_gpkg.zip",
    )  # type: ignore[return-value]


def _validate_gpkg(path: Path, table: str) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(path)
    table = validate_identifier(table, "EEZ GPKG table")
    with sqlite3.connect(str(path)) as conn:
        table_row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
            (table,),
        ).fetchone()
        if table_row is None:
            raise ValueError(f"EEZ GPKG does not contain expected table: {table}")
        row_count = int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
    if row_count <= 0:
        raise ValueError(f"EEZ GPKG table is empty: {table}")
    return {"path": str(path), "table": table, "rows": row_count}


def _download_file(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "RRKAL-GFW-Adapter/1.0 (+https://www.marineregions.org/)",
        },
    )
    with tempfile.NamedTemporaryFile(
        prefix=f"{target.name}.",
        suffix=".part",
        dir=str(target.parent),
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
        with urllib.request.urlopen(request, timeout=120) as response:
            shutil.copyfileobj(response, tmp)
    tmp_path.replace(target)


def _extract_gpkg(archive_path: Path, target_path: Path) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        members = [item for item in archive.infolist() if item.filename.lower().endswith(".gpkg")]
        if not members:
            raise ValueError(f"No .gpkg file found in EEZ archive: {archive_path}")
        member = members[0]
        with archive.open(member) as source, tempfile.NamedTemporaryFile(
            prefix=f"{target_path.name}.",
            suffix=".part",
            dir=str(target_path.parent),
            delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            shutil.copyfileobj(source, tmp)
    tmp_path.replace(target_path)


def ensure_eez_source(config: dict[str, Any], *, reason: str = "manual") -> dict[str, Any]:
    eez = _eez_config(config)
    if not eez or not bool(eez.get("enabled", True)):
        return {"enabled": False, "checked": False, "reason": reason}

    gpkg_path = _target_gpkg_path(eez)
    gpkg_table = str(eez.get("gpkg_table", "eez_v12"))
    if gpkg_path.exists():
        return {"enabled": True, "downloaded": False, **_validate_gpkg(gpkg_path, gpkg_table)}

    auto_download = bool(eez.get("auto_download", True))
    if not auto_download:
        raise FileNotFoundError(
            f"EEZ GPKG is missing and auto_download is disabled: {gpkg_path}"
        )

    source = _source_config(eez)
    source_url = str(source.get("url") or DEFAULT_EEZ_SOURCE_URL)
    archive_path = _archive_path(eez)
    if not archive_path.exists():
        print(
            json.dumps(
                {
                    "status": "eez_download_start",
                    "url": source_url,
                    "target": str(archive_path),
                    "reason": reason,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        _download_file(source_url, archive_path)

    print(
        json.dumps(
            {
                "status": "eez_extract_start",
                "archive": str(archive_path),
                "target": str(gpkg_path),
                "reason": reason,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    _extract_gpkg(archive_path, gpkg_path)
    if bool(source.get("remove_archive", False)):
        archive_path.unlink(missing_ok=True)
    return {"enabled": True, "downloaded": True, **_validate_gpkg(gpkg_path, gpkg_table)}


def ensure_eez_postgis(config: dict[str, Any], *, config_path: str | None = None) -> dict[str, Any]:
    settings = overlay_settings(config)
    if not settings.get("enabled", True) or settings.get("provider") != "postgis":
        return {
            "enabled": bool(settings.get("enabled", True)),
            "provider": settings.get("provider"),
            "checked": False,
            "imported": False,
        }

    eez = _eez_config(config)
    auto_import = bool(eez.get("auto_import", True))
    try:
        ready = check_eez_postgis_dependency(config)
        return {**ready, "imported": False}
    except DependencyCheckError:
        if not auto_import:
            raise

    import_eez(config_path, replace=bool(eez.get("auto_replace", True)))
    ready = check_eez_postgis_dependency(config)
    return {**ready, "imported": True}


def ensure_eez_runtime_assets(
    config: dict[str, Any],
    *,
    config_path: str | None = None,
    reason: str = "manual",
) -> dict[str, Any]:
    source = _source_config(_eez_config(config))
    source_status = ensure_eez_source(config, reason=reason)
    postgis_status = ensure_eez_postgis(config, config_path=config_path)
    return {
        "status": "eez_runtime_assets_ready",
        "source": source_status,
        "postgis": postgis_status,
        "source_page": source.get("source_page") or DEFAULT_EEZ_SOURCE_PAGE,
    }
