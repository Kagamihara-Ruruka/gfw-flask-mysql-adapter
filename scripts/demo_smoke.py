from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


REQUIRED_HTML_MARKERS = (
    'data-page-panel="dashboard"',
    'data-page-panel="settings"',
    'id="date"',
    'id="start-date"',
    'id="end-date"',
    'id="play-toggle"',
    'id="play-speed"',
    'id="pipeline-timeline"',
    'id="metrics-summary"',
    'id="records"',
    'id="playback-rate"',
    'id="playback-step-mode"',
    'id="playback-cache-mode"',
    "playback-scheduler.js",
    "playback-frame-buffer.js",
    "playback-renderer.js",
    "playback-telemetry.js",
    "playback-interpolation-controller.js",
    "playback-prefetch-controller.js",
    "gfw-layer-effects.js",
)

REQUIRED_SCRIPT_ORDER = (
    "TimingMetrics.js",
    "render-intent-service.js",
    "gfw-record-cache.js",
    "playback-cache-service.js",
    "playback-scheduler.js",
    "playback-frame-buffer.js",
    "playback-renderer.js",
    "playback-telemetry.js",
    "playback-interpolation-controller.js",
    "playback-prefetch-controller.js",
    "playback-controls.js",
)

REQUIRED_LAYER_SCRIPT_ORDER = (
    "gfw-layer-effects.js",
    "gfw-layer.js",
)


class SmokeFailure(AssertionError):
    pass


def normalize_base_url(value: str) -> str:
    return value.rstrip("/")


