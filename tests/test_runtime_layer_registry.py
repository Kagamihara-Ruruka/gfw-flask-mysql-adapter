from __future__ import annotations

import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from common_adapter.endpoint.supervisor import ManagedEndpointSupervisor, managed_runtime_spec
from common_adapter.layers.registry import RuntimeLayerRegistry
from common_adapter.query.identity import dataset_query_transport_key


PIPELINE_CONFIG = "config/sources/database/pipeline.local.json"


def _catalog_mapping() -> dict:
    return {
        "mapping_id": "database.pipeline__catalog",
        "enabled": True,
        "config_path": PIPELINE_CONFIG,
        "connection_ref": "pipeline",
        "backend": "iceberg",
        "layer_id": "pipeline",
        "label": "Pipeline",
        "sampled_grid": {"catalog": {"path": "catalog"}},
    }


def _runtime_dataset() -> dict:
    return {
        "dataset_id": "pipeline.chlor_a",
        "label": "Chlorophyll",
        "backend": "sampled_grid_http",
        "connection_ref": "pipeline",
        "data_layer": "pipeline.chlor_a",
        "__runtime_source": "mapping_controller_contract",
        "__runtime_contract_group": "mapping",
        "__runtime_source_route_group": "database",
        "__runtime_mapping_id": "database.pipeline__catalog",
        "__runtime_config_path": "config/artifacts/layer_mappings.local.json",
        "__runtime_source_config_path": PIPELINE_CONFIG,
    }


def _runtime_contract() -> dict:
    return {
        "contract_version": "rrkal.layer_contract.v1",
        "contract_source": "mapping_controller_contract",
        "contract_group": "mapping",
        "contract_status": "active",
        "config_path": "config/artifacts/layer_mappings.local.json",
        "source_route_group": "database",
        "source_config_path": PIPELINE_CONFIG,
        "source_ref": "pipeline.chlor_a",
        "source_label": "Chlorophyll",
        "layer_id": "pipeline.chlor_a",
        "dataset_id": "pipeline.chlor_a",
        "label": "Chlorophyll",
        "backend": "sampled_grid_http",
        "connection_ref": "pipeline",
        "detail": "DATABASE pipeline",
    }


