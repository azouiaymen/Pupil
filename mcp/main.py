from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Pupil")


@mcp.tool(name="perceive")
def perceive_mcp(overlay_hwnd: int = 0) -> list[dict]:
    """Capture visible UI elements and return parsed nodes."""
    try:
        from bridge import DllNotFoundError, PerceiveCallError, RuntimeInitError, perceive
    except Exception as exc:
        raise RuntimeError(f"Bridge import failed: {exc}") from exc

    try:
        result: list[dict[str, Any]] = perceive(overlay_hwnd=overlay_hwnd)
        return [dict(item) for item in result]
    except DllNotFoundError as exc:
        raise RuntimeError(str(exc)) from exc
    except (RuntimeInitError, PerceiveCallError) as exc:
        raise RuntimeError(f"Perception unavailable: {exc}") from exc


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
