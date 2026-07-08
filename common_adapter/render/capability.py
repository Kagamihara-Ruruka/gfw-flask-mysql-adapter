from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from typing import Any


def rendering_policy(config: dict[str, Any]) -> dict[str, Any]:
    settings = config.get("rendering", {})
    hardware_acceleration = str(settings.get("hardware_acceleration", "auto")).lower()
    if hardware_acceleration not in {"auto", "off", "force"}:
        hardware_acceleration = "auto"
    return {
        "hardware_acceleration": hardware_acceleration,
        "allow_webgl": bool(settings.get("allow_webgl", hardware_acceleration != "off")),
        "allow_webgpu": bool(settings.get("allow_webgpu", False)),
        "force_cpu": hardware_acceleration == "off",
        "min_webgl_rows": int(settings.get("min_webgl_rows", 1)),
    }


def _windows_gpu_hints() -> list[dict[str, Any]]:
    script = (
        "Get-CimInstance Win32_VideoController | "
        "Select-Object Name,AdapterRAM,DriverVersion,VideoProcessor | "
        "ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        return []
    try:
        raw = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return []
    items = raw if isinstance(raw, list) else [raw]
    hints: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("Name") or "").strip()
        if not name:
            continue
        adapter_ram = item.get("AdapterRAM")
        try:
            adapter_ram_mb = round(int(adapter_ram) / 1024 / 1024)
        except (TypeError, ValueError):
            adapter_ram_mb = None
        hints.append(
            {
                "name": name,
                "adapter_ram_mb": adapter_ram_mb,
                "driver_version": str(item.get("DriverVersion") or "").strip(),
                "video_processor": str(item.get("VideoProcessor") or "").strip(),
            }
        )
    return hints


def server_render_capability(config: dict[str, Any]) -> dict[str, Any]:
    gpu_hints = _windows_gpu_hints() if sys.platform == "win32" else []
    policy = rendering_policy(config)
    return {
        "status": "ok",
        "server": {
            "platform": sys.platform,
            "os": platform.platform(),
            "pid": os.getpid(),
            "gpu_hints": gpu_hints,
            "has_gpu_hint": bool(gpu_hints),
        },
        "policy": policy,
        "note": "Browser WebGL probe is authoritative for map acceleration; server GPU hints are advisory.",
    }
