# Pupil

**Let agents perceive, indicate, and act in any application.**

## Build (Windows)

From the repository root:

- `.\scripts\build.ps1` — builds the .NET core (`core\build.ps1`), copies `pupil-core.exe` into `app\vendor\win32-x64\`, then runs `pnpm install` and `pnpm rebuild electron` under `app\`.

## Smoke checks

- `.\scripts\smoke.ps1` — Python syntax checks for the MCP package, bridge checks under `overlay\`, and prints a short manual integration checklist.

## Stop stuck processes (Windows)

- `.\scripts\kill.ps1` — force-stops the Pupil Electron daemon (only processes whose command line includes `daemon\main.cjs`) and any `pupil-core.exe` sidecars. Use before `.\scripts\build.ps1` if copies fail because files are locked.

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

### Node MCP shim (`app/src/shim`) — indicator shape

`perceive` takes **no arguments**. `indicate` takes a **flat** object (no nested `indicator` wrapper):

- `type` — `info` | `warning` | `wait` | `action` | `click` | `input` | `danger`
- `coords` — optional string `"x,y,w,h"` (integers, `w` and `h` positive). **Required** for `click` only; optional for `input` (recommended when a specific control must receive focus before chords).
- `desc` — optional extra copy; omit unless it adds information the highlight does not (do not repeat the control label).
- `value` — **required** for `input` only: object `{ clip?: string, chords: string[][] }`. `chords` is a non-empty list of chord steps (nut-js `Key` names per chord, modifiers first, ~50ms between steps). Optional `clip`: before chords run, the daemon saves the current plain-text clipboard, writes `clip`, runs `chords` (typically including `Ctrl+V`), then restores the saved text in a `finally` so failures do not leave `clip` on the clipboard. **Accept on `click`** performs a single OS click at the **center** of the `coords` bbox. **Accept on `input` with `coords`** does the same center click first to focus, then runs clipboard + chords as above; **without `coords`**, the daemon blurs the overlay and sends chords to the previous foreground window (best-effort).

Every `indicate` call **replaces** any prior card and **blocks** until the user resolves it. The card header label is derived from `type`. Footer buttons:

- `info` / `warning` / `wait` / `action` / `danger`: **Next** only (Tab). Resolves `"done"`.
- `click` / `input`: **Skip** (**Escape**) + **Accept** (**Tab**). Accept runs the OS action, then resolves `"done"`.

After Next/Accept, the card shows a spinner until the **next** `indicate` clears it. **X** resolves `"skipped"`.

On success, the MCP tool response is JSON text shaped like:

```json
{ "result": "done", "perceive": "<compact CSV; same schema as perceive tool>" }
```

Each `indicate` returns the next `perceive` snapshot (taken ~50ms after the resolved action), so a separate `perceive()` is only needed for the very first read (or after a long external delay or user-side change outside Pupil). In that bundled CSV only, each row’s `name` field is truncated after 100 characters with `...` appended; the standalone `perceive` tool does not truncate names.

### Indicator buttons & lifecycle (Python `mcp/main.py`)

Legacy rectangle overlay; see Node shim above for the full Pupil indicator model.

### Cursor MCP registration (example)

Configure a local MCP server command that launches:

- command: `python`
- args: `[".\\mcp\\main.py"]`
- working directory: repository root
