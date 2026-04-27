from __future__ import annotations

import json
import signal
import sys
import threading
import time
import ctypes
from pathlib import Path

from clr_loader import get_coreclr
from pythonnet import set_runtime
from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QApplication, QWidget

set_runtime(get_coreclr())

import clr  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[1]
_DLL = (
    _REPO_ROOT
    / "core"
    / "Pupil.Core"
    / "bin"
    / "Release"
    / "net8.0"
    / "Pupil.Core.dll"
)

TYPE_COLORS = {
    "TextControl": "#FFD93D",
    "GroupControl": "#74C0FC",
    "ButtonControl": "#69DB7C",
}
DEFAULT_COLOR = "#00FFFF"
FILL_ALPHA = int(255 * 0.14)


class Scanner(QObject):
    updated = Signal(list)

    def __init__(self, perceive, overlay_hwnd: int):
        super().__init__()
        self._perceive = perceive
        self._overlay_hwnd = overlay_hwnd
        self._running = False
        self._loop_idx = 0

    def start(self) -> None:
        self._running = True
        self._schedule()

    def stop(self) -> None:
        self._running = False

    def _schedule(self) -> None:
        if self._running:
            threading.Thread(target=self._run_once, daemon=True).start()

    def _run_once(self) -> None:
        self._loop_idx += 1
        t0 = time.perf_counter()
        payload = self._perceive(self._overlay_hwnd)
        dt_ms = (time.perf_counter() - t0) * 1000.0

        try:
            elements = json.loads(payload)
            if not isinstance(elements, list):
                elements = []
        except Exception:
            elements = []

        print(f"loop {self._loop_idx}: {dt_ms:.1f} ms | nodes: {len(elements)}", flush=True)
        if self._running:
            self.updated.emit(elements)


class Overlay(QWidget):
    def __init__(self):
        super().__init__()
        self.elements: list[dict] = []
        self._origin_x = 0
        self._origin_y = 0
        self._scale = 1.0

        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
            | Qt.WindowTransparentForInput
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_DeleteOnClose)

        # Use virtual desktop coordinates so absolute Win32 screen rects align.
        vrect = QApplication.primaryScreen().virtualGeometry()
        self._origin_x = vrect.x()
        self._origin_y = vrect.y()
        self.setGeometry(vrect)
        self.show()
        self._refresh_scale()

    def _refresh_scale(self) -> None:
        """Map Win32 physical pixels to Qt logical coordinates."""
        try:
            hwnd = int(self.winId())
            dpi = ctypes.windll.user32.GetDpiForWindow(hwnd)
            if dpi > 0:
                self._scale = 96.0 / float(dpi)
        except Exception:
            self._scale = 1.0

    def set_elements(self, elements: list[dict]) -> None:
        self.elements = elements
        self.update()

    def paintEvent(self, _event):
        if not self.elements:
            return

        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        for el in self.elements:
            rect = el.get("rect", {})
            # Convert absolute Win32 physical coords -> Qt logical local coords.
            x = int((int(rect.get("x", 0)) - self._origin_x) * self._scale)
            y = int((int(rect.get("y", 0)) - self._origin_y) * self._scale)
            w = int(int(rect.get("w", 0)) * self._scale)
            h = int(int(rect.get("h", 0)) * self._scale)
            if w <= 0 or h <= 0:
                continue

            color = QColor(TYPE_COLORS.get(el.get("type", ""), DEFAULT_COLOR))
            fill = QColor(color)
            fill.setAlpha(FILL_ALPHA)

            painter.fillRect(x, y, w, h, fill)
            pen = QPen(color)
            pen.setWidth(1)
            painter.setPen(pen)
            painter.drawRect(x, y, w, h)


def _ensure_dll() -> None:
    if not _DLL.is_file():
        print(f"DLL not found: {_DLL}", file=sys.stderr)
        print(r"Build first: .\scripts\build-core.ps1", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    _ensure_dll()
    clr.AddReference(str(_DLL.resolve()))
    from Pupil.Core import PerceptionApi  # noqa: PLC0415

    app = QApplication(sys.argv)
    overlay = Overlay()
    overlay_hwnd = int(overlay.winId())

    scanner = Scanner(PerceptionApi.Perceive, overlay_hwnd)
    scanner.updated.connect(overlay.set_elements)
    scanner.updated.connect(lambda _els: QTimer.singleShot(0, scanner._schedule))
    scanner.start()

    signal.signal(signal.SIGINT, lambda *_: app.quit())
    sigint_timer = QTimer()
    sigint_timer.start(200)
    sigint_timer.timeout.connect(lambda: None)

    VK_ESCAPE = 0x1B
    esc_timer = QTimer()
    esc_timer.start(100)
    esc_timer.timeout.connect(
        lambda: app.quit() if ctypes.windll.user32.GetAsyncKeyState(VK_ESCAPE) & 0x8000 else None
    )

    try:
        sys.exit(app.exec())
    finally:
        scanner.stop()


if __name__ == "__main__":
    main()
