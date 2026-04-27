from __future__ import annotations

import ctypes
import threading
from dataclasses import dataclass

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QApplication, QWidget


DEFAULT_COLOR = "#00FFFF"
DEFAULT_ALPHA = 0.14


@dataclass
class RectSpec:
    x: int
    y: int
    w: int
    h: int
    color: str = DEFAULT_COLOR
    alpha: float = DEFAULT_ALPHA


class OverlayWidget(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self._rect_spec: RectSpec | None = None
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

        vrect = QApplication.primaryScreen().virtualGeometry()
        self._origin_x = vrect.x()
        self._origin_y = vrect.y()
        self.setGeometry(vrect)
        self.show()
        self._refresh_scale()

    def _refresh_scale(self) -> None:
        try:
            hwnd = int(self.winId())
            dpi = ctypes.windll.user32.GetDpiForWindow(hwnd)
            if dpi > 0:
                self._scale = 96.0 / float(dpi)
        except Exception:
            self._scale = 1.0

    def set_rect_spec(self, rect_spec: RectSpec) -> None:
        self._rect_spec = rect_spec
        self.update()

    def clear_rect(self) -> None:
        self._rect_spec = None
        self.update()

    def paintEvent(self, _event) -> None:  # noqa: N802
        if self._rect_spec is None:
            return

        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        rect = self._rect_spec

        x = int((rect.x - self._origin_x) * self._scale)
        y = int((rect.y - self._origin_y) * self._scale)
        w = int(rect.w * self._scale)
        h = int(rect.h * self._scale)
        if w <= 0 or h <= 0:
            return

        color = QColor(rect.color)
        fill = QColor(color)
        fill.setAlpha(int(255 * max(0.0, min(1.0, rect.alpha))))

        painter.fillRect(x, y, w, h, fill)
        pen = QPen(color)
        pen.setWidth(2)
        painter.setPen(pen)
        painter.drawRect(x, y, w, h)


class OverlayCommandBus(QObject):
    set_rect_signal = Signal(int, int, int, int, str, float)
    clear_signal = Signal()


class OverlayRuntime:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._overlay_hwnd = 0
        self._widget: OverlayWidget | None = None
        self._bus: OverlayCommandBus | None = None

    @property
    def overlay_hwnd(self) -> int:
        return self._overlay_hwnd

    def start(self, startup_timeout_s: float = 5.0) -> None:
        if self._thread is not None and self._thread.is_alive():
            return

        self._ready.clear()
        self._thread = threading.Thread(target=self._run_qt, daemon=True, name="pupil-overlay")
        self._thread.start()

        if not self._ready.wait(startup_timeout_s):
            raise RuntimeError("Overlay startup timed out.")
        if self._overlay_hwnd <= 0:
            raise RuntimeError("Overlay failed to initialize a valid window handle.")

    def set_rect(self, x: int, y: int, w: int, h: int, color: str, alpha: float) -> None:
        if self._bus is None:
            raise RuntimeError("Overlay runtime is not initialized.")
        self._bus.set_rect_signal.emit(x, y, w, h, color, alpha)

    def clear(self) -> None:
        if self._bus is None:
            raise RuntimeError("Overlay runtime is not initialized.")
        self._bus.clear_signal.emit()

    def _run_qt(self) -> None:
        app = QApplication.instance() or QApplication([])
        widget = OverlayWidget()
        bus = OverlayCommandBus()

        bus.set_rect_signal.connect(
            lambda x, y, w, h, color, alpha: widget.set_rect_spec(RectSpec(x, y, w, h, color, alpha))
        )
        bus.clear_signal.connect(widget.clear_rect)

        self._widget = widget
        self._bus = bus
        self._overlay_hwnd = int(widget.winId())
        self._ready.set()
        app.exec()
