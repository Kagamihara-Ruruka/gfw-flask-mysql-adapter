from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from threading import Event, RLock
from typing import Any, Callable, Hashable


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _freeze(value: Any) -> Hashable:
    if isinstance(value, dict):
        return tuple(sorted((str(key), _freeze(nested)) for key, nested in value.items()))
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set):
        return tuple(sorted(_freeze(item) for item in value))
    try:
        hash(value)
    except TypeError:
        return repr(value)
    return value


def _payload_row_weight(payload: Any) -> int:
    rows = _mapping(payload).get("rows")
    if isinstance(rows, (list, tuple)):
        return max(1, len(rows))
    return 1


@dataclass(frozen=True)
class SnapshotCachePolicy:
    enabled: bool
    identity_roles: tuple[str, ...]
    max_entries: int
    ttl_seconds: float | None

    @classmethod
    def from_contract(cls, contract: dict[str, Any]) -> "SnapshotCachePolicy":
        raw = _mapping(contract.get("snapshot_cache"))
        if not raw or not bool(raw.get("enabled")):
            return cls(False, (), 0, None)
        roles = tuple(
            str(role).strip()
            for role in raw.get("identity_roles") or []
            if str(role).strip()
        )
        if not roles:
            raise ValueError("snapshot_cache.identity_roles is required when cache is enabled")
        if len(set(roles)) != len(roles):
            raise ValueError("snapshot_cache.identity_roles must be unique")
        try:
            max_entries = int(raw.get("max_entries"))
        except (TypeError, ValueError) as exc:
            raise ValueError("snapshot_cache.max_entries must be a positive integer") from exc
        if max_entries < 1:
            raise ValueError("snapshot_cache.max_entries must be a positive integer")
        ttl_value = raw.get("ttl_seconds")
        if ttl_value in (None, ""):
            ttl_seconds = None
        else:
            try:
                ttl_seconds = float(ttl_value)
            except (TypeError, ValueError) as exc:
                raise ValueError("snapshot_cache.ttl_seconds must be positive or null") from exc
            if ttl_seconds <= 0:
                raise ValueError("snapshot_cache.ttl_seconds must be positive or null")
        return cls(True, roles, max_entries, ttl_seconds)

    def key(self, identity: dict[str, Any]) -> tuple[tuple[str, Hashable], ...]:
        missing = [role for role in self.identity_roles if role not in identity]
        if missing:
            raise ValueError(f"snapshot identity is missing canonical roles: {', '.join(missing)}")
        return tuple((role, _freeze(identity[role])) for role in self.identity_roles)


@dataclass(frozen=True)
class SnapshotLoad:
    actual_identity: dict[str, Any]
    payload: Any
    cache_hit: bool = False
    waited: bool = False


@dataclass
class _CacheEntry:
    identity: dict[str, Any]
    payload: Any
    created_at: float
    row_weight: int


@dataclass
class _InflightLoad:
    event: Event
    result: SnapshotLoad | None = None
    error: BaseException | None = None


