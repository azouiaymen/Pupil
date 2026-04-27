from typing import Any

from mcp.server.fastmcp import FastMCP
from overlay_runtime import DEFAULT_ALPHA, DEFAULT_COLOR, OverlayRuntime

mcp = FastMCP("Pupil")
overlay_runtime = OverlayRuntime()


@mcp.tool(name="perceive")
def perceive_mcp(overlay_hwnd: int | None = None) -> list[dict]:
    """Capture visible UI elements and return parsed nodes."""
    try:
        from bridge import DllNotFoundError, PerceiveCallError, RuntimeInitError, perceive
    except Exception as exc:
        raise RuntimeError(f"Bridge import failed: {exc}") from exc

    effective_overlay_hwnd = overlay_hwnd if overlay_hwnd is not None else overlay_runtime.overlay_hwnd
    try:
        result: list[dict[str, Any]] = perceive(overlay_hwnd=effective_overlay_hwnd)
        return [dict(item) for item in result]
    except DllNotFoundError as exc:
        raise RuntimeError(str(exc)) from exc
    except (RuntimeInitError, PerceiveCallError) as exc:
        raise RuntimeError(f"Perception unavailable: {exc}") from exc


@mcp.tool(name="indicate_rect")
def indicate_rect(
    x: int,
    y: int,
    w: int,
    h: int,
    color: str = DEFAULT_COLOR,
    alpha: float = DEFAULT_ALPHA,
) -> dict:
    """Highlight one screen-space rectangle and replace any previous indicator."""
    if w <= 0 or h <= 0:
        raise RuntimeError("w and h must be positive integers.")
    if alpha < 0.0 or alpha > 1.0:
        raise RuntimeError("alpha must be between 0.0 and 1.0.")

    try:
        overlay_runtime.set_rect(x=x, y=y, w=w, h=h, color=color, alpha=alpha)
    except Exception as exc:
        raise RuntimeError(f"Overlay update failed: {exc}") from exc

    return {
        "ok": True,
        "rect": {"x": x, "y": y, "w": w, "h": h},
        "style": {"color": color, "alpha": alpha},
    }


@mcp.tool(name="clear")
def clear() -> dict:
    """Clear current overlay indicators."""
    try:
        overlay_runtime.clear()
    except Exception as exc:
        raise RuntimeError(f"Overlay clear failed: {exc}") from exc
    return {"ok": True}


def main() -> None:
    overlay_runtime.start()
    mcp.run()


if __name__ == "__main__":
    main()
