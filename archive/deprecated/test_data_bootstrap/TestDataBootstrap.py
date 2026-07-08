from __future__ import annotations

import json
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent


def resolve_path(value: str | Path, *, base: Path = ROOT) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return base / path


def load_manifest(config: dict[str, Any]) -> dict[str, Any] | None:
    bootstrap = config.get("test_data_bootstrap", {})
    if not bootstrap.get("enabled", False):
        return None
    manifest_path = resolve_path(bootstrap.get("manifest", "config/test_data.example.json"))
    if not manifest_path.exists():
        raise FileNotFoundError(f"test data manifest not found: {manifest_path}")
    with manifest_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def required_paths_exist(entry: dict[str, Any]) -> bool:
    required = entry.get("required_paths", [])
    return bool(required) and all(resolve_path(path).exists() for path in required)


def download_direct_file(entry: dict[str, Any]) -> None:
    url = entry["url"]
    target = resolve_path(entry["target"])
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading_test_data={target}", flush=True)
    with urllib.request.urlopen(url, timeout=120) as response, target.open("wb") as fh:
      shutil.copyfileobj(response, fh)


def download_zip(entry: dict[str, Any]) -> None:
    archive = resolve_path(entry.get("archive", "data/test_data_download.zip"))
    download_direct_file({**entry, "target": str(archive)})
    target_dir = resolve_path(entry.get("target_dir", "data"))
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(target_dir)
    if entry.get("remove_archive", True):
        archive.unlink(missing_ok=True)


def find_7z() -> Path:
    candidates = [
        Path("C:/Program Files/7-Zip/7z.exe"),
        Path("C:/Program Files (x86)/7-Zip/7z.exe"),
    ]
    discovered = shutil.which("7z") or shutil.which("7za") or shutil.which("7zr")
    if discovered:
        candidates.insert(0, Path(discovered))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError("7z test-data archive requires 7-Zip. Install 7-Zip or put 7z.exe on PATH.")


def download_7z(entry: dict[str, Any]) -> None:
    archive = resolve_path(entry.get("archive", "data/test_data_download.7z"))
    download_direct_file({**entry, "target": str(archive)})
    target_dir = resolve_path(entry.get("target_dir", "data"))
    target_dir.mkdir(parents=True, exist_ok=True)
    seven_zip = find_7z()
    subprocess.run([str(seven_zip), "x", str(archive), f"-o{target_dir}", "-y"], check=True)
    if entry.get("remove_archive", False):
        archive.unlink(missing_ok=True)


def download_google_drive_folder(entry: dict[str, Any]) -> None:
    try:
        import gdown
    except ImportError as exc:
        raise RuntimeError("Google Drive test-data bootstrap requires gdown. Run: pip install -r requirements.txt") from exc
    target_dir = resolve_path(entry.get("target_dir", "data"))
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"downloading_google_drive_folder={target_dir}", flush=True)
    gdown.download_folder(entry["url"], output=str(target_dir), quiet=False, use_cookies=False)


def run_entry(entry: dict[str, Any]) -> None:
    if required_paths_exist(entry):
        print(f"test_data_ready={entry.get('name', entry.get('kind', 'entry'))}", flush=True)
        return
    kind = entry["kind"]
    if kind == "direct_file":
        download_direct_file(entry)
    elif kind == "zip":
        download_zip(entry)
    elif kind == "7z":
        download_7z(entry)
    elif kind == "google_drive_folder":
        download_google_drive_folder(entry)
    else:
        raise ValueError(f"unsupported test data kind: {kind}")
    if entry.get("required_paths") and not required_paths_exist(entry):
        missing = [path for path in entry["required_paths"] if not resolve_path(path).exists()]
        raise FileNotFoundError(f"test data download finished but required file(s) are missing: {missing}")


def ensure_test_data(config: dict[str, Any], *, reason: str) -> None:
    manifest = load_manifest(config)
    if not manifest:
        return
    print(f"test_data_bootstrap_reason={reason}", flush=True)
    for entry in manifest.get("entries", []):
        run_entry(entry)