class CanonicalSnapshotCache:
    """Caches mapped snapshots by canonical identity, never by source fields."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._entries: dict[str, OrderedDict[tuple, _CacheEntry]] = {}
        self._aliases: dict[str, dict[tuple, tuple]] = {}
        self._inflight: dict[tuple[str, tuple], _InflightLoad] = {}
        self._global_lru: OrderedDict[tuple[str, tuple], None] = OrderedDict()
        self._max_total_rows: int | None = None
        self._total_rows = 0

    def configure(self, *, max_total_rows: int | None) -> None:
        if max_total_rows is not None and max_total_rows < 1:
            raise ValueError("snapshot cache max_total_rows must be positive or null")
        with self._lock:
            self._max_total_rows = max_total_rows
            self._trim_global_locked()

    def _expired(self, entry: _CacheEntry, policy: SnapshotCachePolicy) -> bool:
        return policy.ttl_seconds is not None and time.monotonic() - entry.created_at > policy.ttl_seconds

    def _remove_locked(self, namespace: str, key: tuple) -> None:
        entries = self._entries.get(namespace)
        if entries is not None:
            entry = entries.pop(key, None)
            if entry is not None:
                self._total_rows = max(0, self._total_rows - entry.row_weight)
            if not entries:
                self._entries.pop(namespace, None)
        self._global_lru.pop((namespace, key), None)
        aliases = self._aliases.get(namespace)
        if aliases is not None:
            for alias, target in list(aliases.items()):
                if alias == key or target == key:
                    aliases.pop(alias, None)
            if not aliases:
                self._aliases.pop(namespace, None)

    def _touch_global_locked(self, namespace: str, key: tuple) -> None:
        global_key = (namespace, key)
        self._global_lru[global_key] = None
        self._global_lru.move_to_end(global_key)

    def _trim_global_locked(self) -> None:
        if self._max_total_rows is None:
            return
        while self._total_rows > self._max_total_rows and len(self._global_lru) > 1:
            namespace, key = next(iter(self._global_lru))
            self._remove_locked(namespace, key)

    def _resolve_locked(
        self,
        namespace: str,
        policy: SnapshotCachePolicy,
        key: tuple,
    ) -> SnapshotLoad | None:
        entries = self._entries.get(namespace)
        if not entries:
            return None
        aliases = self._aliases.setdefault(namespace, {})
        actual_key = aliases.get(key, key)
        entry = entries.get(actual_key)
        if entry is None:
            aliases.pop(key, None)
            return None
        if self._expired(entry, policy):
            self._remove_locked(namespace, actual_key)
            return None
        entries.move_to_end(actual_key)
        self._touch_global_locked(namespace, actual_key)
        return SnapshotLoad(dict(entry.identity), entry.payload, cache_hit=True)

    def get(
        self,
        namespace: str,
        policy: SnapshotCachePolicy,
        identity: dict[str, Any],
    ) -> SnapshotLoad | None:
        if not policy.enabled:
            return None
        key = policy.key(identity)
        with self._lock:
            return self._resolve_locked(namespace, policy, key)

    def _remember_locked(
        self,
        namespace: str,
        policy: SnapshotCachePolicy,
        requested_key: tuple,
        loaded: SnapshotLoad,
    ) -> SnapshotLoad:
        actual_key = policy.key(loaded.actual_identity)
        if actual_key in self._entries.get(namespace, {}):
            self._remove_locked(namespace, actual_key)
        entries = self._entries.setdefault(namespace, OrderedDict())
        row_weight = _payload_row_weight(loaded.payload)
        entries[actual_key] = _CacheEntry(
            identity=dict(loaded.actual_identity),
            payload=loaded.payload,
            created_at=time.monotonic(),
            row_weight=row_weight,
        )
        self._total_rows += row_weight
        entries.move_to_end(actual_key)
        self._touch_global_locked(namespace, actual_key)
        aliases = self._aliases.setdefault(namespace, {})
        if requested_key != actual_key:
            aliases[requested_key] = actual_key
        while len(entries) > policy.max_entries:
            stale_key = next(iter(entries))
            self._remove_locked(namespace, stale_key)
        self._trim_global_locked()
        return SnapshotLoad(
            dict(loaded.actual_identity),
            loaded.payload,
            cache_hit=loaded.cache_hit,
            waited=loaded.waited,
        )

    def get_or_load(
        self,
        namespace: str,
        policy: SnapshotCachePolicy,
        requested_identity: dict[str, Any],
        loader: Callable[[], SnapshotLoad],
    ) -> SnapshotLoad:
        if not policy.enabled:
            return loader()
        requested_key = policy.key(requested_identity)
        inflight_key = (namespace, requested_key)
        with self._lock:
            cached = self._resolve_locked(namespace, policy, requested_key)
            if cached is not None:
                return cached
            inflight = self._inflight.get(inflight_key)
            owner = inflight is None
            if inflight is None:
                inflight = _InflightLoad(Event())
                self._inflight[inflight_key] = inflight
        if not owner:
            inflight.event.wait()
            if inflight.error is not None:
                raise inflight.error
            if inflight.result is None:
                raise RuntimeError("snapshot cache load completed without a result")
            return replace(inflight.result, cache_hit=True, waited=True)

        try:
            loaded = loader()
            with self._lock:
                result = self._remember_locked(namespace, policy, requested_key, loaded)
                inflight.result = result
            return result
        except BaseException as exc:
            with self._lock:
                inflight.error = exc
            raise
        finally:
            with self._lock:
                self._inflight.pop(inflight_key, None)
                inflight.event.set()

    def clear(self, namespace: str | None = None) -> None:
        with self._lock:
            if namespace is None:
                self._entries.clear()
                self._aliases.clear()
                self._global_lru.clear()
                self._total_rows = 0
                return
            for key in list(self._entries.get(namespace, {})):
                self._remove_locked(namespace, key)

    def entry_count(self, namespace: str) -> int:
        with self._lock:
            return len(self._entries.get(namespace, ()))

    def stats(self, namespace: str | None = None) -> dict[str, int | None]:
        with self._lock:
            return {
                "namespace_entries": len(self._entries.get(namespace, ())) if namespace else 0,
                "total_entries": len(self._global_lru),
                "total_rows": self._total_rows,
                "max_total_rows": self._max_total_rows,
            }


CANONICAL_SNAPSHOT_CACHE = CanonicalSnapshotCache()
