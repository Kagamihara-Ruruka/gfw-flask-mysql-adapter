from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from common_adapter.registry import KeyedRegistry


GRID_SIGNATURE_VERSION = "rrkal.grid_signature.v1"


def _canonical_number(value: Any) -> str:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return str(value)
    if not number.is_finite():
        return str(value)
    normalized = format(number.normalize(), "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"


def _canonical_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _canonical_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_canonical_value(item) for item in value]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float, Decimal)):
        return {"$number": _canonical_number(value)}
    return str(value)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


@dataclass(frozen=True)
class GridSignature:
    canonical_json: str

    @classmethod
    def from_sampled_grid(cls, sampled_grid: dict[str, Any]) -> "GridSignature":
        alignment = _mapping(sampled_grid.get("alignment"))
        geometry = _mapping(sampled_grid.get("geometry"))
        cell_identity = _mapping(sampled_grid.get("cell_identity"))
        if not alignment and not geometry:
            raise ValueError("sampled-grid contract has no alignment or geometry")
        payload = {
            "version": GRID_SIGNATURE_VERSION,
            "alignment": _canonical_value(alignment),
            "geometry": _canonical_value(geometry),
            "cell_identity": _canonical_value(cell_identity),
        }
        return cls(json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")))

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.canonical_json.encode("utf-8")).hexdigest()

    @property
    def profile_id(self) -> str:
        return f"grid.{self.digest[:16]}"


@dataclass(frozen=True)
class GridProfile:
    profile_id: str
    signature: GridSignature

    @classmethod
    def from_signature(cls, signature: GridSignature) -> "GridProfile":
        return cls(profile_id=signature.profile_id, signature=signature)

    def as_contract(self) -> dict[str, str]:
        return {
            "profile_id": self.profile_id,
            "signature": self.signature.digest,
            "signature_version": GRID_SIGNATURE_VERSION,
        }


@dataclass(frozen=True)
class GridLevelKey:
    profile_id: str
    resolution_m: int

    @classmethod
    def from_km(cls, profile: GridProfile, resolution_km: Any) -> "GridLevelKey":
        try:
            resolution_m = int(
                (Decimal(str(resolution_km)) * Decimal("1000")).to_integral_value(rounding=ROUND_HALF_UP)
            )
        except (InvalidOperation, ValueError, TypeError) as exc:
            raise ValueError("grid resolution must be numeric") from exc
        if resolution_m <= 0:
            raise ValueError("grid resolution must be positive")
        return cls(profile_id=profile.profile_id, resolution_m=resolution_m)


@dataclass(frozen=True)
class GridCellKey:
    level: GridLevelKey
    cell_id: str

    def __post_init__(self) -> None:
        if not self.cell_id.strip():
            raise ValueError("grid cell id must not be empty")


class GridRegistry:
    """Intern grid profiles derived from sampled-grid Mapping contracts."""

    def __init__(self) -> None:
        self._profiles: KeyedRegistry[GridSignature, GridProfile] = KeyedRegistry()

    def register(self, sampled_grid: dict[str, Any]) -> GridProfile:
        signature = GridSignature.from_sampled_grid(sampled_grid)
        return self._profiles.intern(signature, lambda: GridProfile.from_signature(signature))

    def __len__(self) -> int:
        return len(self._profiles)

    def profiles(self) -> tuple[GridProfile, ...]:
        return self._profiles.values()


def grid_profile_contract(sampled_grid: dict[str, Any]) -> dict[str, str]:
    return GridProfile.from_signature(GridSignature.from_sampled_grid(sampled_grid)).as_contract()
