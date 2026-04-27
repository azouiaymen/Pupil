# Pupil

**Let agents perceive, indicate, and act in any application.**

## MCP server (v1)

The Python MCP server lives in `mcp/main.py` and exposes one tool: `perceive`.

### Run locally

1. Build the .NET DLL:
   - `.\scripts\build-core.ps1`
2. Install Python dependencies (including `mcp` SDK).
3. Start server over stdio:
   - `python .\mcp\main.py`

### Tool contract

- `perceive(overlay_hwnd: int = 0) -> list[dict]`
- Returns parsed UI nodes from `PerceptionApi.Perceive`.
- If the DLL is missing, build first with `.\scripts\build-core.ps1`.

### Cursor MCP registration (example)

Configure a local MCP server command that launches:

- command: `python`
- args: `[".\\mcp\\main.py"]`
- working directory: repository root
