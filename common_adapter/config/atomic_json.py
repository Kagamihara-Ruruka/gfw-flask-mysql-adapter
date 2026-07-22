from __future__ import annotations

import json
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


_PROCESS_LOCKS: dict[Path, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


def _process_lock(path: Path) -> threading.RLock:
    resolved = path.resolve()
    with _PROCESS_LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(resolved, threading.RLock())


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Serialize control-plane writes in-process and across host processes."""

    lock_path = path.with_name(f"{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    process_lock = _process_lock(lock_path)
    with process_lock:
        with lock_path.open("a+b") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                try:
                    yield
                finally:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def atomic_write_json(path: Path, value: dict[str, Any], *, keep_last_known_good: bool = True) -> None:
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with file_lock(path):
        atomic_write_text(path, content)
        if keep_last_known_good:
            atomic_write_text(last_known_good_path(path), content)


def last_known_good_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.lkg")


def read_json_object(
    path: Path,
    *,
    missing: dict[str, Any] | None = None,
    allow_last_known_good: bool = True,
) -> dict[str, Any]:
    if not path.exists():
        return dict(missing or {})
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(value, dict):
            raise ValueError(f"JSON root must be an object: {path}")
        return value
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        fallback_path = last_known_good_path(path)
        if allow_last_known_good and fallback_path.exists():
            fallback = json.loads(fallback_path.read_text(encoding="utf-8-sig"))
            if isinstance(fallback, dict):
                return fallback
        raise ValueError(f"invalid control-plane JSON: {path}: {exc}") from exc
