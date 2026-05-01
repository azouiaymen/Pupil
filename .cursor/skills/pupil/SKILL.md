---
name: pupil
description: Operates desktop applications through the Pupil MCP server by iterating perceive then indicate then accept, repeatedly, until the user's task is complete. Use whenever Pupil's `perceive` and `indicate` tools are available, or when the user asks to automate a Windows GUI, click or type into another application, run a multi-step desktop workflow, or guide a human through one step at a time.
---

# Using Pupil

Pupil exposes two MCP tools — `perceive` (read the current UI) and `indicate`
(highlight a target and optionally perform a click or type). Real GUI work is
**never one tool call**. Drive the loop below until the user's task is fully
done; do not stop after a single indicate.

## The core loop

For every task, repeat until the goal is reached or the user cancels:

```
1. perceive()                 → list of (id, type, name, x, y, w, h)
2. pick the next target node from the result
3. indicate({ type, bounds, title, text, value?, keys? })
4. wait for the resolution ("done" | "skipped")
5. if "skipped" → stop and report; otherwise loop back to step 1
```

`perceive` returns the live UI; never reuse coordinates from an earlier
`perceive` after an `indicate` that changed the screen — re-perceive first.
Each `indicate` blocks until the user (or you, via Accept) resolves it, so
the loop is naturally synchronous.

## Persistence: blocks are cards, not dead ends

Do **not** give up early. If something is missing, impossible from automation
alone, or you would otherwise ask the user for information you cannot infer,
**stay in the Pupil loop** instead of stopping in chat or writing long
free-form questions with no next step.

Use a non-destructive card type and plain, human `title` / `text` that say
what you observe and what you need — a natural “I’m stuck until you…” or “I
sense that … because I need you to …” tone is fine:

- **`wait`** — The UI is loading, syncing, or you need the user to finish
  something passive before you `perceive` again (e.g. “Wait until the spinner
  is gone, then Next.”).
- **`action`** — A concrete human step that has no good `click`/`type` target
  yet (e.g. “Open the file picker and choose the export CSV yourself, then
  Next so I can continue.”).
- **`warning`** — Something risky, ambiguous, or credential-related where you
  want the user to notice urgency before continuing (e.g. “I don’t see an
  active session — log in in the browser, then Next.”).

After the user presses **Next** / **Tab** (or you drive **Accept** on
`click`/`type`/`shortcut`), **re-`perceive`** and continue. Treat “I don’t
know that value” as “surface the gap on the overlay, then loop,” not as a
reason to abandon the task unless the user **Skip**s or cancels in chat.

Reserve **stopping** for real endings: goal met, explicit user decline, or
repeated `perceive` failure after you have already tried different paths and
surfaced at least one actionable card.

### Workflow checklist

Copy this into the conversation and tick items off as you go:

```
Task progress:
- [ ] perceive current screen
- [ ] identify next target node
- [ ] indicate the next step (with the right type)
- [ ] if blocked: indicate wait/action/warning with a clear ask — do not stop in chat only
- [ ] await resolution; if skipped, stop and report
- [ ] re-perceive before choosing the next target
- [ ] repeat until the user's goal is met
- [ ] final indicate(type=info, "done")
```

## Picking the right indicator type

Choose by what the next step actually is, not by what feels safe:

| Type       | Use it for                                                  |
|------------|-------------------------------------------------------------|
| `click`    | The next step is a single mouse click on a bounded target.  |
| `type`     | The next step is typing text into a bounded field.          |
| `shortcut` | The next step is a keyboard chord (e.g. Ctrl+A, Alt+Tab).   |
| `wait`     | Loading / settling UI, or “pause until the user finishes a passive step.” |
| `action`   | A human step you cannot (yet) automate — use the card to ask them to do it, then Next. |
| `warning`  | Sensitive or ambiguous situation — flag it, ask for confirmation or a fix, then continue. |
| `danger`   | Severe / safety-critical. Highest urgency.                  |
| `info`     | Neutral guidance, milestone, or final "done" message.       |

Always pass `bounds` (from a `perceive` row) for `click` and `type` — without
bounds, Accept has nothing to target and will fail.

For `type`, pass the literal text in `value`. Accept will click the
bounding-box center to focus the field, then type `value`.

**`type` does not clear the field.** It only synthesizes keystrokes; whatever
is already there stays. The focus click lands at the **center** of the
bounding box, so the caret usually ends up **inside** any existing text and
your `value` is **inserted there**, not appended at the end and definitely
not replacing the content. If you need to **replace** an existing value (URL
in an address bar, value in a text input, etc.), run a clearing `shortcut`
**first**, then a `type`:

