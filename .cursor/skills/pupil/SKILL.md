---
name: pupil
description: Operates desktop applications through the Pupil MCP server by iterating perceive then indicate then accept, repeatedly, until the user's task is complete. Prefer clicking visible controls from `perceive` over keyboard shortcuts when both achieve the same outcome. Use whenever Pupil's `perceive` and `indicate` tools are available, or when the user asks to automate a Windows GUI, click or send keyboard input into another application, run a multi-step desktop workflow, or guide a human through one step at a time.
---

# Using Pupil

**Default:** prioritize **`click`** on a listed control over **`input`** with keyboard shortcuts when the CSV exposes a target that does the same thing (Save vs Ctrl+S, OK vs Enter, and so on). The sections below spell out when to use each.

Pupil exposes two MCP tools — `perceive` (read the current UI, **no arguments**)
and `indicate` (flat payload: `type`, optional `coords`, optional `desc`,
optional `value`). Real GUI work is **never one tool call**. Drive the loop
below until the user's task is fully done; do not stop after a single
`indicate`.

## The core loop

For every task, repeat until the goal is reached or the user cancels:

```
1. perceive()                        → initial screen CSV (once per session / when you lack a fresh snapshot)
2. pick the next target node
3. r = indicate({ type, coords?, desc?, value? })   → blocks until the user resolves
4. r.result is "done" | "skipped"
   r.perceive is the fresh post-resolution compact CSV (like `perceive()`, but each `name` is truncated after 100 chars with `...`; standalone `perceive` is full length)
5. Branch on r.result — **always** use `r.perceive` before picking the next target (step 2):
   - "done" → the card resolved as intended (Next, or Accept on click/input); verify state on `r.perceive`, then continue the task.
   - "skipped" → **not** “stop the task.” Skip (Escape) or dismiss without Accept means **this card’s proposed OS action did not run** (no click, no chords). Infer why from `r.perceive` and context (already satisfied, manual completion, different path, wrong target, etc.), then `indicate` the next sensible step. Reserve ending the whole workflow for explicit full cancellation or repeated skips with no forward progress after you realign.
```

Each `indicate` **replaces** any prior card and **blocks** until the user (or
you, via Accept) resolves it, then returns **`{ result, perceive }`** (JSON
text): use **`r.perceive`** as the next UI read — you usually do **not** call
`perceive()` again right after a successful `indicate`. Never reuse coordinates
from an old CSV after the screen changed; the bundled **`r.perceive`** is the
right snapshot after that `indicate`.

## Chat output during Pupil loops

Do **not** write step-by-step play-by-play in the assistant message between
`perceive` / `indicate` calls (e.g. “Opening Settings…”, “Clicking Save…”).
The overlay already shows the next action; extra narration wastes tokens and
clutters the thread.

- Put user-facing intent on **`indicate`** (optional `desc` only when the
  highlight does not already convey it), not in chat.
- **Chat text** is for: at most one optional short line before the first tool
  call if needed, real endings (goal met, hard blocker, explicit whole-task
  cancel), and a brief wrap-up after the final `info` card if the user still
  needs a summary. A single `indicate` → `"skipped"` is **not** automatically a
  chat-level ending — reconcile on `r.perceive` and continue unless the user
  clearly aborted the overall task.

## Why two tools and when to call which

- **`perceive()`** — Use for the **first** read in a session, or when you have
  **no** fresh `perceive` string from a prior `indicate` (e.g. long wait, user
  changed the app outside the Pupil loop, or you only need a read without
  showing a card).
- **`indicate()`** — Every resolution returns **`r.perceive`**; that string is
  your default “next frame” for picking the following target. For token savings,
  **`r.perceive`** truncates the CSV `name` column after 100 characters with
  `...`; call **`perceive()`** when you need full control names (same layout
  otherwise).

## Wire shape (compact)

Only these keys exist; unknown keys are rejected:

| Field | When |
|-------|------|
| `type` | Always — one of `info`, `warning`, `wait`, `action`, `click`, `input`, `danger`. |
| `coords` | Optional string `"x,y,w,h"` (integers, `w` and `h` positive). **Required** for `click` only; optional for `input` (recommended when a specific control must own focus). |
| `desc` | Optional. Only when it adds information the highlight does **not** already show — **never** repeat the control’s visible label (e.g. do not set `desc: "Save"` when clicking Save). |
| `value` | **Required** for `input` only: `{ clip?: string, chords: string[][] }`. `chords` — non-empty chord steps (nut-js `Key` names; modifiers first; ~50ms between steps in one Accept). `clip` — optional; when set, daemon saves plain-text clipboard, writes `clip`, runs `chords`, restores prior text in `finally`. |

Minify JSON in tool calls when possible (one line, no extra spaces) to save
output tokens.

## Persistence: blocks are cards, not dead ends

