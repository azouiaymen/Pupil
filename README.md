# Pupil

**Let agents perceive, indicate, and act in any application.**

## Build (Windows)

From the repository root:

- `.\scripts\build.ps1` — builds the .NET core (`core\build.ps1`), copies `pupil-core.exe` into `app\vendor\win32-x64\`, then runs `pnpm install` and `pnpm rebuild electron` under `app\`.

## Smoke checks

- `.\scripts\smoke.ps1` — Python syntax checks for the MCP package, bridge checks under `overlay\`, and prints a short manual integration checklist.

## MCP server (v1)

The Python MCP server lives in `mcp/main.py` and exposes these tools:

- `perceive(overlay_hwnd: int | None = None) -> list[dict]`
- `indicate_rect(x: int, y: int, w: int, h: int, color: str = "#00FFFF", alpha: float = 0.14) -> dict`
- `clear() -> dict`

### Run locally

1. Run `.\scripts\build.ps1` so the native sidecar and Electron app dependencies are present.
2. Install Python dependencies (including `mcp` SDK).
3. Start server over stdio:
   - `python .\mcp\main.py`

### Tool contract

- `perceive` returns parsed UI nodes from `PerceptionApi.Perceive`.
- `perceive` automatically excludes the overlay window by default.
- `indicate_rect` draws one highlighted rectangle and replaces any previous one.
- `clear` removes the current overlay rectangle.
- If the sidecar or DLL is missing, run `.\scripts\build.ps1` first.

### Cursor MCP registration (example)

Configure a local MCP server command that launches:

- command: `python`
- args: `[".\\mcp\\main.py"]`
- working directory: repository root
