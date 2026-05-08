# MCP & indicator contract

Reference for the two MCP servers that ship with Pupil.

## Node MCP shim — `app/src/shim`

The shim is the **primary** server. It exposes two tools backed by the Electron overlay daemon and the `pupil-core.exe` sidecar.

### `perceive`

Takes **no arguments**. Returns a compact CSV of currently visible UI elements (the Pupil overlay window is excluded by default).

Use it once at the start of a workflow. After that, prefer the `perceive` field bundled in the previous `indicate` result.

### `indicate`

Shows one overlay card and (depending on `type`) optionally executes one OS action. Each call **replaces** any prior card and **blocks** until the user resolves it.

Flat object, no nested wrapper:

- `type` — one of `info` | `warning` | `wait` | `action` | `click` | `input` | `danger`.
- `coords` — string `"x,y,w,h"` (integers, `w` and `h` positive).
  - **Required** for `click`.
  - Optional for `input` (recommended when a specific control must receive focus before chords).
- `desc` — optional extra copy. Omit unless it adds information the highlight does not (don't repeat the control label).
- `value` — **required for `input` only**: object `{ clip?: string, chords: string[][] }`.
  - `chords`: non-empty list of chord steps (nut-js `Key` names per chord, modifiers first, ~50 ms between steps).
  - `clip` (optional): the daemon saves the current plain-text clipboard, writes `clip`, runs the chords (typically including `Ctrl+V`), then restores the saved text in a `finally` so failures don't leave `clip` on the clipboard.

#### Accept semantics

- `click` — single OS click at the **center** of the `coords` bbox.
- `input` with `coords` — center-click first to focus, then clipboard + chords as above.
- `input` without `coords` — daemon blurs the overlay and sends chords to the previous foreground window (best-effort).

#### Footer buttons

- `info` / `warning` / `wait` / `action` / `danger` — **Next** only (Tab). Resolves `"done"`.
- `click` / `input` — **Skip** (Escape) + **Accept** (Tab). Accept runs the OS action, then resolves `"done"`.
- **X** always resolves `"skipped"`.

After Next/Accept, the card shows a spinner until the **next** `indicate` clears it.

#### Automation preference

Prioritize `click` on a control listed in `perceive` over `input` with keyboard shortcuts when both achieve the same result (click **Save** instead of `Ctrl+S`, **OK** instead of `Enter`). Use `input` for typing and paste, shortcuts without a reliable on-screen target, or when no suitable row exists.

#### Response shape

```json
{ "result": "done", "perceive": "<compact CSV; same schema as perceive tool>" }
```

Each `indicate` returns the next `perceive` snapshot (taken ~50 ms after the resolved action), so a separate `perceive()` is only needed for the very first read or after an external change outside Pupil. In that bundled CSV only, each row's `name` field is truncated after 100 characters with `...` appended; the standalone `perceive` tool does not truncate names.

## Python MCP server — `mcp/main.py`

Legacy rectangle overlay. Useful for low-level work and as a minimal reference implementation. The Node shim covers the full Pupil indicator model and is what most agents should target.

Tools:

- `perceive(overlay_hwnd: int | None = None) -> list[dict]` — parsed UI nodes from `PerceptionApi.Perceive`. Excludes the overlay by default.
- `indicate_rect(x: int, y: int, w: int, h: int, color: str = "#00FFFF", alpha: float = 0.14) -> dict` — draws one highlighted rectangle, replacing any previous one.
- `clear() -> dict` — removes the current overlay rectangle.

If the sidecar or DLL is missing, run `.\scripts\build.ps1` first.

## Cursor MCP registration (recommended)

Use the Node entrypoint ([`app/bin/pupil-mcp.js`](../app/bin/pupil-mcp.js)) after `.\scripts\build.ps1`. Replace `<path-to-pupil-repo>` with your clone path:

```json
{
  "mcpServers": {
    "pupil": {
      "command": "node",
      "args": ["<path-to-pupil-repo>/app/bin/pupil-mcp.js"]
    }
  }
}
```

## Legacy: Python server (`mcp/main.py`)

Alternative stdio server for the older rectangle tools only:

- command: `python`
- args: `[".\\mcp\\main.py"]` (paths relative to **repository root** if you set `cwd` there, or use absolute paths)
- working directory: repository root (optional if args are absolute)