class RuntimeLayerRegistryTests(unittest.TestCase):
    def test_frame_lookup_does_not_repeat_catalog_discovery_after_ttl_expiry(self) -> None:
        clock = [0.0]
        dataset = _runtime_dataset()
        materialized = {
            "generation": 0,
            "datasets": {"pipeline.chlor_a": dataset},
            "layers": [],
            "imported_layers": ["pipeline.chlor_a"],
            "source_errors": [],
        }
        registry = RuntimeLayerRegistry(
            {},
            refresh_ttl_seconds=0.5,
            monotonic=lambda: clock[0],
        )
        with patch.object(
            registry,
            "_build_snapshot",
            side_effect=lambda: deepcopy(materialized),
        ) as build_snapshot:
            registry.snapshot(force=True)
            clock[0] = 5.0

            self.assertEqual(
                "Chlorophyll",
                registry.get_dataset("pipeline.chlor_a")["label"],
            )
            self.assertEqual(1, build_snapshot.call_count)

            registry.invalidate()
            self.assertEqual(
                "Chlorophyll",
                registry.get_dataset("pipeline.chlor_a")["label"],
            )
            self.assertEqual(2, build_snapshot.call_count)

    def test_consumer_snapshot_uses_materialized_truth_after_ttl_expiry(self) -> None:
        clock = [0.0]
        materialized = {
            "generation": 0,
            "datasets": {"pipeline.chlor_a": _runtime_dataset()},
            "layers": [],
            "imported_layers": ["pipeline.chlor_a"],
            "source_errors": [],
        }
        registry = RuntimeLayerRegistry(
            {},
            refresh_ttl_seconds=0.5,
            monotonic=lambda: clock[0],
        )
        with patch.object(
            registry,
            "_build_snapshot",
            side_effect=lambda: deepcopy(materialized),
        ) as build_snapshot:
            first = registry.snapshot(force=True)
            clock[0] = 5.0
            second = registry.snapshot(refresh_if_expired=False)

        self.assertEqual(first["datasets"], second["datasets"])
        self.assertEqual(1, build_snapshot.call_count)

    def test_registered_dynamic_layer_remains_visible_when_catalog_is_offline(self) -> None:
        source_error = {
            "config_path": PIPELINE_CONFIG,
            "mapping_id": "database.pipeline__catalog",
            "error": "connection refused",
        }
        with patch(
            "common_adapter.layers.registry.database_datasets_from_mappings",
            return_value=({}, []),
        ), patch(
            "common_adapter.layers.registry.active_config_files_by_group",
            return_value=[],
        ), patch(
            "common_adapter.layers.registry.endpoint_datasets_from_routes",
            side_effect=[({}, [source_error]), ({}, [])],
        ), patch(
            "common_adapter.layers.registry.active_layer_contract_rows",
            return_value=[],
        ), patch(
            "common_adapter.layers.registry.imported_layer_ids",
            return_value={"pipeline.chlor_a"},
        ), patch(
            "common_adapter.layers.registry.layer_mappings_with_runtime",
            return_value={"mappings": [_catalog_mapping()]},
        ):
            snapshot = RuntimeLayerRegistry({}, refresh_ttl_seconds=0).snapshot(force=True)

        self.assertEqual(["pipeline.chlor_a"], snapshot["imported_layers"])
        self.assertEqual({}, snapshot["datasets"])
        self.assertEqual(1, len(snapshot["layers"]))
        row = snapshot["layers"][0]
        self.assertTrue(row["registered"])
        self.assertFalse(row["materialized"])
        self.assertFalse(row["available"])
        self.assertEqual("source_unavailable", row["runtime_status"])
        self.assertEqual("connection refused", row["detail"])

    def test_materialized_dynamic_layer_is_the_same_dataset_truth(self) -> None:
        dataset = _runtime_dataset()
        with patch(
            "common_adapter.layers.registry.database_datasets_from_mappings",
            return_value=({}, []),
        ), patch(
            "common_adapter.layers.registry.active_config_files_by_group",
            return_value=[],
        ), patch(
            "common_adapter.layers.registry.endpoint_datasets_from_routes",
            side_effect=[({"pipeline.chlor_a": dataset}, []), ({}, [])],
        ), patch(
            "common_adapter.layers.registry.active_layer_contract_rows",
            return_value=[_runtime_contract()],
        ), patch(
            "common_adapter.layers.registry.imported_layer_ids",
            return_value={"pipeline.chlor_a"},
        ):
            registry = RuntimeLayerRegistry({}, refresh_ttl_seconds=60)
            snapshot = registry.snapshot(force=True)

        self.assertEqual({"pipeline.chlor_a"}, set(snapshot["datasets"]))
        row = snapshot["layers"][0]
        self.assertTrue(row["registered"])
        self.assertTrue(row["materialized"])
        self.assertTrue(row["dataset_materialized"])
        self.assertTrue(row["available"])
        self.assertEqual("ready", row["runtime_status"])
        self.assertEqual("Chlorophyll", registry.get_dataset("pipeline.chlor_a")["label"])

    def test_datasets_on_the_same_provider_share_transport_but_not_dataset_identity(self) -> None:
        chlorophyll = _runtime_dataset()
        temperature = {**_runtime_dataset(), "dataset_id": "pipeline.temperature", "data_layer": "pipeline.temperature"}

        self.assertEqual(
            dataset_query_transport_key(chlorophyll),
            dataset_query_transport_key(temperature),
        )


class _FakeProcess:
    def __init__(self) -> None:
        self.pid = 1234
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout: float | None = None) -> int:
        return int(self.returncode or 0)

    def kill(self) -> None:
        self.returncode = -9


