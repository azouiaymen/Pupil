# Pupil

**Let agents perceive, indicate, and act in any application.**

## MCP server (v1)

The Python MCP server lives in `mcp/main.py` and exposes these tools:

- `perceive(overlay_hwnd: int | None = None) -> list[dict]`
- `indicate_rect(x: int, y: int, w: int, h: int, color: str = "#00FFFF", alpha: float = 0.14) -> dict`
- `clear() -> dict`

### Run locally

1. Build the .NET DLL:
   - `.\scripts\build-core.ps1`
2. Install Python dependencies (including `mcp` SDK).
3. Start server over stdio:
   - `python .\mcp\main.py`

### Tool contract

- `perceive` returns parsed UI nodes from `PerceptionApi.Perceive`.
- `perceive` automatically excludes the overlay window by default.
- `indicate_rect` draws one highlighted rectangle and replaces any previous one.
- `clear` removes the current overlay rectangle.
- If the DLL is missing, build first with `.\scripts\build-core.ps1`.

### Cursor MCP registration (example)

Configure a local MCP server command that launches:

- command: `python`
- args: `[".\\mcp\\main.py"]`
- working directory: repository root
