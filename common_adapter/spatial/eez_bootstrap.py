from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import time
import urllib.request
import zipfile
import http.client
from html.parser import HTMLParser
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

from common_adapter.spatial.dependency import DependencyCheckError, check_eez_postgis_dependency
from common_adapter.spatial.overlay import overlay_settings, validate_identifier
from scripts.import_eez_to_postgis import import_eez

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EEZ_SOURCE_URL = (
    "https://www.marineregions.org/download_file.php?"
    "name=World_EEZ_v12_20231025_gpkg.zip"
)
DEFAULT_EEZ_SOURCE_PAGE = "https://www.marineregions.org/downloads.php"
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
DOWNLOAD_PROGRESS_BYTES = 25 * 1024 * 1024
DEFAULT_MARINE_REGIONS_FORM = {
    "name": "RRKAL Common Adapter",
    "organisation": "RRKAL",
    "email": "rrkal.common.adapter@example.com",
    "country": "Taiwan (Province of China)",
    "user_category": "academia",
    "purpose_category": "Data exploration & testing",
    "agree": "1",
}


class DownloadFormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.inputs: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "input":
            self.inputs.append({key: value or "" for key, value in attrs})


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


def _request_headers(*, referer: str | None = None, accept: str = "*/*") -> dict[str, str]:
    headers = {
        "User-Agent": "RRKAL-Common-Adapter/1.0 (+https://www.marineregions.org/)",
        "Accept": accept,
    }
    if referer:
        headers["Referer"] = referer
        parsed = urlparse(referer)
        if parsed.scheme and parsed.netloc:
            headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
    return headers


def _form_fields(source: dict[str, Any], html: str) -> dict[str, str]:
    configured = source.get("form") if isinstance(source.get("form"), dict) else {}
    fields = {key: str(value) for key, value in {**DEFAULT_MARINE_REGIONS_FORM, **configured}.items()}
    parser = DownloadFormParser()
    parser.feed(html)
    for item in parser.inputs:
        name = item.get("name", "")
        if not name:
            continue
        input_type = item.get("type", "text").lower()
        if input_type in {"submit", "button"}:
            continue
        fields.setdefault(name, item.get("value", ""))
    fields.setdefault("submit", "Download")
    return fields


def _looks_like_marine_regions_form(url: str, sample: str) -> bool:
    host = urlparse(url).netloc.lower()
    return "marineregions.org" in host and "Marine Regions Download file" in sample


def _part_path(target: Path) -> Path:
    return target.with_name(f"{target.name}.part")


def _download_response_packet(
    *,
    stage: str,
    url: str,
    target: Path,
    response,
    mode: str,
    initial_bytes: int,
) -> dict[str, Any]:
    return {
        "status": "eez_download_response",
        "stage": stage,
        "url": url,
        "target": str(target),
        "http_status": int(getattr(response, "status", 0) or 0),
        "content_type": response.headers.get("Content-Type"),
        "content_length": response.headers.get("Content-Length"),
        "content_range": response.headers.get("Content-Range"),
        "mode": mode,
        "initial_bytes": initial_bytes,
    }