Do **not** give up early. If something is missing, impossible from automation
alone, or you would otherwise ask the user for information you cannot infer,
**stay in the Pupil loop** instead of stopping in chat or writing long
free-form questions with no next step.

Use a non-destructive card type and optional `desc` only when it adds real
context — a natural “I’m stuck until you…” or “I need you to …” tone is fine:

- **`wait`** — The UI is loading, syncing, or you need the user to finish
  something passive before you have a fresh UI read (often **`r.perceive`**
  from the next `indicate`, or `perceive()` if you need a silent snapshot).
- **`action`** — A concrete human step that has no good `click`/`input` target
  yet.
- **`warning`** — Something risky, ambiguous, or credential-related where you
  want the user to notice urgency before continuing.

After **Next** / **Tab** (or **Accept** on `click`/`input`), use
**`r.perceive`** from that `indicate` and continue (no extra `perceive()` unless
you need one for the reasons above).

Reserve **stopping** for real endings: goal met, explicit user decline of the
**whole** task (in chat or unmistakable context), or repeated `perceive`
failure after you have already tried different paths and surfaced at least one
actionable card. **`"skipped"` on one card is not, by itself, “user declined the
task”** — it only means that step was not executed via Pupil for that card.

### Workflow checklist

```
Task progress:
- [ ] perceive once (or use r.perceive from the prior indicate)
- [ ] identify next target node
- [ ] keep chat quiet between tool calls — no play-by-play (see “Chat output during Pupil loops”)
- [ ] indicate the next step (with the right type)
- [ ] if blocked: indicate wait/action/warning with useful desc — do not stop in chat only
- [ ] await resolution; if `"skipped"`, read `r.perceive`, infer why that step was bypassed, continue toward the goal (do not default to “task over”)
- [ ] use r.perceive before choosing the next target (skip standalone perceive if you already have it)
- [ ] repeat until the user's goal is met
- [ ] final indicate({ "type": "info", "desc": "Done — short summary." })
```

## Picking the right indicator type

| Type       | Use it for |
|------------|------------|
| `click`    | Single OS click on the **center** of the `coords` box. |
| `input`    | Keyboard automation: `value` is `{ clip?: string, chords: string[][] }`. **`Ctrl+V` is the standard way to insert text** — set `clip` to the string and include `[["LeftControl","V"]]` in `chords`. To **overwrite** existing field text, select all first: e.g. `[["LeftControl","A"],["LeftControl","V"]]` with the replacement string in `clip`. Chords-only (no `clip`) is fine when there is **no** equivalent `click` (e.g. some global shortcuts). **Do not** use `input` + shortcuts for outcomes you can get with **`click`** on a listed control. |
| `wait`     | Loading / passive wait. |
| `action`   | Human step you cannot automate yet. |
| `warning`  | Sensitive / ambiguous — flag and continue after Next. |
| `danger`   | Severe / safety-critical. |
| `info`     | Neutral guidance or milestone. |

**Prefer `click` over `input` when a control is visible.** If `perceive` /
`r.perceive` shows a button, link, menu item, tab, tree row, or other hit target
that achieves the same outcome as a keyboard shortcut (Save vs Ctrl+S, Open
vs Ctrl+O, OK vs Enter, menu paths vs Alt+letters, etc.), use **`click`** — do
**not** use `input` with chords to mimic that action. Use **`input`** for real
typing/paste, for flows that have **no** reliable clickable row in the CSV, or
for shortcuts that truly have no on-screen equivalent. Keyboard paths are
easier to mis-target than a highlighted bbox.

**Batch all shortcut steps in one `input`.** Every chord step that belongs to
one logical automation (e.g. select-all then paste, or several keys the app should
see as one continuous burst) goes in **one** `value.chords` array inside **one**
`indicate` — do not split a shortcut chain across multiple `indicate` calls when
a single list of chord arrays can express it (each inner array is one chord;
order is the sequence). When the UI must settle between steps, use **`r.perceive`**
and a **new** `indicate` — that is separate automations, not one split chain.

**`input` does not clear the field by itself.** Without selecting first, paste
appends or replaces only what the app’s selection rules allow. For a full
**replace**, use `chords` that select all (typically `[["LeftControl","A"]]`)
before `[["LeftControl","V"]]` with the new payload in `clip`, in **one**
`indicate` — do not split chord sequences across two `indicate`s (the next call
re-focuses the overlay and you can lose selection).

**Focus rule for `input`:** with `coords`, Accept clicks the **center of the
bbox** first, then runs clipboard (if `clip`) + `chords`. Without `coords`,
best-effort blur then chords go to the previous foreground window — OK for
global shortcuts, **not** reliable for app-specific targets. Pass `coords` on a
control in the target window when it matters.

## Buttons and keyboard