class ManagedEndpointSupervisorTests(unittest.TestCase):
    def test_endpoint_state_transition_notifies_subscribers_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "provider"
            source = project / "src"
            source.mkdir(parents=True)
            route = {
                "name": "provider",
                "endpoint": {"host": "127.0.0.1", "port": 8791},
                "runtime": {
                    "ownership": "managed_local",
                    "startup_timeout_seconds": 0.2,
                    "launcher": {
                        "kind": "python_flask",
                        "app": "provider.api:app",
                        "working_directory": "${APP_ROOT}/provider",
                        "python_path": "${APP_ROOT}/provider/src",
                    },
                },
            }
            spec = managed_runtime_spec(PIPELINE_CONFIG, route, root=root)
            reachable = [False]
            process = _FakeProcess()
            process.returncode = 1
            supervisor = ManagedEndpointSupervisor(
                {},
                root=root,
                executable="python",
                popen_factory=lambda *_args, **_kwargs: process,
                port_probe=lambda _host, _port: reachable[0],
            )
            notifications: list[str] = []
            unsubscribe = supervisor.subscribe_status_changes(lambda: notifications.append("changed"))

            self.assertEqual("failed", supervisor.ensure(spec)["state"])
            self.assertEqual("failed", supervisor.ensure(spec)["state"])
            reachable[0] = True
            self.assertEqual("conflict", supervisor.ensure(spec)["state"])
            self.assertEqual("conflict", supervisor.ensure(spec)["state"])
            unsubscribe()
            reachable[0] = False
            self.assertEqual("failed", supervisor.ensure(spec)["state"])
            supervisor.stop()

        self.assertEqual(["changed", "changed"], notifications)

    def test_managed_local_spec_and_launch_use_config_not_dataset_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "provider"
            source = project / "src"
            source.mkdir(parents=True)
            route = {
                "name": "provider",
                "endpoint": {"host": "127.0.0.1", "port": 8791},
                "runtime": {
                    "ownership": "managed_local",
                    "launcher": {
                        "kind": "python_flask",
                        "app": "provider.api:app",
                        "working_directory": "${APP_ROOT}/provider",
                        "python_path": "${APP_ROOT}/provider/src",
                        "environment": {"DATA_ROOT": "${APP_ROOT}/data"},
                    },
                },
            }
            spec = managed_runtime_spec(PIPELINE_CONFIG, route, root=root)
            probes = iter([False, True])
            process = _FakeProcess()
            launched: list[tuple] = []

            def popen_factory(*args, **kwargs):
                launched.append((args, kwargs))
                return process

            supervisor = ManagedEndpointSupervisor(
                {},
                root=root,
                executable="python",
                popen_factory=popen_factory,
                port_probe=lambda _host, _port: next(probes),
            )
            status = supervisor.ensure(spec)
            supervisor.stop()

        self.assertEqual("ready", status["state"])
        self.assertEqual(1234, status["pid"])
        command = launched[0][0][0]
        self.assertEqual("python", command[0])
        self.assertIn("provider.api:app", command)
        self.assertEqual(str(source.resolve()), launched[0][1]["env"]["PYTHONPATH"])
        self.assertEqual(str((root / "data").resolve()), launched[0][1]["env"]["DATA_ROOT"])

    def test_open_port_without_owned_process_is_not_reported_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "provider"
            (project / "src").mkdir(parents=True)
            route = {
                "name": "provider",
                "endpoint": {"host": "127.0.0.1", "port": 8791},
                "runtime": {
                    "ownership": "managed_local",
                    "launcher": {
                        "kind": "python_flask",
                        "app": "provider.api:app",
                        "working_directory": "${APP_ROOT}/provider",
                        "python_path": "${APP_ROOT}/provider/src",
                    },
                },
            }
            spec = managed_runtime_spec(PIPELINE_CONFIG, route, root=root)
            launched: list[object] = []
            supervisor = ManagedEndpointSupervisor(
                {},
                root=root,
                popen_factory=lambda *_args, **_kwargs: launched.append(object()),
                port_probe=lambda _host, _port: True,
            )

            status = supervisor.ensure(spec)
            supervisor.stop()

        self.assertEqual("conflict", status["state"])
        self.assertFalse(status["ready"])
        self.assertFalse(status["owned"])
        self.assertEqual([], launched)

    def test_changed_execution_spec_restarts_only_the_owned_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "provider"
            (project / "src").mkdir(parents=True)
            base_route = {
                "name": "provider",
                "endpoint": {"host": "127.0.0.1", "port": 8791},
                "runtime": {
                    "ownership": "managed_local",
                    "launcher": {
                        "kind": "python_flask",
                        "app": "provider.api:app",
                        "working_directory": "${APP_ROOT}/provider",
                        "python_path": "${APP_ROOT}/provider/src",
                        "environment": {"GENERATION": "1"},
                    },
                },
            }
            changed_route = deepcopy(base_route)
            changed_route["runtime"]["launcher"]["environment"]["GENERATION"] = "2"
            first_spec = managed_runtime_spec(PIPELINE_CONFIG, base_route, root=root)
            second_spec = managed_runtime_spec(PIPELINE_CONFIG, changed_route, root=root)
            probes = iter([False, True, False, True])
            first_process = _FakeProcess()
            second_process = _FakeProcess()
            processes = iter([first_process, second_process])
            supervisor = ManagedEndpointSupervisor(
                {},
                root=root,
                popen_factory=lambda *_args, **_kwargs: next(processes),
                port_probe=lambda _host, _port: next(probes),
            )

            first_status = supervisor.ensure(first_spec)
            second_status = supervisor.ensure(second_spec)
            supervisor.stop()

        self.assertNotEqual(first_spec["spec_fingerprint"], second_spec["spec_fingerprint"])
        self.assertEqual("ready", first_status["state"])
        self.assertTrue(first_process.terminated)
        self.assertEqual("ready", second_status["state"])
        self.assertEqual(second_spec["spec_fingerprint"], second_status["spec_fingerprint"])


if __name__ == "__main__":
    unittest.main()
