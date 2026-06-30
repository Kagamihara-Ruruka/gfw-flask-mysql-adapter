from __future__ import annotations

import argparse
import json
from pathlib import Path

from AisIngestService import run_ais_ingest_forever
from DatabaseConnect import import_duckdb_to_mysql, load_config, server_settings
from Interface import run_server
from TestDataBootstrap import ensure_test_data


def command_import(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    dataset_id = args.dataset or config.get("default_dataset")
    result = import_duckdb_to_mysql(
        config,
        dataset_id=dataset_id,
        source=Path(args.source),
        replace=args.replace,
        row_limit=args.row_limit,
        chunk_size=args.chunk_size,
    )
    print(json.dumps({"status": "import_complete", **result}, ensure_ascii=False))
    return 0


def command_serve(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    config["__config_path"] = str((Path(args.config) if args.config else Path("config/adapter.local.json")).resolve())
    bootstrap = config.get("test_data_bootstrap", {})
    if bootstrap.get("auto_on_serve", False):
        ensure_test_data(config, reason="serve")
    server = server_settings(config)
    host = args.host or server["host"]
    port = args.port if args.port is not None else server["port"]
    debug = args.debug if args.debug is not None else server["debug"]
    run_server(config, host=host, port=port, debug=debug, kill_port_if_busy=server["kill_port_if_busy"])
    return 0


def command_bootstrap_test_data(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    ensure_test_data(config, reason="manual")
    return 0


def command_ingest_ais(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    if args.collector_config:
        config.setdefault("live", {}).setdefault("ais", {})["collector_config_path"] = args.collector_config
    run_ais_ingest_forever(config)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="GFW Flask/PyMySQL adapter.")
    parser.add_argument("--config", default=None, help="Path to adapter config JSON.")
    subparsers = parser.add_subparsers(dest="command")

    import_parser = subparsers.add_parser("import", help="Import DuckDB table into MySQL.")
    import_parser.add_argument("--source", required=True, help="Path to source DuckDB file.")
    import_parser.add_argument("--dataset", default=None)
    import_parser.add_argument("--replace", action="store_true")
    import_parser.add_argument("--row-limit", type=int, default=None)
    import_parser.add_argument("--chunk-size", type=int, default=5000)
    import_parser.set_defaults(func=command_import)

    serve_parser = subparsers.add_parser("serve", help="Start the Flask server.")
    serve_parser.add_argument("--host", default=None)
    serve_parser.add_argument("--port", type=int, default=None)
    serve_parser.add_argument("--debug", action="store_true", default=None)
    serve_parser.set_defaults(func=command_serve)

    bootstrap_parser = subparsers.add_parser("bootstrap-test-data", help="Download temporary test datasets.")
    bootstrap_parser.set_defaults(func=command_bootstrap_test_data)

    ingest_ais_parser = subparsers.add_parser("ingest-ais", help="Run AISStream to SQL latest-state ingest only.")
    ingest_ais_parser.add_argument(
        "--collector-config",
        default=None,
        help="Path to AIS crawler handoff JSON. Overrides live.ais.collector_config_path.",
    )
    ingest_ais_parser.set_defaults(func=command_ingest_ais)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command is None:
        args.command = "serve"
        args.func = command_serve
        args.host = None
        args.port = None
        args.debug = None
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