def _write_response_to_temp(
    response,
    tmp_path: Path,
    *,
    stage: str,
    url: str,
    target: Path,
    mode: str = "wb",
    initial_bytes: int = 0,
) -> None:
    written = initial_bytes if mode == "ab" else 0
    last_reported = written
    with tmp_path.open(mode) as fh:
        while True:
            chunk = response.read(DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            fh.write(chunk)
            written += len(chunk)
            if written - last_reported >= DOWNLOAD_PROGRESS_BYTES:
                print(
                    json.dumps(
                        {
                            "status": "eez_download_progress",
                            "stage": stage,
                            "url": url,
                            "target": str(target),
                            "bytes": written,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                last_reported = written


def _download_marine_regions_form(url: str, target: Path, source: dict[str, Any], html: str) -> None:
    cookie_jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    opener.open(
        urllib.request.Request(url, headers=_request_headers(accept="text/html,*/*")),
        timeout=120,
    ).close()
    payload = urlencode(_form_fields(source, html)).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            **_request_headers(referer=url, accept="application/zip,*/*"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    tmp_path = _part_path(target)
    try:
        with opener.open(request, timeout=120) as response:
            print(
                json.dumps(
                    _download_response_packet(
                        stage="marine_regions_form",
                        url=url,
                        target=target,
                        response=response,
                        mode="wb",
                        initial_bytes=0,
                    ),
                    ensure_ascii=False,
                ),
                flush=True,
            )
            _write_response_to_temp(
                response,
                tmp_path,
                stage="marine_regions_form",
                url=url,
                target=target,
            )
        if not zipfile.is_zipfile(tmp_path):
            sample = tmp_path.read_bytes()[:500].decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                "Marine Regions form submission did not return a zip archive. "
                f"url={url!r} sample={sample[:240]!r}"
            )
        tmp_path.replace(target)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _download_file_once(url: str, target: Path, *, source: dict[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = _part_path(target)
    existing_bytes = tmp_path.stat().st_size if tmp_path.exists() else 0
    headers = _request_headers(accept="application/zip,*/*")
    if existing_bytes > 0:
        headers["Range"] = f"bytes={existing_bytes}-"
    request = urllib.request.Request(
        url,
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        status = int(getattr(response, "status", 200))
        mode = "ab" if existing_bytes > 0 and status == 206 else "wb"
        initial_bytes = existing_bytes if mode == "ab" else 0
        print(
            json.dumps(
                _download_response_packet(
                    stage="direct",
                    url=url,
                    target=target,
                    response=response,
                    mode=mode,
                    initial_bytes=initial_bytes,
                ),
                ensure_ascii=False,
            ),
            flush=True,
        )
        _write_response_to_temp(
            response,
            tmp_path,
            stage="direct",
            url=url,
            target=target,
            mode=mode,
            initial_bytes=initial_bytes,
        )
    if not zipfile.is_zipfile(tmp_path):
        raw = tmp_path.read_bytes()
        sample = raw[:500].decode("utf-8", errors="replace").strip()
        tmp_path.unlink(missing_ok=True)
        if _looks_like_marine_regions_form(url, sample):
            _download_marine_regions_form(url, target, source, raw.decode("utf-8", errors="replace"))
            return
        raise RuntimeError(
            "EEZ download did not return a zip archive. "
            "Configure a direct zip URL or a supported automated source form. "
            f"url={url!r} sample={sample[:240]!r}"
        )
    tmp_path.replace(target)


def _download_file(url: str, target: Path, *, source: dict[str, Any]) -> None:
    retry_seconds = max(1.0, float(source.get("retry_seconds", 15)))
    max_attempts = max(0, int(source.get("max_attempts", 0)))
    attempt = 1
    while True:
        try:
            _download_file_once(url, target, source=source)
            return
        except (
            TimeoutError,
            ConnectionError,
            urllib.error.URLError,
            http.client.IncompleteRead,
        ) as exc:
            if max_attempts and attempt >= max_attempts:
                raise
            print(
                json.dumps(
                    {
                        "status": "eez_download_retry",
                        "url": url,
                        "target": str(target),
                        "attempt": attempt,
                        "retry_seconds": retry_seconds,
                        "error": str(exc),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            time.sleep(retry_seconds)
            attempt += 1


def _extract_gpkg(archive_path: Path, target_path: Path) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        members = [item for item in archive.infolist() if item.filename.lower().endswith(".gpkg")]
        if not members:
            raise ValueError(f"No .gpkg file found in EEZ archive: {archive_path}")
        target_name = target_path.name.lower()
        member = next(
            (item for item in members if Path(item.filename).name.lower() == target_name),
            members[0],
        )
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
        _download_file(source_url, archive_path, source=source)
    elif not zipfile.is_zipfile(archive_path):
        archive_path.unlink(missing_ok=True)
        raise RuntimeError(
            "Cached EEZ archive is not a zip file. The bad cache was removed; rerun the EEZ bootstrap "
            f"with an automated form source or a direct zip URL: {archive_path}"
        )

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
    except DependencyCheckError as dependency_error:
        try:
            from common_adapter.spatial.lod import ensure_eez_fill_table

            ensure_eez_fill_table(config)
            ready = check_eez_postgis_dependency(config)
            return {**ready, "imported": False, "derived": True}
        except Exception:
            if not auto_import:
                raise dependency_error

    import_eez(config_path, replace=bool(eez.get("auto_replace", True)))
    ready = check_eez_postgis_dependency(config)
    return {**ready, "imported": True}


def ensure_eez_runtime_assets(
    config: dict[str, Any],
    *,
    config_path: str | None = None,
    reason: str = "manual",
) -> dict[str, Any]:
    eez = _eez_config(config)
    source = _source_config(eez)
    source_status = ensure_eez_source(config, reason=reason)
    postgis_status = ensure_eez_postgis(config, config_path=config_path)
    return {
        "status": "eez_runtime_assets_ready",
        "source": source_status,
        "postgis": postgis_status,
        "source_page": source.get("source_page") or DEFAULT_EEZ_SOURCE_PAGE,
    }
