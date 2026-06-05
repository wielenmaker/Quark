---
title: OpenAI Codex CLI — TUI survey
date_created: 2026-06-04
date_modified: 2026-06-04
revision: 1
history:
  - 2026-06-04: Initial survey captured via termctrl (codex-cli 0.136.0)
status: done
---

# OpenAI Codex CLI (`codex`) — TUI survey

A reference snapshot of OpenAI's **Codex CLI** terminal UI, captured for
comparative study against Quark's own TUI. Driven non-interactively via
[`termctrl`](./../docs/using-termctrl.md); not part of Quark's runtime.

- **Binary**: `/opt/homebrew/bin/codex`
- **Version observed**: `codex-cli 0.136.0`
- **Active model on capture**: `gpt-5.5 xhigh` (high-reasoning frontier model)
- **Permissions mode**: YOLO (auto-approve all tools)
- **Viewport**: 140 × 45

## Capture methodology

A throwaway working directory (`/tmp/codex-tui-test`) was created with a
single `sample.txt` seed file. Codex was launched in a named termctrl
session, then driven through:

1. A trivial read-one-file task (warmup, fast completion)
2. A long multi-step shell + write task (`date`, `uname -a`, `pwd`,
   `ls -la`, create `notes.md`, read it back, summarise) — long enough to
   capture intermediate states
3. The `/` slash menu
4. The `/model` picker

75 text frames + matching PNGs were sampled at ~400 ms intervals and
deduplicated by hash. Raw frames lived in `/tmp/codex-frames/` during
analysis and are not committed.

## Design language

Codex's TUI commits to an extremely austere visual vocabulary:

- **Strictly monochrome.** No color accents anywhere; bright white = primary
  text, dim gray = metadata / tool output, near-black background.
- **Single event-feed stream**, not a chat layout. User turns, model
  preambles, tool calls, and final answers are all stacked as bullet-prefixed
  blocks separated by a full-width horizontal rule.
- **No boxes around messages.** Rounded-corner boxes are reserved for
  startup splash, the update banner, and (per upstream docs) confirmation
  dialogs. Steady-state operation is box-free.
- **Tree connectors** (`└ `) attach a tool's output to its action — no
  bordered "cards".
- **One bullet vocabulary**, used everywhere:
  - `›` — input prompt cursor / selected list item
  - `•` — completed event (assistant text, tool result, step header)
  - `◦` — in-progress (animates `◦` ↔ `•` to spin)
  - `└ ` — child / result of the parent event
- **Full-width `─` rule** between top-level events.

## Layout model: bottom-pinned composer, upward-growing feed

The composer is a sticky footer; the conversation log grows upward against
it. New events appear **directly above the composer** (and above the spinner
when one is active). Older content scrolls off the top of the viewport.

```diagram
╭──────────── viewport (steady state) ────────────╮
│ … older history scrolls off top                │
│                                                │
│ ─────────────────────────────                  │
│ • Step 1: I'm running date …                  │  ← new events
│                                                │    appear here,
│ • Ran date                                     │    pushing older
│   └ Thu Jun  4 11:14:20 CEST                   │    content up
│ ─────────────────────────────                  │
│                                                │
│ ◦ Working (12s • esc to interrupt)             │  ← spinner pinned
│                                                │    above composer
│ › Implement {feature}                          │  ← composer never
│   gpt-5.5 xhigh · /tmp/test                    │    moves
╰────────────────────────────────────────────────╯
```

Concretely, on every captured frame:

1. The composer `›` line is glued to the bottom of the viewport.
2. The footer (`<model> · <cwd>`) sits directly below it, also fixed.
3. On submit, the user's `› <prompt>` becomes part of the scroll history
   above the composer; the composer immediately reverts to its dim
   `› Implement {feature}` placeholder in the same position.
4. The spinner `◦ Working (Ns • esc to interrupt)` occupies a transient
   slot **immediately above the composer** while a turn is running.
5. As the model emits preamble + tool calls + results, each new event is
   inserted **above the spinner**, shifting all prior events upward.