```
# 1) clear the field in one Accept (selection survives because both chords
#    run inside a single shortcut indicator with a built-in inter-step delay)
indicate({
  type: "shortcut",
  bounds: <field bounds>,
  keys: [["LeftControl", "A"], ["Backspace"]],
  title: "Clear field",
})

# 2) re-perceive, then type the new value into the now-empty field
indicate({
  type: "type",
  bounds: <field bounds, fresh from perceive>,
  value: "new content",
  title: "Enter value",
})
```

Do **not** try to clear in one indicator and type in the next without
re-establishing the target via the second `indicate`'s focus click — and do
**not** assume you can chain `Ctrl+A` in one indicator and `type` in the
next: the next `indicate` re-focuses the overlay and typically loses the
selection. The pattern above works because the second `type` re-clicks the
empty field to refocus it before typing.

For `shortcut`, pass `keys` as a **list of chord steps**. Each chord is an
array of `nut-js` `Key` names; chords run sequentially with a ~50ms delay
between steps inside a single Accept (so you do not lose state between two
`indicate` calls).

- Single chord (Ctrl+L): `keys: [["LeftControl", "L"]]`
- Two-step (clear field): `keys: [["LeftControl", "A"], ["Backspace"]]`
- Three-step (focus → submit → confirm): `keys: [["LeftControl", "L"], ["Enter"], ["Enter"]]`

Use the exact PascalCase names from `nut-js` (`LeftControl`, `RightControl`,
`LeftAlt`, `LeftShift`, `LeftSuper`, `Enter`, `Escape`, `Tab`, `Space`,
`Backspace`, `Delete`, `F1`–`F24`, `A`–`Z`, `Num0`–`Num9`, etc.). Within each
chord, keys are pressed in the given order and released in reverse, so list
modifiers first and the trigger key last.

**Focus rule for `shortcut`:** if you pass `bounds`, Accept clicks the
bounding-box center first (handing OS focus to that control) and then sends
the chord — this is the only reliable way to target a specific window or
field. If you omit `bounds`, the daemon best-effort blurs the overlay so
Windows reverts to whatever was foreground before the indicate, and sends the
chord there; this is fine for global shortcuts (`Win+L`, `Alt+Tab`) but is
**not** a reliable way to target a specific app. **Whenever you care which
window receives the chord, pass `bounds` of a control inside that window.**

## Buttons and Tab

Cards always render bottom-right action buttons:

- `info` / `warning` / `wait` / `action` / `danger` → single **Next** chip
  with a `Tab` keycap. Accept resolves `"done"`; no OS-level effect.
- `click` / `type` / `shortcut` → **Skip** + **Accept**. Accept performs the
  OS-level click (and types `value` for `type`, or sends the `keys` chord for
  `shortcut`) then resolves `"done"`. Skip resolves `"skipped"` without
  touching the target.

Pressing **Tab** while an indicator is up fires the primary action (Accept
where present, otherwise Next). After Next/Accept fires, the card stays
visible with a spinner where the `Tab` keycap was; the next
`indicate(append=false)` clears it. The X button always resolves as
`"skipped"` if not yet resolved.

## What `await` and `append` mean

- `await` defaults to `true`. Each `indicate` blocks the call until the user
  resolves it. Only set `await=false` for fire-and-forget banners that you
  do not need to synchronize with.
- `append` defaults to `false`. The next `indicate` replaces the current
  card. Set `append=true` only when stacking transient context next to an
  in-flight indicator (rare).

## Branching on the result

```
result = indicate({...})
if result == "done"     → continue the loop
if result == "skipped"  → user (or you) declined; stop and summarize
```

Never assume `"done"` means the underlying app reached the desired state —
it just means the click/type was issued. Re-`perceive` to verify.

## Examples

### Click a button by name

```
nodes = perceive()
target = pick(nodes, name="Save", type="B")
indicate({
  type: "click",
  bounds: { x: target.x, y: target.y, width: target.w, height: target.h },
  title: "Save the document",
  text: "Click Save to persist your changes.",
})
# loop continues: perceive again, look for the saved-state confirmation
```

### Fill an empty field

```
nodes = perceive()
field = pick(nodes, name="Email", type="E")
indicate({
  type: "type",
  bounds: { x: field.x, y: field.y, width: field.w, height: field.h },
  title: "Enter email",
  value: "user@example.com",
})
```

### Replace existing text in a field (clear, then type)

`type` does not clear; if the field already has content (URL, prefilled
value, …), the new text is **inserted** at the click position, not swapped
in. Always pair a clearing `shortcut` with the follow-up `type`:

