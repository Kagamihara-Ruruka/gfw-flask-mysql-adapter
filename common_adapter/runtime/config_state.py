from __future__ import annotations

import hashlib
import json
import os
import shutil
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from common_adapter.config.atomic_json import (
    atomic_write_json,
    atomic_write_text,
    file_lock,
    last_known_good_path,
    read_json_object,
)
from common_adapter.config.paths import ROOT


CONTROL_DIR_ENV = "BDDE38_CONTROL_DIR"
GENERATION_ENV = "BDDE38_RUNTIME_GENERATION"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RuntimeConfigStateStore:
    """Owns pending desired state and controlled runtime generations."""

    def __init__(
        self,
        control_dir: str | Path | None = None,
        *,
        repo_root: str | Path = ROOT,
    ) -> None:
        self.repo_root = Path(repo_root).resolve()
        configured = control_dir or os.environ.get(CONTROL_DIR_ENV) or self.repo_root / ".runtime"
        path = Path(configured)
        if not path.is_absolute():
            path = self.repo_root / path
        self.control_dir = path.resolve()
        self.pending_root = self.control_dir / "pending-configs"
        self.state_path = self.control_dir / "runtime-config-state.json"
        self.generation_path = self.control_dir / "runtime-generation.txt"

    def resolve_ref(self, config_ref: str | Path) -> Path:
        path = Path(str(config_ref).replace("\\", "/"))
        return path.resolve() if path.is_absolute() else (self.repo_root / path).resolve()

    def normalize_ref(self, config_ref: str | Path) -> str:
        path = self.resolve_ref(config_ref)
        try:
            relative = path.relative_to(self.repo_root)
        except ValueError as exc:
            raise ValueError("runtime config must be inside the repository") from exc
        if not relative.parts or relative.parts[0].lower() != "config":
            raise ValueError("runtime desired state may only target config files")
        return relative.as_posix()

    def pending_path(self, config_ref: str | Path) -> Path:
        return self.pending_root / Path(self.normalize_ref(config_ref))

    def _state(self) -> dict[str, Any]:
        return read_json_object(
            self.state_path,
            missing={
                "schema": "bdde38.runtime_config_state.v1",
                "status": "effective",
                "generation": 0,
                "pending": {},
            },
        )

    def _write_state_locked(self, state: dict[str, Any]) -> None:
        content = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
        atomic_write_text(self.state_path, content)
        atomic_write_text(last_known_good_path(self.state_path), content)

    def snapshot(self) -> dict[str, Any]:
        return deepcopy(self._state())

    def pending_document(self, config_ref: str | Path) -> dict[str, Any] | None:
        path = self.pending_path(config_ref)
        if not path.exists():
            return None
        return read_json_object(path)

    def pending_content(self, config_ref: str | Path) -> str | None:
        path = self.pending_path(config_ref)
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8-sig")

    def state_for(self, config_ref: str | Path) -> str:
        ref = self.normalize_ref(config_ref)
        pending = self._state().get("pending") or {}
        return "pending_restart" if ref in pending else "effective"

    def _stage_json_locked(
        self,
        ref: str,
        document: dict[str, Any],
        state: dict[str, Any],
    ) -> dict[str, Any]:
        pending_path = self.pending_path(ref)
        content = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        atomic_write_text(pending_path, content)
        digest = _sha256(pending_path.read_bytes())
        pending = dict(state.get("pending") or {})
        pending[ref] = {
            "path": ref,
            "pending_path": str(pending_path),
            "sha256": digest,
            "state": "pending_restart",
        }
        state.update(
            {
                "schema": "bdde38.runtime_config_state.v1",
                "status": "pending_restart",
                "pending": pending,
                "error": None,
            }
        )
        self._write_state_locked(state)
        return {
            "status": "saved",
            "config_state": "pending_restart",
            "restart_required": True,
            "path": ref,
            "sha256": digest,
            "document": deepcopy(document),
        }

    def stage_json(self, config_ref: str | Path, document: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(document, dict):
            raise ValueError("config root must be a JSON object")
        ref = self.normalize_ref(config_ref)
        with file_lock(self.state_path):
            state = self._state()
            return self._stage_json_locked(ref, deepcopy(document), state)

    def update_json(
        self,
        config_ref: str | Path,
        update: Callable[[dict[str, Any]], dict[str, Any]],
        *,
        effective: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Atomically derive one pending document from the latest desired state."""

        ref = self.normalize_ref(config_ref)
        pending_path = self.pending_path(ref)
        with file_lock(self.state_path):
            state = self._state()
            if pending_path.exists():
                current = read_json_object(pending_path)
            elif effective is not None:
                current = deepcopy(effective)
            else:
                current = read_json_object(self.resolve_ref(ref))
            document = update(deepcopy(current))
            if not isinstance(document, dict):
                raise ValueError("config update must return a JSON object")
            return self._stage_json_locked(ref, document, state)

    def _next_generation_locked(self, state: dict[str, Any]) -> int:
        candidates = [int(state.get("generation") or 0)]
        try:
            candidates.append(int(self.generation_path.read_text(encoding="ascii").strip() or 0))
        except (OSError, ValueError):
            pass
        generation = max(candidates) + 1
        atomic_write_text(self.generation_path, f"{generation}\n")
        return generation

    def prepare_generation(
        self,
        *,
        validate: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        """Apply and validate one candidate bundle before a controlled process start."""

        self.control_dir.mkdir(parents=True, exist_ok=True)
        with file_lock(self.state_path):
            state = self._state()
            pending = dict(state.get("pending") or {})
            applied: list[dict[str, Any]] = []
            candidates: list[tuple[str, Path, Path, dict[str, Any]]] = []
            originals: dict[Path, bytes | None] = {}
            for ref in sorted(pending):
                pending_path = self.pending_path(ref)
                document = read_json_object(pending_path)
                target = self.resolve_ref(ref)
                candidates.append((ref, pending_path, target, document))
                originals[target] = target.read_bytes() if target.exists() else None
            try:
                for ref, _pending_path, target, document in candidates:
                    atomic_write_json(target, document)
                    applied.append({"path": ref, "sha256": _sha256(target.read_bytes())})
                if validate is not None:
                    validate()
            except Exception as exc:
                for target, original in originals.items():
                    if original is None:
                        target.unlink(missing_ok=True)
                        last_known_good_path(target).unlink(missing_ok=True)
                    else:
                        text = original.decode("utf-8-sig")
                        atomic_write_text(target, text)
                        atomic_write_text(last_known_good_path(target), text)
                failed_state = {
                    **state,
                    "schema": "bdde38.runtime_config_state.v1",
                    "status": "failed",
                    "pending": pending,
                    "error": {"stage": "validation", "message": str(exc)},
                }
                self._write_state_locked(failed_state)
                raise RuntimeError(f"pending Runtime config validation failed: {exc}") from exc
            for _ref, pending_path, _target, _document in candidates:
                pending_path.unlink(missing_ok=True)
            generation = self._next_generation_locked(state)
            next_state = {
                **state,
                "schema": "bdde38.runtime_config_state.v1",
                "status": "validated",
                "generation": generation,
                "pending": {},
                "applied": applied,
                "error": None,
            }
            self._write_state_locked(next_state)
        os.environ[GENERATION_ENV] = str(generation)
        return deepcopy(next_state)

    def mark_effective(self, identity: dict[str, Any]) -> dict[str, Any]:
        with file_lock(self.state_path):
            state = self._state()
            pending = state.get("pending") or {}
            state.update(
                {
                    "schema": "bdde38.runtime_config_state.v1",
                    "status": "pending_restart" if pending else "effective",
                    "generation": int(identity.get("runtime_generation") or state.get("generation") or 0),
                    "effective": deepcopy(identity),
                    "pending": pending,
                    "error": None,
                }
            )
            self._write_state_locked(state)
        return deepcopy(state)

    def mark_failed(self, stage: str, message: str) -> dict[str, Any]:
        with file_lock(self.state_path):
            state = self._state()
            state.update(
                {
                    "schema": "bdde38.runtime_config_state.v1",
                    "status": "failed",
                    "error": {"stage": str(stage), "message": str(message)},
                }
            )
            self._write_state_locked(state)
        return deepcopy(state)

    def discard_pending(self) -> None:
        """Test/support helper; runtime stop deliberately does not call this."""

        shutil.rmtree(self.pending_root, ignore_errors=True)
        with file_lock(self.state_path):
            state = self._state()
            state.update({"status": "effective", "pending": {}, "error": None})
            self._write_state_locked(state)
