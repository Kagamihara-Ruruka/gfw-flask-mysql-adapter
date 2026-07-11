from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from common_adapter.developer.probes.endpoint import endpoint_status_from_config


class MockServingHandler(BaseHTTPRequestHandler):
    catalog_payload: Any = {
        "datasets": [{"id": "gfw", "label": "GFW"}],
        "metrics": ["fishing_hours"],
    }
    mode = "catalog"

    def do_GET(self) -> None:
        if self.path == "/api/v1/catalog" and self.mode == "catalog":
            self.write_json(200, self.catalog_payload)
            return
        if self.path == "/api/v1/catalog" and self.mode == "non_json":
            self.write_text(200, "not json", content_type="text/plain")
            return
        if self.path == "/api/v1/health":
            self.write_json(200, {"ok": True})
            return
        self.write_text(404, "not found")

    def write_json(self, status_code: int, payload: Any) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def write_text(self, status_code: int, text: str, *, content_type: str = "text/plain") -> None:
        raw = text.encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_: Any) -> None:
        pass


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def first_row(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if len(rows) != 1:
        raise AssertionError(f"expected one probe row, got {len(rows)}")
    return rows[0]


def probe(config: dict[str, Any], *, active: bool = True) -> dict[str, Any]:
    return first_row(endpoint_status_from_config("config/sources/endpoint/smoke.local.json", config, active))


def smoke_unconfigured() -> dict[str, Any]:
    row = probe(
        {
            "name": "empty_endpoint",
            "endpoint": {"host": "", "port": None, "base_path": "/api/v1"},
        }
    )
    assert_equal(row["configured"], False, "unconfigured.configured")
    assert_equal(row["reachable"], False, "unconfigured.reachable")
    assert_equal(row["contract_detected"], False, "unconfigured.contract_detected")
    return row


def smoke_invalid_port() -> dict[str, Any]:
    row = probe(
        {
            "name": "invalid_port_endpoint",
            "endpoint": {"host": "127.0.0.1", "port": "not-a-port", "base_path": "/api/v1"},
        }
    )
    assert_equal(row["configured"], False, "invalid_port.configured")
    assert_equal(row["reachable"], False, "invalid_port.reachable")
    return row


def run_mock_server(mode: str) -> tuple[HTTPServer, Thread]:
    MockServingHandler.mode = mode
    server = HTTPServer(("127.0.0.1", 0), MockServingHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def smoke_mock_catalog() -> dict[str, Any]:
    server, _thread = run_mock_server("catalog")
    try:
        port = server.server_address[1]
        row = probe(
            {
                "name": "mock_serving_api",
                "endpoint": {
                    "host": "127.0.0.1",
                    "port": port,
                    "base_path": "/api/v1",
                    "catalog_paths": ["/catalog"],
                    "health_paths": ["/health"],
                },
            }
        )
        assert_equal(row["configured"], True, "mock_catalog.configured")
        assert_equal(row["reachable"], True, "mock_catalog.reachable")
        assert_equal(row["contract_detected"], True, "mock_catalog.contract_detected")
        return row
    finally:
        server.shutdown()
        server.server_close()


def smoke_mock_non_json_catalog() -> dict[str, Any]:
    server, _thread = run_mock_server("non_json")
    try:
        port = server.server_address[1]
        row = probe(
            {
                "name": "mock_non_json_api",
                "endpoint": {
                    "host": "127.0.0.1",
                    "port": port,
                    "base_path": "/api/v1",
                    "catalog_paths": ["/catalog"],
                    "health_paths": ["/health"],
                },
            }
        )
        assert_equal(row["configured"], True, "mock_non_json.configured")
        assert_equal(row["reachable"], True, "mock_non_json.reachable")
        assert_equal(row["contract_detected"], False, "mock_non_json.contract_detected")
        return row
    finally:
        server.shutdown()
        server.server_close()


def smoke_example_config() -> dict[str, Any]:
    example_path = ROOT / "config" / "examples" / "sources" / "endpoint" / "serving-api.example.json"
    data = json.loads(example_path.read_text(encoding="utf-8"))
    row = probe(data)
    assert_equal(row["configured"], False, "example.configured")
    assert_equal(row["reachable"], False, "example.reachable")
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test endpoint source probes with local-only fixtures.")
    parser.add_argument("--json", action="store_true", help="Print full smoke result JSON.")
    args = parser.parse_args()

    results = {
        "unconfigured": smoke_unconfigured(),
        "invalid_port": smoke_invalid_port(),
        "mock_catalog": smoke_mock_catalog(),
        "mock_non_json_catalog": smoke_mock_non_json_catalog(),
        "example_config": smoke_example_config(),
    }
    if args.json:
        print(json.dumps({"status": "ok", "results": results}, ensure_ascii=False, indent=2))
    else:
        for name, row in results.items():
            print(
                "[ok]",
                name,
                f"configured={int(bool(row['configured']))}",
                f"reachable={int(bool(row['reachable']))}",
                f"contract={int(bool(row['contract_detected']))}",
            )
        print("[ok] endpoint probe smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
