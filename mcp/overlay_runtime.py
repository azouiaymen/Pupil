from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
INDICATOR_TYPES = {"info", "warning", "wait", "action", "click", "type"}
DEFAULT_STARTUP_TIMEOUT_S = 45.0
MAX_RESTARTS = 3


def _coerce_int(value: Any, *, field_name: str) -> int:
    # Accept int/float input from MCP payloads and normalize to int.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a number.")
    return int(value)


class OverlayRuntime:
    """
    Bridge runtime that communicates with the Electron overlay process.

    Commands are sent over a Windows named pipe.
    Events are received from the child process stdout as JSON lines.
    """

    def __init__(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        self._overlay_dir = repo_root / "overlay"
        # Per-runtime unique pipe prevents collisions with stale processes.
        self._pipe_name = f"pupil-overlay-ipc-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self._pipe_path = rf"\\.\pipe\{self._pipe_name}"
        self._process: subprocess.Popen[str] | None = None
        self._ready = threading.Event()
        self._stop_requested = threading.Event()
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._events: queue.Queue[dict[str, Any]] = queue.Queue()
        self._lock = threading.Lock()
        self._indicators: list[dict[str, Any]] = []
        self._restart_attempts = 0
        self._logger = logging.getLogger(__name__)

        # Filled after bridge sends `ready` with native window handle.
        self._overlay_hwnd = 0
        atexit.register(self.stop)

    @property
    def overlay_hwnd(self) -> int:
        return self._overlay_hwnd

    def normalize_indicator(self, payload: dict[str, Any]) -> dict[str, Any]:
        # Validate and normalize user payload before sending to the overlay bridge.
        if not isinstance(payload, dict):
            raise ValueError("indicator must be an object.")

        raw_type = payload.get("type")
        if not isinstance(raw_type, str) or raw_type not in INDICATOR_TYPES:
            allowed = ", ".join(sorted(INDICATOR_TYPES))
            raise ValueError(f"type must be one of: {allowed}.")

        normalized: dict[str, Any] = {"type": raw_type}

        bounds = payload.get("bounds")
        if bounds is not None:
            if not isinstance(bounds, dict):
                raise ValueError("bounds must be an object when provided.")
            x = _coerce_int(bounds.get("x"), field_name="bounds.x")
            y = _coerce_int(bounds.get("y"), field_name="bounds.y")
            width = _coerce_int(bounds.get("width"), field_name="bounds.width")
            height = _coerce_int(bounds.get("height"), field_name="bounds.height")
            if width <= 0 or height <= 0:
                raise ValueError("bounds.width and bounds.height must be positive.")
            normalized["bounds"] = {"x": x, "y": y, "width": width, "height": height}

        title = payload.get("title")
        if title is not None:
            if not isinstance(title, str):
                raise ValueError("title must be a string when provided.")
            normalized["title"] = title

        text = payload.get("text")
        if text is not None:
            if not isinstance(text, str):
                raise ValueError("text must be a string when provided.")
            normalized["text"] = text

        append = payload.get("append", False)
        if not isinstance(append, bool):
            raise ValueError("append must be a boolean when provided.")
        normalized["append"] = append
        return normalized

    def start(self, startup_timeout_s: float = DEFAULT_STARTUP_TIMEOUT_S) -> None:
        # Start one overlay process and wait until renderer signals `ready`.
        with self._lock:
            if self._is_running():
                return
            self._restart_attempts = 0
            self._spawn_process_locked()

        if not self._ready.wait(startup_timeout_s):
            raise RuntimeError("Overlay startup timed out waiting for ready signal.")
        try:
            with self._lock:
                self._send_command_locked("ping", {})
        except Exception as exc:
            self._logger.warning("overlay startup ping failed: %s", exc)

    def stop(self) -> None:
        self._stop_requested.set()
        with self._lock:
            process = self._process
            self._process = None
        if process is None:
            return

        try:
            process.terminate()
            process.wait(timeout=2.5)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def indicate(self, indicator: dict[str, Any]) -> None:
        # append=True keeps previous indicators, append=False replaces all.
        append = bool(indicator.get("append", False))
        with self._lock:
            self._ensure_running_locked()
            if append:
                self._indicators.append(indicator)
                self._send_command_locked("indicate", {"indicator": indicator})
                return

            self._indicators = [indicator]
            self._send_command_locked("hideAll", {})
            self._send_command_locked("indicate", {"indicator": indicator})

    def _spawn_process_locked(self) -> None:
        if not self._overlay_dir.exists():
            raise RuntimeError(f"Overlay app not found at {self._overlay_dir}.")
        electron_exe = self._overlay_dir / "node_modules" / "electron" / "dist" / "electron.exe"
        bridge_entry = self._overlay_dir / "bridge" / "main.cjs"
        if not electron_exe.exists():
            raise RuntimeError(f"Electron executable not found at {electron_exe}.")
        if not bridge_entry.exists():
            raise RuntimeError(f"Overlay bridge entry not found at {bridge_entry}.")

        self._ready.clear()
        self._stop_requested.clear()
        env = os.environ.copy()
        # If inherited as "1", Electron behaves like plain Node and `app` is undefined.
        env.pop("ELECTRON_RUN_AS_NODE", None)
        # Bridge listens for command envelopes on this pipe.
        env["PUPIL_OVERLAY_PIPE"] = self._pipe_path
        self._process = subprocess.Popen(
            [str(electron_exe), str(bridge_entry)],
            cwd=str(self._overlay_dir),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._stdout_thread = threading.Thread(target=self._read_stdout_loop, daemon=True, name="overlay-stdout")
        self._stderr_thread = threading.Thread(target=self._read_stderr_loop, daemon=True, name="overlay-stderr")
        self._stdout_thread.start()
        self._stderr_thread.start()

    def _is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _ensure_running_locked(self) -> None:
        if self._is_running():
            return
        # Lazily recover after crashes when a new command is sent.
        self._attempt_restart_locked()

    def _attempt_restart_locked(self) -> None:
        if self._stop_requested.is_set():
            raise RuntimeError("Overlay runtime is stopping.")
        if self._restart_attempts >= MAX_RESTARTS:
            raise RuntimeError("Overlay process is unavailable (restart limit reached).")
        self._restart_attempts += 1
        self._logger.warning("Restarting overlay process (%s/%s).", self._restart_attempts, MAX_RESTARTS)
        self._spawn_process_locked()

    def _send_command_locked(self, command: str, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.poll() is not None:
            raise RuntimeError("Overlay process is not running.")
        message = {
            "protocolVersion": PROTOCOL_VERSION,
            "command": command,
            "payload": payload,
        }
        # Command channel: JSONL over Windows named pipe.
        message_line = json.dumps(message) + "\n"
        self._write_pipe_line(message_line)

    def _write_pipe_line(self, line: str, retries: int = 20, retry_delay_s: float = 0.1) -> None:
        # Retry briefly to absorb startup races before pipe server is ready.
        last_error: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                with open(self._pipe_path, "w", encoding="utf-8", newline="\n") as pipe_writer:
                    pipe_writer.write(line)
                    pipe_writer.flush()
                return
            except Exception as exc:
                last_error = exc
                time.sleep(retry_delay_s)
        raise RuntimeError(f"Failed to write to overlay pipe {self._pipe_path}: {last_error}")

    def _read_stdout_loop(self) -> None:
        # Event channel: child stdout emits JSON event envelopes.
        process = self._process
        if process is None or process.stdout is None:
            return

        for line in process.stdout:
            text = line.strip()
            if not text:
                continue
            try:
                event = json.loads(text)
            except Exception:
                continue

            if not isinstance(event, dict):
                continue
            self._events.put(event)
            self._handle_event(event)

        if not self._stop_requested.is_set():
            self._handle_process_exit()

    def _read_stderr_loop(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        for line in process.stderr:
            text = line.strip()
            if text:
                self._logger.info("overlay stderr: %s", text)

    def _handle_event(self, event: dict[str, Any]) -> None:
        if event.get("protocolVersion") != PROTOCOL_VERSION:
            self._logger.warning("Ignoring overlay event with incompatible protocol: %s", event)
            return

        event_name = event.get("event")
        if event_name == "ready":
            # Bridge includes overlayHwnd so perceive() can exclude overlay window.
            payload = event.get("payload")
            if isinstance(payload, dict):
                hwnd = payload.get("overlayHwnd")
                if isinstance(hwnd, int) and hwnd > 0:
                    self._overlay_hwnd = hwnd
                    self._logger.info("overlay hwnd updated from ready event: %s", hwnd)
            self._ready.set()
            self._rehydrate_state()
        elif event_name == "error":
            self._logger.error("Overlay error event: %s", event.get("payload"))
        elif event_name == "interaction":
            self._logger.info("Overlay interaction event: %s", event.get("payload"))

    def _rehydrate_state(self) -> None:
        # Replay current indicators after restart so UI state survives crashes.
        with self._lock:
            if not self._is_running():
                return
            try:
                self._send_command_locked("hideAll", {})
                for indicator in self._indicators:
                    self._send_command_locked("indicate", {"indicator": indicator})
            except Exception as exc:
                self._logger.warning("Failed to rehydrate overlay state: %s", exc)

    def _handle_process_exit(self) -> None:
        with self._lock:
            process = self._process
            if process is None:
                return
            exit_code = process.poll()
            self._logger.warning("Overlay process exited with code %s.", exit_code)
            try:
                self._attempt_restart_locked()
            except Exception as exc:
                self._logger.error("Overlay restart failed: %s", exc)
                return

        # Wait briefly for a ready event, then try to restore state once more.
        for _ in range(20):
            if self._ready.is_set():
                return
            time.sleep(0.1)
