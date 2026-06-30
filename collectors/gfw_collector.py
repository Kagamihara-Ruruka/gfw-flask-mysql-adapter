from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from DatabaseConnect import import_duckdb_to_mysql, load_config  # noqa: E402


def load_json(path: str | Path) -> dict[str, Any]:
    config_path = Path(path)
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    with config_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def command_import(args: argparse.Namespace) -> int:
    collector = load_json(args.collector_config)
    sink = collector.get("sink", {})
    source = collector.get("source", {})

    adapter_config_path = args.adapter_config or sink.get("adapter_config") or "config/adapter.local.json"
    adapter_config = load_config(adapter_config_path)

    duckdb_path = Path(args.source or source["duckdb_path"])
    if not duckdb_path.is_absolute():
        duckdb_path = ROOT / duckdb_path

    dataset_id = args.dataset or sink.get("dataset_id") or adapter_config.get("default_dataset")
    chunk_size = int(args.chunk_size or sink.get("chunk_size", 5000))
    replace = args.replace if args.replace is not None else bool(sink.get("replace", False))

    result = import_duckdb_to_mysql(
        adapter_config,
        dataset_id=dataset_id,
        source=duckdb_path,
        replace=replace,
        row_limit=args.row_limit,
        chunk_size=chunk_size,
    )
    print(json.dumps({"status": "gfw_import_complete", "dataset_id": dataset_id, **result}, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reusable GFW upstream collector/importer.")
    parser.add_argument("--collector-config", default="config/gfw_collector.example.json")
    parser.add_argument("--adapter-config", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)

    import_parser = subparsers.add_parser("import", help="Import configured GFW DuckDB source into SQL.")
    import_parser.add_argument("--source", default=None)
    import_parser.add_argument("--dataset", default=None)
    import_parser.add_argument("--replace", action=argparse.BooleanOptionalAction, default=None)
    import_parser.add_argument("--row-limit", type=int, default=None)
    import_parser.add_argument("--chunk-size", type=int, default=None)
    import_parser.set_defaults(func=command_import)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
