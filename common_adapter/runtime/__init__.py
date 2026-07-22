"""Runtime generation, identity, and desired-state ownership."""

from common_adapter.runtime.config_state import RuntimeConfigStateStore
from common_adapter.runtime.identity import RuntimeConfigSnapshot, capture_runtime_config_snapshot

__all__ = [
    "RuntimeConfigSnapshot",
    "RuntimeConfigStateStore",
    "capture_runtime_config_snapshot",
]