```
nodes = perceive()
addr = pick(nodes, name="Address and search bar", type="E")

# 1) clear the field — both chords run in one Accept
indicate({
  type: "shortcut",
  bounds: { x: addr.x, y: addr.y, width: addr.w, height: addr.h },
  keys: [["LeftControl", "A"], ["Backspace"]],
  title: "Clear URL bar",
})

# 2) re-perceive, then type the new URL into the now-empty field
nodes = perceive()
addr = pick(nodes, name="Address and search bar", type="E")
indicate({
  type: "type",
  bounds: { x: addr.x, y: addr.y, width: addr.w, height: addr.h },
  title: "Enter new URL",
  value: "https://example.com",
})
```

### Pause for a load

```
indicate({
  type: "wait",
  title: "Loading…",
  text: "Wait for the dashboard to render before continuing.",
})
# user or you press Tab/Next once the screen is ready, then re-perceive
```

### Send a keyboard shortcut to a specific control

```
nodes = perceive()
addr = pick(nodes, name="Address and search bar", type="E")
indicate({
  type: "shortcut",
  bounds: { x: addr.x, y: addr.y, width: addr.w, height: addr.h },
  keys: [["LeftControl", "A"]],
  title: "Select all in address bar",
  text: "Accept clicks the URL bar to focus it, then sends Ctrl+A.",
})
```

### Multi-step chord (clear a field in one Accept)

```
indicate({
  type: "shortcut",
  bounds: { x: addr.x, y: addr.y, width: addr.w, height: addr.h },
  keys: [["LeftControl", "A"], ["Backspace"]],
  title: "Clear the URL bar",
  text: "Accept focuses the bar, selects all, then deletes — one Accept, no focus loss between steps.",
})
```

### Send a global shortcut (no specific target)

```
indicate({
  type: "shortcut",
  keys: [["LeftSuper", "L"]],     # Win+L
  title: "Lock the workstation",
  text: "Best-effort: chord goes to whatever was foreground before this card.",
})
```

### Need something only the user can provide

```
indicate({
  type: "action",
  title: "I need you to sign in",
  text: "I don’t see an authenticated session in this window. Please log in, then press Next (or Tab) so I can perceive again and continue.",
})
# after "done": perceive() and keep going — do not treat this as task failure
```

## Anti-patterns

- **One-shot automation.** Calling `indicate` once and declaring victory.
  Always loop and verify with another `perceive`.
- **Stale coordinates.** Reusing bounds across steps. UIs reflow; re-perceive.
- **Wrong type.** `info` for a click step hides the Accept button and breaks
  the keyboard-driven flow. Match type to action.
- **Missing `value` on `type`.** Accept will click the field but type nothing.
- **Using `type` to replace existing content.** `type` does **not** clear the
  field; the focus click lands at the bbox center and the new text is
  inserted **inside** any existing value, not in place of it. To replace,
  run a clearing `shortcut` first (`[["LeftControl","A"],["Backspace"]]` on
  the same bounds), then `type` the new value in a follow-up indicate.
- **Skipping `bounds` on `click`/`type`.** Accept has no target.
- **Skipping `bounds` on `shortcut` when you need a specific window.** The
  overlay grabs focus on every `indicate` (so `Tab` works); without `bounds`
  there's no focus click and the chord goes wherever Windows reverts to,
  which is rarely what you want. Pass `bounds` of a control inside the
  intended window.
- **Missing `keys` on `shortcut`.** Accept will run with an empty chord and
  do nothing.
- **Flat `keys` array on `shortcut`.** `keys` is a **list of chords**: even a
  single chord must be wrapped, e.g. `[["LeftControl", "L"]]`, not
  `["LeftControl", "L"]`. The latter is rejected at validation.
- **Splitting a multi-chord sequence across two `indicate`s** (e.g. one card
  for Ctrl+A, then a second card for Backspace or to type). The next
  `indicate` re-focuses the overlay and you lose the selection / focus state
  from the previous step. Put related chords in **one** `keys` chord-list so
  they run inside a single Accept with the built-in inter-step delay.
- **Spamming `append=true`.** Keep at most one in-flight indicator per step.
- **Giving up in chat instead of on the overlay.** If you need the user, use
  `wait` / `action` / `warning` with clear text first; only fall back to chat
  if the MCP path is unavailable or the user has already declined.

## When to stop

Stop the loop and summarize when any of these is true:

- The user's stated goal is observably reached on screen.
- An `indicate` resolves with `"skipped"`.
- `perceive` no longer shows the expected target after several attempts **and**
  you have already surfaced at least one recovery card (`action` / `wait` /
  `warning`) without progress.
- You hit a destructive `danger` step the user has not pre-approved.

**Not** a default stop: missing credentials, unclear UI, or “I would need to
ask the user something” — handle those with an indicator and keep looping
until the screen state changes or the user skips.

End the session with a final `indicate({ type: "info", title: "Done", text: "<short summary>" })` so the user gets a clear terminal card.
