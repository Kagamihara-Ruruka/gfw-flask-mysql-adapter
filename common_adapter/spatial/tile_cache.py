from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4


TileCacheKey = tuple[Any, ...]
TileCacheValue = tuple[bytes, dict[str, Any]]


class MvtTileCache:
    def __init__(self) -> None:
        self._memory: OrderedDict[TileCacheKey, TileCacheValue] = OrderedDict()
        self._disk_counts: dict[Path, int] = {}
        self._lock = RLock()

    @staticmethod
    def _digest(key: TileCacheKey) -> str:
        payload = json.dumps(key, ensure_ascii=True, separators=(",", ":"), default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @classmethod
    def _paths(cls, directory: Path, key: TileCacheKey) -> tuple[Path, Path]:
        digest = cls._digest(key)
        tile_path = directory / digest[:2] / f"{digest}.pbf"
        return tile_path, tile_path.with_suffix(".json")

    def _remember(self, key: TileCacheKey, value: TileCacheValue, max_entries: int) -> None:
        self._memory[key] = value
        self._memory.move_to_end(key)
        while len(self._memory) > max_entries:
            self._memory.popitem(last=False)

    @staticmethod
    def _hit(value: TileCacheValue, *, tier: str, tile_ms: float) -> TileCacheValue:
        tile, meta = value
        hit_meta = dict(meta)
        hit_meta["cache"] = "hit"
        hit_meta["cache_tier"] = tier
        hit_meta["timing"] = {"tile_ms": tile_ms}
        return tile, hit_meta

    def get(
        self,
        key: TileCacheKey,
        *,
        max_entries: int,
        directory: Path | None,
    ) -> TileCacheValue | None:
        if max_entries <= 0:
            return None
        with self._lock:
            cached = self._memory.get(key)
            if cached is not None:
                self._memory.move_to_end(key)
                return self._hit(cached, tier="memory", tile_ms=0.0)
        if directory is None:
            return None

        tile_path, meta_path = self._paths(directory, key)
        if not tile_path.is_file() or not meta_path.is_file():
            return None
        started = time.perf_counter()
        try:
            tile = tile_path.read_bytes()
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if not isinstance(meta, dict):
                raise ValueError("tile cache metadata must be an object")
        except (OSError, ValueError, json.JSONDecodeError):
            with self._lock:
                tile_path.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
                self._disk_counts.pop(directory, None)
            return None

        value = (tile, meta)
        with self._lock:
            self._remember(key, value, max_entries)
        read_ms = round((time.perf_counter() - started) * 1000, 3)
        return self._hit(value, tier="disk", tile_ms=read_ms)

    @staticmethod
    def _atomic_write(path: Path, payload: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_bytes(payload)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def _trim_disk(self, directory: Path, max_entries: int) -> None:
        count = self._disk_counts.get(directory)
        if count is None:
            count = sum(1 for _ in directory.rglob("*.pbf"))
            self._disk_counts[directory] = count
        if count <= max_entries:
            return

        tiles = sorted(directory.rglob("*.pbf"), key=lambda path: path.stat().st_mtime_ns)
        for tile_path in tiles[: count - max_entries]:
            tile_path.unlink(missing_ok=True)
            tile_path.with_suffix(".json").unlink(missing_ok=True)
        self._disk_counts[directory] = min(count, max_entries)

    def set(
        self,
        key: TileCacheKey,
        value: TileCacheValue,
        *,
        max_entries: int,
        directory: Path | None,
    ) -> None:
        if max_entries <= 0:
            return
        with self._lock:
            self._remember(key, value, max_entries)
            if directory is None:
                return

            tile, meta = value
            tile_path, meta_path = self._paths(directory, key)
            existed = tile_path.is_file()
            self._atomic_write(tile_path, tile)
            self._atomic_write(
                meta_path,
                json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            if not existed:
                if directory in self._disk_counts:
                    self._disk_counts[directory] += 1
            self._trim_disk(directory, max_entries)
