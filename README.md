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

### Indicator buttons & lifecycle

Every `indicate` call blocks until the user resolves it (`await` defaults to `true`). The card always renders a footer in the bottom-right; the buttons depend on the indicator's `type`:

- `info` / `warning` / `wait` / `action` / `danger`: a single **Next** button. Resolves `"done"`. Performs no OS-level action.
- `click`: **Skip** (resolves `"skipped"`) and **Accept** (performs an OS-level left click at the bounding-box center, then resolves `"done"`).
- `type`: **Skip** and **Accept**. Accept clicks the bounding-box center to focus the target field, then types the indicator's `value` string, then resolves `"done"`.
- `shortcut`: **Skip** and **Accept**. Accept runs the chord sequence listed in `keys` — a **list of chord steps**, where each chord is an array of `nut-js` `Key` names (e.g. `[["LeftControl", "L"]]` for a single chord, or `[["LeftControl", "A"], ["Backspace"]]` for select-all-then-delete). Steps run sequentially with a fixed ~50ms delay between them inside a single Accept. If `bounds` are provided, Accept first clicks the bounding-box center to focus that control and then fires the chord sequence — pass `bounds` whenever you need it to reach a specific window. If `bounds` are omitted, the daemon best-effort blurs the overlay so Windows reverts focus to the previously foreground window before sending the chord; this works for global shortcuts but is unreliable for app-specific ones.

Pressing the **Tab** key fires the topmost indicator's primary action (Accept where present, otherwise Next). The X button always resolves as `"skipped"` and removes the card. After Next/Accept fires, the card stays visible with a loading spinner where the Tab keycap was; the next `indicate(append=false)` call (or `hideAll`) clears it.

The `value` field on the indicator is only meaningful for `type="type"`; the `keys` field is only meaningful for `type="shortcut"` and must be a non-empty array of non-empty chord arrays (a single chord still needs to be wrapped, e.g. `[["LeftControl", "L"]]`). Both are ignored for other types.

### Cursor MCP registration (example)

Configure a local MCP server command that launches:

- command: `python`
- args: `[".\\mcp\\main.py"]`
- working directory: repository root
