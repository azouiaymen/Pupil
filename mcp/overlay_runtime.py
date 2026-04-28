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

PROTOCOL_VERSION = 2
INDICATOR_TYPES = {"info", "warning", "wait", "action", "click", "type"}
DEFAULT_STARTUP_TIMEOUT_S = 45.0
MAX_RESTARTS = 3
AWAIT_POLL_INTERVAL_S = 0.2
HEARTBEAT_INTERVAL_S = 2.0
COMMAND_ACK_TIMEOUT_S = 2.0
AWAIT_RESULT_TIMEOUT_S = 180.0
READY_WAIT_AFTER_RESTART_S = 2.0


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
        self._process_generation = 0
        self._restart_in_progress = False
        self._ready = threading.Event()
        self._stop_requested = threading.Event()
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._heartbeat_thread: threading.Thread | None = None
        self._session_id = f"session-{uuid.uuid4().hex[:16]}"
        self._pending_acks: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._indicator_waiters: dict[str, queue.Queue[str]] = {}
        self._lock = threading.Lock()
        self._indicators: list[dict[str, Any]] = []
        self._restart_attempts = 0
        self._logger = logging.getLogger(__name__)
        self._state = "starting"

        # Filled after bridge sends `ready` with native window handle.
        self._overlay_hwnd = 0
        self._overlay_hwnd_warning_logged = False
        atexit.register(self.stop)

    @property
    def overlay_hwnd(self) -> int:
        return self._overlay_hwnd

    @property
    def state(self) -> str:
        return self._state

    def _set_state(self, next_state: str) -> None:
        self._state = next_state

    def warn_if_overlay_hwnd_unset(self) -> None:
        # Helps diagnose perceive() calls that happen before ready/handshake completes.
        if self._overlay_hwnd > 0:
            self._overlay_hwnd_warning_logged = False
            return
        if self._overlay_hwnd_warning_logged:
            return
        self._logger.warning("overlay hwnd is 0; perceive() may include overlay or miss foreground context.")
        self._overlay_hwnd_warning_logged = True

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

        await_response = payload.get("await", False)
        if not isinstance(await_response, bool):
            raise ValueError("await must be a boolean when provided.")
        normalized["await"] = await_response

        indicator_id = payload.get("id")
        if indicator_id is not None:
            if not isinstance(indicator_id, str) or not indicator_id.strip():
                raise ValueError("id must be a non-empty string when provided.")
            normalized["id"] = indicator_id
        return normalized

    def start(self, startup_timeout_s: float = DEFAULT_STARTUP_TIMEOUT_S) -> None:
        # Start one overlay process and wait until renderer signals `ready`.
        with self._lock:
            if self._is_running():
                return
            self._restart_attempts = 0
            self._set_state("starting")
            self._spawn_process_locked()

        if not self._ready.wait(startup_timeout_s):
            self.stop()
            raise RuntimeError("Overlay startup timed out waiting for ready signal.")
        try:
            with self._lock:
                self._send_command_locked("ping", {}, wait_ack=True)
        except Exception as exc:
            self._logger.warning("overlay startup ping failed: %s", exc)
        self._start_heartbeat_thread()
        self._set_state("active")

    def stop(self) -> None:
        self._stop_requested.set()
        self._set_state("stopping")
        with self._lock:
            process = self._process
            self._process = None
            self._overlay_hwnd = 0
            self._pending_acks.clear()
            self._indicator_waiters.clear()
        if process is None:
            self._set_state("stopped")
            return
        try:
            with self._lock:
                if process.poll() is None:
                    self._send_command_locked("shutdown", {}, wait_ack=True, timeout_s=1.25)
        except Exception:
            pass
        try:
            process.terminate()
            process.wait(timeout=2.5)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
        self._set_state("stopped")

    def indicate(self, indicator: dict[str, Any]) -> str | None:
        # append=True keeps previous indicators, append=False replaces all.
        if "id" not in indicator:
            indicator["id"] = f"ind-{uuid.uuid4().hex[:10]}"
        indicator_id = indicator["id"]
        append = bool(indicator.get("append", False))
        await_response = bool(indicator.get("await", False))
        with self._lock:
            self._ensure_running_locked()
            if append:
                self._indicators.append(indicator)
                self._send_command_locked("indicate", {"indicator": indicator})
            else:
                self._indicators = [indicator]
                self._send_command_locked("hideAll", {})
                self._send_command_locked("indicate", {"indicator": indicator})

        if not await_response:
            return None
        return self._wait_for_indicator_resolution(indicator_id, timeout_s=AWAIT_RESULT_TIMEOUT_S)

    def _wait_for_indicator_resolution(self, indicator_id: str, timeout_s: float) -> str:
        started = time.time()
        waiter = queue.Queue[str]()
        with self._lock:
            self._indicator_waiters[indicator_id] = waiter
        try:
            while True:
                try:
                    return waiter.get(timeout=AWAIT_POLL_INTERVAL_S)
                except queue.Empty:
                    if self._stop_requested.is_set():
                        raise RuntimeError("Overlay runtime stopped while waiting for indicator response.")
                    if time.time() - started > timeout_s:
                        raise RuntimeError(f"Timed out waiting for indicator response: {indicator_id}")
        finally:
            with self._lock:
                self._indicator_waiters.pop(indicator_id, None)

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
        # Lets the bridge detect parent death even if stdio/socket teardown is delayed.
        env["PUPIL_PARENT_PID"] = str(os.getpid())
        env["PUPIL_OVERLAY_SESSION_ID"] = self._session_id
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
        self._process_generation += 1

    def _start_heartbeat_thread(self) -> None:
        thread = self._heartbeat_thread
        if thread is not None and thread.is_alive():
            return
        self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True, name="overlay-heartbeat")
        self._heartbeat_thread.start()

    def _heartbeat_loop(self) -> None:
        # Keep bridge liveness tied to this runtime. If runtime disappears, bridge self-terminates.
        while not self._stop_requested.is_set():
            try:
                with self._lock:
                    if self._is_running():
                        self._send_command_locked("ping", {})
            except Exception as exc:
                self._logger.debug("overlay heartbeat ping failed: %s", exc)
            time.sleep(HEARTBEAT_INTERVAL_S)

    def _is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _ensure_running_locked(self) -> None:
        if self._is_running():
            return
        # Lazily recover after crashes when a new command is sent.
        self._attempt_restart_locked()

    def _attempt_restart_locked(self) -> None:
        if self._restart_in_progress:
            raise RuntimeError("Overlay restart already in progress.")
        if self._stop_requested.is_set():
            raise RuntimeError("Overlay runtime is stopping.")
        if self._restart_attempts >= MAX_RESTARTS:
            raise RuntimeError("Overlay process is unavailable (restart limit reached).")
        self._restart_in_progress = True
        self._restart_attempts += 1
        self._logger.warning("Restarting overlay process (%s/%s).", self._restart_attempts, MAX_RESTARTS)
        self._set_state("starting")
        self._overlay_hwnd = 0
        self._ready.clear()
        try:
            self._spawn_process_locked()
        finally:
            self._restart_in_progress = False

    def _send_command_locked(
        self,
        command: str,
        payload: dict[str, Any],
        *,
        wait_ack: bool = True,
        timeout_s: float = COMMAND_ACK_TIMEOUT_S,
    ) -> None:
        process = self._process
        if process is None or process.poll() is not None:
            raise RuntimeError("Overlay process is not running.")
        request_id = f"req-{uuid.uuid4().hex[:12]}"
        message = {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": self._session_id,
            "requestId": request_id,
            "command": command,
            "payload": payload,
        }
        ack_queue: queue.Queue[dict[str, Any]] | None = None
        if wait_ack:
            ack_queue = queue.Queue(maxsize=1)
            self._pending_acks[request_id] = ack_queue
        # Command channel: JSONL over Windows named pipe.
        message_line = json.dumps(message) + "\n"
        try:
            self._write_pipe_line(message_line)
            if not wait_ack or ack_queue is None:
                return
            try:
                ack_event = ack_queue.get(timeout=timeout_s)
            except queue.Empty as exc:
                raise RuntimeError(f"Overlay command timed out waiting ack: {command}") from exc
            event_name = ack_event.get("event")
            if event_name == "error":
                payload_obj = ack_event.get("payload")
                message_text = payload_obj.get("message") if isinstance(payload_obj, dict) else "unknown"
                raise RuntimeError(f"Overlay command failed ({command}): {message_text}")
            if event_name != "ack":
                raise RuntimeError(f"Unexpected overlay response for {command}: {event_name}")
        finally:
            self._pending_acks.pop(request_id, None)

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
            self._handle_event(event)

        if not self._stop_requested.is_set():
            self._handle_process_exit(process)

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

        if event.get("sessionId") != self._session_id:
            self._logger.debug("Ignoring stale overlay event from session %s", event.get("sessionId"))
            return

        request_id = event.get("requestId")
        if isinstance(request_id, str):
            ack_queue = self._pending_acks.get(request_id)
            if ack_queue is not None:
                try:
                    ack_queue.put_nowait(event)
                except queue.Full:
                    pass

        event_name = event.get("event")
        if event_name == "ready":
            # Bridge includes overlayHwnd so perceive() can exclude overlay window.
            payload = event.get("payload")
            if isinstance(payload, dict):
                hwnd = payload.get("overlayHwnd")
                if isinstance(hwnd, int) and hwnd > 0:
                    self._overlay_hwnd = hwnd
                    self._logger.debug("overlay hwnd updated from ready event: %s", hwnd)
            self._restart_attempts = 0
            self._ready.set()
            self._set_state("ready")
            self._rehydrate_state()
        elif event_name == "ack":
            return
        elif event_name == "error":
            self._logger.error("Overlay error event: %s", event.get("payload"))
        elif event_name == "interaction":
            payload = event.get("payload")
            if isinstance(payload, dict):
                indicator_id = payload.get("indicatorId")
                if isinstance(indicator_id, str) and indicator_id:
                    with self._lock:
                        self._indicators = [item for item in self._indicators if item.get("id") != indicator_id]
                if payload.get("type") == "pong":
                    return
                if payload.get("type") == "indicator_resolved" and isinstance(indicator_id, str):
                    result = payload.get("result")
                    if result in {"done", "skipped"}:
                        waiter = self._indicator_waiters.get(indicator_id)
                        if waiter is not None:
                            try:
                                waiter.put_nowait(result)
                            except queue.Full:
                                pass
            self._logger.debug("Overlay interaction event: %s", payload)

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

    def _handle_process_exit(self, exited_process: subprocess.Popen[str]) -> None:
        with self._lock:
            process = self._process
            if process is None:
                return
            if process is not exited_process:
                return
            exit_code = process.poll()
            self._logger.warning("Overlay process exited with code %s.", exit_code)
            self._overlay_hwnd = 0
            self._set_state("orphaned")
            try:
                self._attempt_restart_locked()
            except Exception as exc:
                self._logger.error("Overlay restart failed: %s", exc)
                return

        # Wait briefly for a ready event, then try to restore state once more.
        for _ in range(int(READY_WAIT_AFTER_RESTART_S / 0.1)):
            if self._ready.is_set():
                return
            time.sleep(0.1)
