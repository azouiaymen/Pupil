import atexit
import errno
import logging
import msvcrt
import os
import threading
import time
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP
from overlay_runtime import OverlayRuntime

mcp = FastMCP("Pupil")
overlay_runtime = OverlayRuntime()
logger = logging.getLogger(__name__)
_PARENT_WATCH_INTERVAL_S = 2.0
_DEBUG_PERCEIVE_LOGS = os.getenv("PUPIL_DEBUG_PERCEIVE", "").lower() in {"1", "true", "yes", "on"}
_ENABLE_PARENT_WATCHDOG = os.getenv("PUPIL_ENABLE_PARENT_WATCHDOG", "").lower() in {"1", "true", "yes", "on"}
_LOCK_FILE_PATH = Path(os.getenv("PUPIL_MCP_LOCK_FILE", str(Path(os.getenv("TEMP", ".")) / "pupil-mcp.lock")))
_instance_lock_file: Any | None = None


def _pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        if exc.errno in {errno.EPERM, errno.EACCES}:
            return True
        return False
    return True


def _start_parent_watchdog() -> None:
    if not _ENABLE_PARENT_WATCHDOG:
        return
    parent_pid = os.getppid()

    def _watch_loop() -> None:
        while True:
            time.sleep(_PARENT_WATCH_INTERVAL_S)
            current_parent = os.getppid()
            if current_parent == parent_pid and _pid_exists(parent_pid):
                continue
            logger.warning(
                "Parent process changed or exited (initial=%s current=%s). Stopping MCP runtime.",
                parent_pid,
                current_parent,
            )
            try:
                overlay_runtime.stop()
            finally:
                os._exit(0)

    threading.Thread(target=_watch_loop, daemon=True, name="mcp-parent-watchdog").start()


def _acquire_single_instance_lock() -> None:
    # Prevent multiple MCP servers from running concurrently (common zombie multiplier).
    global _instance_lock_file
    _LOCK_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock_file = open(_LOCK_FILE_PATH, "a+", encoding="utf-8")
    try:
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        lock_file.seek(0)
        lock_file.truncate(0)
        lock_file.write(str(os.getpid()))
        lock_file.flush()
    except OSError:
        logger.warning("Another MCP server instance is already running. Exiting duplicate process.")
        try:
            lock_file.close()
        except Exception:
            pass
        os._exit(0)

    _instance_lock_file = lock_file
    atexit.register(_release_single_instance_lock)