- `info` / `warning` / `wait` / `action` / `danger` → **Next** (Tab). `"done"`;
  no OS action.
- `click` / `input` → **Skip** (Escape) + **Accept** (Tab). **Accept** runs the
  OS action then `"done"`. **Skip** (and closing **X** without Accept) resolves
  with `"skipped"`: no automation from that card — **not** “stop helping,”
  unless the user clearly cancels the overall task elsewhere.

After Next/Accept, the card stays with a spinner until the **next** `indicate`
clears it. **X** without completing the card → `"skipped"` (same “this card only”
semantics as Skip where applicable).

## Branching on the result

Parse the JSON text from `indicate` into **`r`**:

```
r = indicate({...})   // tool returns JSON: { "result": "...", "perceive": "<csv>" }
if r.result == "done"     → continue; next UI read is r.perceive
if r.result == "skipped"  → no OS action from this card; next UI read is still r.perceive.
                            Infer why (already done, manual completion, wrong control, etc.),
                            then indicate the next step. Stop the whole task only on clear
                            full cancellation, not on a lone skip.
```

Never assume `"done"` means the app reached the desired state — verify on
**`r.perceive`** (or call `perceive()` if you still lack a fresh snapshot).

### Example: next target from `r.perceive`

After `r = indicate({ "type": "click", "coords": "…" })`, parse **`r.perceive`**
the same way you parse standalone `perceive` output: find the row for the next
control and read its **`x,y,w,h`** for the following `indicate`.

## Examples (minified)

```json
{}
{"type":"info","desc":"Step complete."}
{"type":"click","coords":"120,440,72,28"}
{"type":"input","coords":"200,300,320,28","value":{"clip":"user@example.com","chords":[["LeftControl","V"]]}}
{"type":"input","coords":"10,50,600,32","value":{"clip":"https://example.com/","chords":[["LeftControl","A"],["LeftControl","V"]]}}
{"type":"input","value":{"chords":[["LeftSuper","L"]]}}
```

Click with extra context (rare — only if not redundant with the highlight):

```json
{"type":"click","coords":"40,80,160,32","desc":"Confirm destructive dialog after reading the message body."}
```

## Anti-patterns

- **One-shot automation.** One `indicate` then done; always loop using
  **`r.perceive`** (and `perceive()` when you need an initial or out-of-band read).
- **Calling `perceive()` after every `indicate()`.** A successful `indicate`
  already returns the next snapshot in **`r.perceive`**; the extra call wastes a
  turn unless you have no bundled snapshot or need a silent read without a card.
- **Stale `coords`.** Use **`r.perceive`** after each resolved `indicate`; only
  call standalone `perceive()` when that string is missing or stale.
- **Wrong `type`.** `info` on a click step hides Accept.
- **Missing or invalid `value` for `input`.** Validation error (`chords`
  required; `clip` non-empty when present).
- **Replacing field text without selecting first.** Use e.g.
  `[["LeftControl","A"],["LeftControl","V"]]` with `clip` in one `indicate`.
- **Skipping `coords` on `click`.** No target.
- **Skipping `coords` on `input` when targeting a specific window.** Use a
  control’s box inside that window.
- **Splitting chord sequences across two `indicate`s.** Use one `value.chords`
  list.
- **Typing per character instead of `clip` + `Ctrl+V`.** Prefer clipboard
  paste for inserting text; keep all related chords in one Accept.
- **Repeating the control label in `desc`.** Omit `desc` instead.
- **Giving up in chat** before a `wait` / `action` / `warning` card with a useful `desc`.
- **Play-by-play in chat** between `perceive` / `indicate` (“Opening…”, “Clicking…”). The overlay is the step UX; use **`indicate`** `desc` when extra context is needed — see **Chat output during Pupil loops**.
- **Treating `"skipped"` as “user gave up on the entire task.”** It skips one card’s automation; reconcile on **`r.perceive`** and continue unless cancellation is explicit.
- **`input` / keyboard shortcuts when `click` would work** — e.g. prefer
  clicking **Save** over Ctrl+S, **Open** over Ctrl+O, or a visible **OK** over
  Enter, whenever that control appears in the CSV.
- **Several `indicate({ type: "input", ... })` calls for one shortcut chain**
  when you can merge steps into one `value.chords` in a single `indicate`.

## When to stop

- Goal visibly met on screen.
- User clearly cancels the **entire** task (chat or unambiguous context), or
  skips/dismissals leave you stuck **after** you used `r.perceive` to realign and
  offered a sensible next card — not merely the first `"skipped"`.
- `perceive` no longer finds the target **after** you already showed a recovery
  card (`action` / `wait` / `warning`) without progress.
- Unapproved `danger` step.

**Not** a default stop: missing credentials or unclear UI — use a card with
`desc`, then loop.

End with:
`indicate({ "type": "info", "desc": "Done — <short summary>." })`