6. When the turn finishes, the spinner disappears and the final `• <answer>`
   block + its closing `─────` separator settle into the bottom of the feed,
   directly above the still-unmoved composer.

Codex deliberately **does not** use:

- split panes
- modal overlays for normal output
- a dedicated reasoning/thinking pane
- pushing the composer downward as new content arrives
- a fixed header

## State inventory

### 1. Idle composer

```diagram
… last assistant block …
─────────────────────────────────────────────────────────────────

› Implement {feature}                          ← placeholder, dim

  gpt-5.5 xhigh · /private/tmp/codex-tui-test  ← footer: model · cwd
```

### 2. Preamble text (the visible substitute for thinking tokens)

```diagram
• Step 1: I'm running date first to capture the current date and time.
```

`gpt-5.5 xhigh` **does not render a separate "Thinking" / "Reasoning"
panel**. The reasoning summary is streamed as plain assistant bullets
(`• Step N: …`) interleaved with tool calls. There is no token counter,
no reasoning-token meter, and no token-budget indicator anywhere in the
steady-state UI.

### 3. In-progress spinner

```diagram
◦ Working (34s • esc to interrupt)
```

- The leading glyph alternates `◦` / `•` each frame — that *is* the spinner
  animation.
- Single elapsed-seconds counter; no token count, no model name repeated.
- Always pinned in the slot directly above the composer + footer.

### 4. Tool call — shell command (`Ran`)

```diagram
• Ran uname -a
  └ Darwin MacBook-Pro-3.local 25.5.0 Darwin Kernel Version 25.5.0: …
    arm64                                  ← wrapped output, indented to align with └
─────────────────────────────────────────────────────────────────
```

### 5. Tool call — read / list (`Explored`)

```diagram
• Explored
  └ Read sample.txt
  └ List ls -la
```

Multiple read / list operations collapse under a single `Explored` header;
only the file or command name is shown — never the output.

### 6. Tool call — write (`Added` / edit)

```diagram
• Added notes.md (+7 -0)
    1 +# Command Summary
    2 +
    3 +- Date: `Thu Jun  4 11:14:20 CEST 2026`
    4 +- System: Darwin/macOS ARM64, kernel `25.5.0`
    …
```

Diff-style preview with line numbers and `+` / `-` markers. No `└` tree
connector — the diff body itself is the "result".

### 7. Final answer block

```diagram
• Completed each requested step in order.

  1. Ran date
  Thu Jun  4 11:14:20 CEST 2026
  …
  In short: I captured the current time, system / kernel info, current
  directory, and directory listing; then I wrote those observations into
  notes.md and verified the file contents by reading it back.
─────────────────────────────────────────────────────────────────
```

Plain prose with bullet / numbered lists. Code spans render as literal
backticks; no syntax highlighting was observed in the capture.

### 8. Slash menu (inline popup above composer)

```diagram
› /                                         ← what the user has typed

  /model         choose what model and reasoning effort to use   ← highlighted row inverted
  /fast          1.5x speed, increased usage
  /ide           include current selection, open files, …
  /permissions   choose what Codex is allowed to do
  /keymap        remap TUI shortcuts
  /vim           toggle Vim mode for the composer
  /experimental  toggle experimental features
  /approve       approve one retry of a recent auto-review denial
```

Inverted-video bar marks the current selection; arrow keys move it; Enter
confirms. The popup expands upward from the composer — it is **not** a
separate window or modal overlay.

### 9. Model picker (after `/model`)

```diagram
  Select Model and Effort
  Access legacy models by running codex -m <model_name> or in your config.toml

› 1. gpt-5.5 (current)  Frontier model for complex coding, research, and real-world work.
  2. gpt-5.4            Strong model for everyday coding.
  3. gpt-5.4-mini       Small, fast, and cost-efficient model for simpler coding tasks.

  Press enter to confirm or esc to go back
```

Same `›`-marks-selection convention as the composer. Replaces the
composer hint inline; does not open a new screen.

### 10. Startup chrome (only on first frame)