def fetch(base_url: str, path: str, *, timeout: float) -> tuple[int, bytes]:
    url = f"{base_url}{path}"
    request = urllib.request.Request(url, headers={"Accept": "application/json,text/html,*/*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read()
        raise SmokeFailure(f"GET {path} returned HTTP {exc.code}: {body[:300]!r}") from exc
    except urllib.error.URLError as exc:
        raise SmokeFailure(f"GET {path} failed: {exc.reason}") from exc


def fetch_text(base_url: str, path: str, *, timeout: float) -> str:
    status, body = fetch(base_url, path, timeout=timeout)
    if status != 200:
        raise SmokeFailure(f"GET {path} returned HTTP {status}")
    return body.decode("utf-8", errors="strict")


def fetch_json(base_url: str, path: str, *, timeout: float) -> dict[str, Any]:
    text = fetch_text(base_url, path, timeout=timeout)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SmokeFailure(f"GET {path} did not return JSON: {text[:300]!r}") from exc
    if not isinstance(payload, dict):
        raise SmokeFailure(f"GET {path} returned non-object JSON")
    return payload


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def check_marker_order(html: str, markers: tuple[str, ...], label: str) -> None:
    positions = []
    for marker in markers:
        position = html.find(marker)
        require(position >= 0, f"root HTML missing {label} marker: {marker}")
        positions.append((marker, position))
    for (previous, previous_pos), (current, current_pos) in zip(positions, positions[1:]):
        require(
            previous_pos < current_pos,
            f"root HTML has invalid {label} order: {previous} should load before {current}",
        )


def check_root_html(base_url: str, *, timeout: float) -> None:
    html = fetch_text(base_url, "/", timeout=timeout)
    missing = [marker for marker in REQUIRED_HTML_MARKERS if marker not in html]
    require(not missing, f"root HTML missing demo markers: {', '.join(missing)}")
    print(f"[ok] root HTML contains {len(REQUIRED_HTML_MARKERS)} demo markers")
    check_marker_order(html, REQUIRED_SCRIPT_ORDER, "playback script")
    check_marker_order(html, REQUIRED_LAYER_SCRIPT_ORDER, "layer script")
    print("[ok] root HTML preserves playback/layer script order")


def check_health(base_url: str, *, timeout: float) -> None:
    health = fetch_json(base_url, "/api/health", timeout=timeout)
    require(health.get("status") == "ok", f"health status is not ok: {health!r}")
    require(isinstance(health.get("datasets"), list) and health["datasets"], "health reports no datasets")
    print(f"[ok] health status ok, datasets={','.join(health['datasets'])}")


def check_render_capability(base_url: str, *, timeout: float) -> None:
    packet = fetch_json(base_url, "/api/render/capability", timeout=timeout)
    require(packet.get("status") == "ok", f"render capability status is not ok: {packet!r}")
    policy = packet.get("policy")
    require(isinstance(policy, dict), "render capability missing policy")
    require("allow_webgl" in policy, "render capability policy missing allow_webgl")
    print(f"[ok] render capability policy allow_webgl={policy.get('allow_webgl')}")


def check_dataset_contract(base_url: str, dataset_id: str | None, *, timeout: float) -> tuple[str, list[str]]:
    packet = fetch_json(base_url, "/api/datasets", timeout=timeout)
    datasets = packet.get("datasets")
    require(isinstance(datasets, dict) and datasets, "datasets endpoint returned no datasets")
    selected = dataset_id or packet.get("default_dataset")
    require(isinstance(selected, str) and selected in datasets, f"dataset {selected!r} is not available")
    require(datasets[selected].get("layer_id") == "gfw", f"dataset {selected!r} is not a GFW demo layer")

    schema = fetch_json(base_url, f"/api/datasets/{urllib.parse.quote(selected)}/schema", timeout=timeout)
    dates = schema.get("dates")
    require(isinstance(dates, list) and dates, f"schema for {selected!r} has no dates")
    require(isinstance(schema.get("bounds"), dict), f"schema for {selected!r} has no bounds")
    print(f"[ok] dataset {selected} schema dates={dates[0]}..{dates[-1]}")
    return selected, [str(date) for date in dates]


def check_records_snapshot(base_url: str, dataset_id: str, date_value: str, *, timeout: float) -> None:
    params = urllib.parse.urlencode({"date": date_value, "limit": "1", "columns": "render"})
    packet = fetch_json(base_url, f"/api/datasets/{urllib.parse.quote(dataset_id)}/records?{params}", timeout=timeout)
    rows = packet.get("rows")
    require(isinstance(rows, list), "records endpoint missing rows list")
    require(int(packet.get("row_count") or 0) >= len(rows), "records row_count is smaller than returned rows")
    require("timing" in packet, "records endpoint missing timing packet")
    print(f"[ok] records snapshot {date_value} rows={len(rows)} row_count={packet.get('row_count')}")


def check_records_range(base_url: str, dataset_id: str, dates: list[str], *, timeout: float) -> None:
    if len(dates) < 2:
        print("[skip] records range smoke needs at least two dates")
        return
    params = urllib.parse.urlencode(
        {"start": dates[0], "end": dates[1], "limit": "1", "columns": "render"}
    )
    packet = fetch_json(base_url, f"/api/datasets/{urllib.parse.quote(dataset_id)}/records/range?{params}", timeout=timeout)
    snapshots = packet.get("snapshots")
    require(isinstance(snapshots, dict), "range endpoint missing snapshots object")
    require(int(packet.get("snapshot_count") or 0) >= 1, "range endpoint returned no snapshots")
    require("timing" in packet, "range endpoint missing timing packet")
    print(
        f"[ok] records range {dates[0]}..{dates[1]} "
        f"snapshot_count={packet.get('snapshot_count')} row_count={packet.get('row_count')}"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run demo-critical smoke checks against a running adapter.")
    parser.add_argument("--base-url", default="http://127.0.0.1:5081", help="Adapter base URL.")
    parser.add_argument("--dataset", default=None, help="Dataset id to validate. Defaults to API default_dataset.")
    parser.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout in seconds.")
    parser.add_argument("--skip-records", action="store_true", help="Skip records endpoint checks.")
    parser.add_argument("--skip-range", action="store_true", help="Skip range endpoint check.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    base_url = normalize_base_url(args.base_url)
    try:
        check_root_html(base_url, timeout=args.timeout)
        check_health(base_url, timeout=args.timeout)
        check_render_capability(base_url, timeout=args.timeout)
        dataset_id, dates = check_dataset_contract(base_url, args.dataset, timeout=args.timeout)
        if not args.skip_records:
            check_records_snapshot(base_url, dataset_id, dates[0], timeout=args.timeout)
            if not args.skip_range:
                check_records_range(base_url, dataset_id, dates, timeout=args.timeout)
    except SmokeFailure as exc:
        print(f"[fail] {exc}", file=sys.stderr)
        return 1
    print("[ok] demo smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
