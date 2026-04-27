from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from clr_loader import get_coreclr
from pythonnet import set_runtime


class BridgeError(RuntimeError):
    """Base class for bridge failures."""


class DllNotFoundError(BridgeError):
    """Raised when the expected Pupil.Core.dll cannot be found."""


class RuntimeInitError(BridgeError):
    """Raised when CLR/pythonnet initialization fails."""


class PerceiveCallError(BridgeError):
    """Raised when the Perceive call fails unexpectedly."""


_RUNTIME_LOCK = threading.Lock()
_RUNTIME_READY = False
_PERCEIVE_FN = None

_REPO_ROOT = Path(__file__).resolve().parents[1]
_DLL_PATH = (
    _REPO_ROOT / "core" / "Pupil.Core" / "bin" / "Release" / "net8.0" / "Pupil.Core.dll"
)


def _ensure_runtime() -> None:
    global _RUNTIME_READY
    if _RUNTIME_READY:
        return

    with _RUNTIME_LOCK:
        if _RUNTIME_READY:
            return
        try:
            set_runtime(get_coreclr())
        except Exception as exc:  # pragma: no cover - runtime dependent
            raise RuntimeInitError(f"Failed to initialize CoreCLR runtime: {exc}") from exc
        _RUNTIME_READY = True


def _load_perceive_function():
    global _PERCEIVE_FN
    if _PERCEIVE_FN is not None:
        return _PERCEIVE_FN

    _ensure_runtime()

    if not _DLL_PATH.is_file():
        raise DllNotFoundError(
            f"Pupil.Core.dll not found at '{_DLL_PATH}'. Build core first with .\\scripts\\build-core.ps1."
        )

    try:
        import clr  # noqa: PLC0415
    except Exception as exc:  # pragma: no cover - runtime dependent
        raise RuntimeInitError(f"Unable to import pythonnet clr module: {exc}") from exc

    try:
        clr.AddReference(str(_DLL_PATH.resolve()))
        from Pupil.Core import PerceptionApi  # noqa: PLC0415
    except Exception as exc:
        raise RuntimeInitError(f"Failed to load Pupil.Core.dll: {exc}") from exc

    _PERCEIVE_FN = PerceptionApi.Perceive
    return _PERCEIVE_FN


def _coerce_output(payload: Any) -> list[dict[str, Any]]:
    if payload is None:
        return []

    if not isinstance(payload, str):
        payload = str(payload)

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return []

    if not isinstance(parsed, list):
        return []

    safe_nodes: list[dict[str, Any]] = []
    for node in parsed:
        if isinstance(node, dict):
            safe_nodes.append(node)
    return safe_nodes


def perceive(overlay_hwnd: int = 0) -> list[dict[str, Any]]:
    """Call PerceptionApi.Perceive and return parsed node list."""
    if not isinstance(overlay_hwnd, int):
        raise PerceiveCallError("overlay_hwnd must be an integer.")

    perceive_fn = _load_perceive_function()
    try:
        payload = perceive_fn(overlay_hwnd)
    except Exception as exc:
        raise PerceiveCallError(f"Perceive call failed: {exc}") from exc

    return _coerce_output(payload)


def status() -> dict[str, Any]:
    """Minimal internal diagnostics for startup checks/logging."""
    return {
        "runtime_ready": _RUNTIME_READY,
        "dll_path": str(_DLL_PATH),
        "dll_exists": _DLL_PATH.is_file(),
    }
