from typing import Any

from mcp.server.fastmcp import FastMCP
from overlay_runtime import OverlayRuntime

mcp = FastMCP("Pupil")
overlay_runtime = OverlayRuntime()


@mcp.tool(name="perceive")
def perceive_mcp(overlay_hwnd: int = 0) -> list[dict]:
    """Capture visible UI elements and return parsed nodes.

    `overlay_hwnd` defaults to the current runtime overlay handle when 0.
    """
    try:
        from bridge import DllNotFoundError, PerceiveCallError, RuntimeInitError, perceive
    except Exception as exc:
        raise RuntimeError(f"Bridge import failed: {exc}") from exc

    effective_overlay_hwnd = overlay_hwnd or overlay_runtime.overlay_hwnd
    try:
        result: list[dict[str, Any]] = perceive(overlay_hwnd=effective_overlay_hwnd)
        return [dict(item) for item in result]
    except DllNotFoundError as exc:
        raise RuntimeError(str(exc)) from exc
    except (RuntimeInitError, PerceiveCallError) as exc:
        raise RuntimeError(f"Perception unavailable: {exc}") from exc


@mcp.tool(name="indicate")
def indicate(indicator: dict[str, Any]) -> dict:
    """
    Render an overlay indicator with optional bounds and floating tooltip.

    Expected payload shape:
      {
        "type": "info" | "warning" | "wait" | "action" | "click" | "type",
        "bounds"?: {"x": int, "y": int, "width": int, "height": int},
        "title"?: str,
        "text"?: str,
        "append"?: bool  # default false
      }
    """
    try:
        normalized = overlay_runtime.normalize_indicator(indicator)
        overlay_runtime.indicate(normalized)
    except Exception as exc:
        raise RuntimeError(f"Overlay update failed: {exc}") from exc
    return {"ok": True, "indicator": normalized}


def main() -> None:
    overlay_runtime.start()
    mcp.run()


if __name__ == "__main__":
    main()
