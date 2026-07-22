from __future__ import annotations

from typing import Any, Mapping


SPATIAL_INTERPOLATION_METHODS = ("nearest", "linear")
REGULAR_GRID_ENCODINGS = frozenset({"center", "global_index"})
EEZ_LAND_MASK_CAPABILITY_VERSION = "rrkal.eez_land_mask.v7"
EEZ_HIGH_SEAS_OVERLAY_CAPABILITY_VERSION = "rrkal.eez_high_seas_overlay.v5"


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return str(value or "").strip().lower()


def _value_semantics(sampled_grid: Mapping[str, Any]) -> tuple[str, str]:
    declaration = sampled_grid.get("value_semantics")
    if isinstance(declaration, str):
        return _text(declaration), "mapping"
    semantics = _mapping(declaration)
    return _text(semantics.get("kind")), _text(semantics.get("provenance")) or "mapping"


def spatial_interpolation_capability(sampled_grid: Any) -> dict[str, Any]:
    """Compile interpolation support from Scout-backed Mapping evidence."""
    descriptor = _mapping(sampled_grid)
    if not descriptor:
        return {
            "status": "unsupported",
            "methods": ["nearest"],
            "default_method": "nearest",
            "reason": "not_sampled_grid",
        }

    geometry = _mapping(descriptor.get("geometry"))
    encoding = _text(geometry.get("encoding"))
    semantics, provenance = _value_semantics(descriptor)
    if encoding not in REGULAR_GRID_ENCODINGS:
        return {
            "status": "unsupported",
            "methods": ["nearest"],
            "default_method": "nearest",
            "reason": "irregular_grid_geometry",
            "evidence": {"geometry_encoding": encoding or "unknown"},
        }
    if semantics in {"categorical", "ordinal", "identifier"}:
        return {
            "status": "unsupported",
            "methods": ["nearest"],
            "default_method": "nearest",
            "reason": "non_continuous_value_semantics",
            "evidence": {
                "geometry_encoding": encoding,
                "value_semantics": semantics,
                "provenance": provenance,
            },
        }
    if semantics != "continuous":
        return {
            "status": "unknown",
            "methods": ["nearest"],
            "default_method": "nearest",
            "reason": "value_semantics_unresolved",
            "evidence": {
                "geometry_encoding": encoding,
                "value_semantics": semantics or "unknown",
                "provenance": provenance,
            },
        }
    return {
        "status": "supported",
        "methods": list(SPATIAL_INTERPOLATION_METHODS),
        "default_method": "linear",
        "render_only": True,
        "null_policy": "ignore",
        "evidence": {
            "geometry_encoding": encoding,
            "value_semantics": semantics,
            "provenance": provenance,
        },
    }


def land_mask_consumer_capability(sampled_grid: Any) -> dict[str, Any]:
    """Compile marine-mask eligibility from Scout-backed spatial-domain evidence."""
    descriptor = _mapping(sampled_grid)
    domain = _mapping(descriptor.get("spatial_domain"))
    kind = _text(domain.get("kind"))
    provenance = _text(domain.get("provenance")) or "mapping"
    if not descriptor:
        return {"status": "unsupported", "reason": "not_sampled_grid"}
    if kind != "marine":
        return {
            "status": "unsupported" if kind else "unknown",
            "reason": "non_marine_domain" if kind else "spatial_domain_unresolved",
            "evidence": {"spatial_domain": kind or "unknown", "provenance": provenance},
        }
    return {
        "status": "supported",
        "provider_layer_id": "eez",
        "provider_capability": "land_mask_provider",
        "render_only": True,
        "evidence": {"spatial_domain": kind, "provenance": provenance},
    }


def _eez_domain_provider_context(
    route_config: Any,
    overlay_ref: Any,
) -> tuple[Mapping[str, Any] | None, str, dict[str, Any] | None]:
    if _text(overlay_ref) != "eez":
        return None, "", {"status": "unsupported", "reason": "not_eez"}
    route = _mapping(route_config)
    eez = _mapping(_mapping(route.get("overlays")).get("eez"))
    source = _mapping(eez.get("source"))
    domain_mask = _mapping(eez.get("domain_mask"))
    source_version = str(source.get("version") or "").strip()
    if not eez.get("enabled", True) or domain_mask.get("enabled", True) is False:
        return None, source_version, {"status": "unsupported", "reason": "disabled"}
    if _text(eez.get("provider")) != "postgis":
        return None, source_version, {
            "status": "unsupported",
            "reason": "postgis_geometry_required",
        }
    if not source_version:
        return None, "", {"status": "unknown", "reason": "source_version_unresolved"}
    return eez, source_version, None


def eez_land_mask_provider_capability(route_config: Any, overlay_ref: Any) -> dict[str, Any]:
    """Declare the EEZ-owned derived land-mask child capability."""
    eez, source_version, error = _eez_domain_provider_context(route_config, overlay_ref)
    if error:
        return error
    domain_mask = _mapping(eez.get("domain_mask") if eez else None)
    try:
        tile_request_concurrency = max(1, int(domain_mask.get("tile_query_concurrency") or 2))
    except (TypeError, ValueError):
        tile_request_concurrency = 2
    try:
        tile_timeout_ms = max(1000, int(domain_mask.get("tile_timeout_ms") or 45000))
    except (TypeError, ValueError):
        tile_timeout_ms = 45000
    return {
        "status": "supported",
        "capability_version": EEZ_LAND_MASK_CAPABILITY_VERSION,
        "provider": "eez_complement",
        "source_version": source_version,
        "tile_template": "/api/overlays/eez/domain/land/tiles/{z}/{x}/{y}.svg",
        "tile_request_concurrency": tile_request_concurrency,
        "tile_timeout_ms": tile_timeout_ms,
        "geometry_source": "eez_lod",
        "lod_owner": "eez",
        "topology_classification": "versioned_seed_tuple",
        "render_only": True,
    }


def eez_high_seas_overlay_capability(route_config: Any, overlay_ref: Any) -> dict[str, Any]:
    """Declare the EEZ-owned High Seas overlay and its UI paint contract."""
    _eez, source_version, error = _eez_domain_provider_context(route_config, overlay_ref)
    if error:
        return error
    return {
        "status": "supported",
        "capability_version": EEZ_HIGH_SEAS_OVERLAY_CAPABILITY_VERSION,
        "provider": "eez_complement",
        "source_version": source_version,
        "tile_template": "/api/overlays/eez/domain/high_seas/tiles/{z}/{x}/{y}.svg",
        "geometry_source": "eez_lod",
        "lod_owner": "eez",
        "classification": "versioned_seed_tuple",
        "paint": {
            "kind": "solid_fill",
            "controls": ["fill_color"],
            "default_color": "#5578a8",
        },
        "render_only": True,
    }