def _release_single_instance_lock() -> None:
    global _instance_lock_file
    if _instance_lock_file is None:
        return
    try:
        try:
            _instance_lock_file.seek(0)
            msvcrt.locking(_instance_lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        _instance_lock_file.close()
    finally:
        _instance_lock_file = None


def _looks_like_shell_only(nodes: list[dict[str, Any]]) -> bool:
    if not nodes:
        return False
    shell_markers = {"shell", "taskbar", "desktop", "start", "windows shell experience host"}
    inspected = nodes[:5]
    if len(inspected) < 2:
        return False
    shell_hits = 0
    for node in inspected:
        name = str(node.get("name", "")).lower()
        role = str(node.get("role", "")).lower()
        text = f"{name} {role}"
        if any(marker in text for marker in shell_markers):
            shell_hits += 1
    return shell_hits >= max(2, len(inspected) - 1)


@mcp.tool(name="perceive")
def perceive_mcp(overlay_hwnd: int = 0, include_diagnostics: bool = False) -> list[dict]:
    """Capture visible UI elements and return parsed nodes.

    `overlay_hwnd` defaults to the current runtime overlay handle when 0.
    `include_diagnostics` appends one diagnostic entry at the end of results.
    """
    try:
        from bridge import DllNotFoundError, PerceiveCallError, RuntimeInitError, perceive
    except Exception as exc:
        raise RuntimeError(f"Bridge import failed: {exc}") from exc

    effective_overlay_hwnd = overlay_hwnd or overlay_runtime.overlay_hwnd
    if effective_overlay_hwnd == 0:
        overlay_runtime.warn_if_overlay_hwnd_unset()
    if _DEBUG_PERCEIVE_LOGS:
        logger.debug(
            "perceive call: requested_overlay_hwnd=%s effective_overlay_hwnd=%s",
            overlay_hwnd,
            effective_overlay_hwnd,
        )
    try:
        result: list[dict[str, Any]] = perceive(overlay_hwnd=effective_overlay_hwnd)
        normalized = [dict(item) for item in result]
        sample = [
            {
                "type": item.get("type"),
                "name": item.get("name"),
                "rect": item.get("rect"),
            }
            for item in normalized[:3]
        ]
        if _DEBUG_PERCEIVE_LOGS:
            logger.debug("perceive result: nodes=%s sample=%s", len(normalized), sample)
        if include_diagnostics:
            normalized.append(
                {
                    "type": "__perceive_diagnostics",
                    "overlayHwndRequested": overlay_hwnd,
                    "overlayHwndEffective": effective_overlay_hwnd,
                    "nodesCount": len(result),
                    "shellOnlyDetected": _looks_like_shell_only(result),
                }
            )
        return normalized
    except DllNotFoundError as exc:
        raise RuntimeError(str(exc)) from exc
    except (RuntimeInitError, PerceiveCallError) as exc:
        raise RuntimeError(f"Perception unavailable: {exc}") from exc


@mcp.tool(name="indicate")
def indicate(indicator: dict[str, Any]) -> dict:
    """
    Render an overlay indicator with optional bounds and floating tooltip.

    Type semantics (important):
    - click: Use ONLY when the next required user/agent step is a mouse click
      on a specific target. This is the default for click instructions.
    - action: Use for generic high-level actions that are NOT an immediate click
      (example: "Open settings", "Review this section", "Continue the flow").
    - type: Use when the user/agent must type text.
    - wait: Use when the user/agent should wait for loading or async completion.
    - warning: Use for risk, irreversible, or potentially destructive operations.
    - info: Use for neutral guidance or context.

    Selection rule:
    - If the instruction says "click/tap/press this button", prefer type="click"
      and do not use type="action".
    - Prefer type="click" whenever the step can be completed by clicking.
      Use type="type" only when text entry is strictly required.
    - Reserve type="action" for non-click intent.

    Expected payload shape:
      {
        "type": "info" | "warning" | "wait" | "action" | "click" | "type",
        "bounds"?: {"x": int, "y": int, "width": int, "height": int},
        "title"?: str,
        "text"?: str,
        "append"?: bool,  # default false
        "await"?: bool    # default false
      }

    Await behavior:
    - await=false: fire-and-forget. Tool returns immediately with result=null.
    - await=true: blocking mode. Tooltip shows "Skip" and "Done" buttons and
      the tool waits until one is clicked.
      - Done -> result="done"
      - Skip -> result="skipped"
    - Close (X) acts like Skip for await=true and resolves with result="skipped".

    Return shape:
      {
        "ok": true,
        "indicator": <normalized indicator>,
        "result": null | "done" | "skipped"
      }

    Examples:
    - Click submit button (await) -> {"type": "click", "await": true, ...}
    - Fill message input -> {"type": "type", ...}
    - Wait for page refresh -> {"type": "wait", ...}
    """
    try:
        normalized = overlay_runtime.normalize_indicator(indicator)
        await_result = overlay_runtime.indicate(normalized)
    except Exception as exc:
        raise RuntimeError(f"Overlay update failed: {exc}") from exc
    return {"ok": True, "indicator": normalized, "result": await_result}


def main() -> None:
    _acquire_single_instance_lock()
    _start_parent_watchdog()
    overlay_runtime.start()
    try:
        mcp.run()
    except KeyboardInterrupt:
        logger.info("MCP server interrupted, shutting down cleanly.")
    finally:
        overlay_runtime.stop()


if __name__ == "__main__":
    main()