```diagram
╭─────────────────────────────────────────────────╮
│ ✨ Update available! 0.136.0 -> 0.137.0         │   ← optional update banner
│ Run brew upgrade --cask codex to update.        │
╰─────────────────────────────────────────────────╯

╭───────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.136.0)                    │
│                                               │
│ model:       gpt-5.5 xhigh   /model to change │
│ directory:   /private/tmp/codex-tui-test      │
│ permissions: YOLO mode                        │
╰───────────────────────────────────────────────╯

  Tip: Try the Codex App. …

⚠ MCP startup incomplete (failed: github)        ← MCP-failure warnings inline
```

Rounded-corner boxes appear here and nowhere else during normal flow.
These banners then scroll up with everything else as new events arrive —
there is no persistent header.

## Full annotated frame (mid-run)

```diagram
╭─────────────────────── viewport (140 × 45) ────────────────────────╮
│                                                                    │
│ › Please do these steps slowly … 1) run 'date' 2) run 'uname -a' …│  ← user turn (›)
│   Take your time, think carefully between each step.              │
│                                                                    │
│ • Step 1: I'm running date first to capture the current time.     │  ← preamble (reasoning-as-text)
│                                                                    │
│ • Ran date                                                        │  ← tool call (completed)
│   └ Thu Jun  4 11:14:20 CEST 2026                                 │
│ ─────────────────────────────────────────────────────────────────  │  ← event separator
│                                                                    │
│ • Step 2: The date command succeeded. Now running uname -a …     │
│                                                                    │
│ • Ran uname -a                                                    │
│   └ Darwin MacBook-Pro-3.local 25.5.0 Darwin Kernel Version …    │
│     arm64                                                         │  ← wrapped output (aligned)
│ ─────────────────────────────────────────────────────────────────  │
│                                                                    │
│ • Explored                                                        │  ← grouped read / list
│   └ List ls -la                                                   │
│                                                                    │
│ • Added notes.md (+7 -0)                                          │  ← write with diff
│     1 +# Command Summary                                          │
│     2 +                                                           │
│     3 +- Date: `Thu Jun  4 11:14:20 CEST 2026`                    │
│     …                                                             │
│                                                                    │
│ ◦ Working (34s • esc to interrupt)                                │  ← spinner (◦↔• animates)
│                                                                    │
│ › Implement {feature}                                             │  ← composer (placeholder, dim)
│                                                                    │
│   gpt-5.5 xhigh · /private/tmp/codex-tui-test                     │  ← footer: model · cwd
╰────────────────────────────────────────────────────────────────────╯
```

## Comparison points for Quark

1. **No dedicated thinking-token UI.** Codex deliberately hides reasoning
   and surfaces it as ordinary prose preambles between tool calls. If
   Quark wants to "show thinking" explicitly, it must make a different
   design choice than Codex.
2. **No token counter in steady state.** Codex shows only an elapsed-
   seconds spinner. There is no per-turn token-budget meter (contrast
   with Amp's `… of 1M` footer).
3. **Tool cards = bullet + tree connector**, not panels. Cheap to render,
   scrolls cleanly, no width gymnastics. Three verbs total: `Ran`,
   `Explored`, `Added` / `Edited`. Outputs are either inlined (`Ran`),
   collapsed behind a filename (`Explored`), or shown as a diff (`Added`).
4. **One animated glyph for "in progress"** — flip `◦` ↔ `•` on the prefix
   of the spinner line. Cheap and consistent with the same alphabet used
   for every other state.
5. **Full-width `─` rule between events** is the only structural
   separator — no boxes around messages.
6. **Sticky bottom composer with upward-growing feed** is the same
   pattern Amp, opencode, and Antigravity use. Codex's specific
   refinement is the transient spinner slot that sits immediately above
   the composer while a turn runs.

## References

- [`docs/using-termctrl.md`](../docs/using-termctrl.md) — capture tooling
- [`specs/antigravity-cli-tui-survey.md`](./antigravity-cli-tui-survey.md) — sibling survey for `agy`
