---
title: Antigravity CLI (agy) — TUI survey
date_created: 2026-06-04
date_modified: 2026-06-04
revision: 1
history:
  - 2026-06-04: Initial survey captured via termctrl (agy v1.0.4)
status: done
---

# Antigravity CLI (`agy`) — TUI survey

A reference snapshot of Google's **Antigravity CLI** terminal UI, captured for
comparative study against Quark's own TUI. Driven non-interactively via
[`termctrl`](./../docs/using-termctrl.md); not part of Quark's runtime.

- **Binary**: `/Users/mac/.local/bin/agy` (Mach-O arm64)
- **Version observed**: `Antigravity CLI 1.0.4`
- **Account / plan**: Google AI Pro (`phamhuy307@gmail.com`)
- **Active model on capture**: Claude Sonnet 4.6 (Thinking)
- **Capture viewport**: 140 × 44 PTY via `termctrl --host opentui`
- **Conversation ID seen**: `fef31de1-eac6-4142-9b0b-25a639311243`
- **Reference screenshot**: `/tmp/agy-context.png` (transient)

> Identity note: branded "Antigravity CLI" (Google), but the runtime
> auto-loads `~/.gemini/GEMINI.md` and `~/.gemini/skills/`, indicating it
> reuses the Gemini Code CLI shell and routes to Claude as the model
> backend.

---

## 1. Screen layout

```diagram
╭──────────────────────────────────────────────────────────────╮
│   ▄▀▀▄        Antigravity CLI 1.0.4                          │  banner
│  ▀▀▀▀▀▀       phamhuy307@gmail.com (Google AI Pro)           │   • account / plan
│ ▀▀▀▀▀▀▀▀      Claude Sonnet 4.6 (Thinking)                   │   • active model
│▄▀▀    ▀▀▄     ~/…/Quark                                      │   • cwd
├──────────────────────────────────────────────────────────────┤
│ > user message                                               │  transcript
│ ▸ Thought for 2s         (collapsible reasoning block)       │   (alt-screen)
│   pong                                                       │
├──────────────────────────────────────────────────────────────┤
│ >                            ← prompt input                  │
├──────────────────────────────────────────────────────────────┤
│ ? for shortcuts                  Claude Sonnet 4.6 (Thinking)│  footer
╰──────────────────────────────────────────────────────────────╯
```

Four stacked regions, separated by full-width horizontal rules:

1. **Banner** — ASCII logo on the left, identity block on the right
   (version, account, model, cwd). Rendered once at session start.
2. **Transcript** — scrollback of turns. Uses the **alternate screen**;
   `termctrl logs` returns nothing useful, you must `termctrl show`.
3. **Prompt input** — single-line `>` field with multi-line entry via
   `alt+enter`, `ctrl+j`, `shift+enter`, or `\` + `enter`.
4. **Footer** — hint on the left (`? for shortcuts` idle vs. `esc to
   cancel` busy/overlay), model pinned right.

---

## 2. Overlays

### Help (`?`)

Three tabs, cycled with `tab` or `←/→`, closed with `esc`:

| Tab | Contents |
|---|---|
| `general` | About blurb, version, account, workspace path, project path, quick-reference pointer to `/`. |
| `commands` | Full slash-command catalog — **79 items**, paginated (`[1-29 of 79 items]`). |
| `shortcuts` | Complete keymap (see §4). |

### Slash menu

Typing `/` on an empty prompt opens a live-filtered command palette:

```
> /
> /add-dir                                       Add a directory to the workspace
  /agents                                        List available custom agents
  /artifact                                      View and review artifacts
  /btw                                           Ask a side question without interrupting the current task
  /changelog                                     Show release notes and changes
   ↓ 74 more

  ↑/↓ Navigate · enter Select · tab Complete
```

### Generating state

```
> Reply with exactly the word: pong

▸ Thought for 2s
  pong
  pong
```

While streaming, a spinner + contextual tip line appears under the active
turn (`⣾ Generating...` / `└ Tip: Use /diff to view uncommitted changes
in your workspace.`), and the footer flips to `esc to cancel`.

Reasoning is rendered as a **collapsible block** prefixed with `▸ Thought
for Ns` or `▸ Thought Process`.

---

## 3. The `/context` panel — token-budget visualisation

The most visually distinctive overlay. Two columns:

- **Left**: a 28-column dot matrix that fills left-to-right and
  top-to-bottom representing the fraction of the model's context window
  consumed (filled glyph `◉`, empty `□`).
- **Right**: a categorised legend with absolute token counts and
  percentages.

```
└ Context Usage
◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉     Claude Sonnet 4.6 (Thinking) · 37.1k/250.0k tokens
◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ □ □ □ □ □      (14.8%)
□ … □                                                       Token usage by category
                                                            ◉ User messages: 4 tokens (0.0%)
                                                            ◉ Agent responses: 220 tokens (0.1%)
                                                            ◉ Tool calls: 0 tokens (0.0%)
                                                            ⛁ System prompt: 14.9k tokens (6.0%)
                                                            ⛁ System tools: 15.0k tokens (6.0%)
                                                            ⛁ Skills: 6.3k tokens (2.5%)
                                                            ⛁ Subagents: 654 tokens (0.3%)
                                                            □ Free space: 212.9k (85.2%)
                                                            ⊠ Checkpoint buffer: 35 tokens (not counted in usage)


Checkpoints (1) · /rewind
└ Checkpoint 1 (active, in context): Confirming System Response Protocol
  …

System files · auto-loaded
 └ ~/.gemini/GEMINI.md
 └ ~/.gemini/skills/

Related: /artifact · /skill · /rewind
```

Categories tracked: **User messages**, **Agent responses**, **Tool calls**,
**System prompt**, **System tools**, **Skills**, **Subagents**, **Free
space**, and a separate **Checkpoint buffer** (explicitly *not* counted in
usage). Glyph families distinguish conversational (`◉`), framework-supplied
(`⛁`), free (`□`), and buffer (`⊠`).

The panel also lists **Checkpoints** (with `/rewind` affordance) and
**auto-loaded system files** — a useful pattern for surfacing the implicit
context Quark currently hides from users.

---

## 4. Keymap (verbatim from the `shortcuts` tab)

| Key | Action |
|---|---|
| `/` | Open slash commands |
| `\ + enter` | Insert newline (fallback) |
| `alt+enter`, `ctrl+j`, `shift+enter` | Insert newline |
| `alt+j` | Manage subagent |
| `ctrl+_`, `ctrl+shift+-` | Undo |
| `ctrl+c`, `esc` | Go back / dismiss |
| `ctrl+d` | Exit |
| `ctrl+end` / `ctrl+home` | Bottom / top |
| `ctrl+g` | Open prompt in `$EDITOR` |
| `ctrl+k` | Approve subagent fast |
| `ctrl+l` | Clear CLI screen |
| `ctrl+o` | Toggle trajectory view |
| `ctrl+r` | Review artifact |
| `ctrl+shift+z` | Redo |
| `ctrl+v` | Paste image / video |
| `ctrl+y` | Yank (paste from kill ring) |
| `ctrl+z` | Suspend CLI |
| `pgup` / `pgdown` (`shift+up` / `shift+down`) | Page nav |
| `e` (on a sent message) | Edit command |
| `enter` | Send / confirm |
| `tab`, `←` / `→` | Cycle tabs / move |
| `shift`/`alt`+click | Select & copy |

`/keybindings` exposes user customisation.

---

## 5. Slash-command catalog (first 29 of 79)

Captured from the `commands` help tab and the `/` palette:

`/add-dir`, `/agents`, `/artifact`, `/btw`, `/changelog`, `/clear` (new),
`/config` (settings), `/context`, `/copy`, `/credits`, `/diff`,
`/exit` (quit), `/fast`, `/feedback`, `/fork` (branch), `/help`,
`/hooks`, `/keybindings`, `/logout`, `/mcp`, `/model`, `/open`,
`/permissions`, `/planning`, `/rename`, `/resume` (switch, conversation),
`/rewind` (undo), `/skills`, `/statusline`, … (50 more not enumerated).

Categories implied: **workspace management** (`/add-dir`, `/open`),
**conversation control** (`/clear`, `/fork`, `/rewind`, `/resume`,
`/rename`), **execution mode** (`/fast`, `/planning`, `/btw`), **agent
configuration** (`/agents`, `/skills`, `/mcp`, `/hooks`, `/permissions`,
`/model`, `/keybindings`, `/statusline`, `/config`), **inspection**
(`/context`, `/diff`, `/artifact`, `/credits`, `/changelog`),
**output** (`/copy`, `/feedback`), and lifecycle (`/exit`, `/logout`).

---

## 6. Reproducing the capture

```bash
termctrl start agy --host opentui --cols 140 --rows 44 -- agy
termctrl wait  agy "for shortcuts" --timeout 15000

# Help tabs
termctrl send  agy text:?
termctrl send  agy tab            # general → commands → shortcuts

# Round-trip a message
termctrl send  agy escape
termctrl send  agy --pace-ms 20 "text:Reply with exactly the word: pong" enter
termctrl wait  agy "pong"  --timeout 30000

# Context panel (reset prompt first, or you'll send `//context` as text)
termctrl send  agy escape
termctrl send  agy ctrl-l
termctrl send  agy "text:/context" enter
termctrl wait  agy "Context Usage" --timeout 10000

termctrl save  agy --format png --out /tmp/agy-context.png
termctrl stop  agy
```

### Gotchas encountered

- **Always pass `--host opentui`** — without it OpenTUI's startup probe
  stalls; same caveat as Quark's own TUI.
- **Alt-screen TUI** — `termctrl logs` returns nothing; always use
  `termctrl show`.
- **Slash menu requires a clean prompt** — if there's any text buffered,
  typing `/` prepends rather than opening the palette, and `enter` sends
  the literal string (we accidentally fired `//context` as a chat
  message). Reset with `escape` then `ctrl-l` before a slash command.
- **No raw input pacing needed for most input** — but `--pace-ms 20`
  prevents the editor from dropping characters on long literal strings.

---

## 7. Takeaways for Quark

Things `agy` does that are worth considering for Quark's TUI
(`src/tui/**`):

1. **Categorised `/context` token panel** — visualises *what* is eating
   the budget (system prompt vs. tools vs. skills vs. subagents vs.
   user/agent vs. free), not just a single percentage. Currently Quark
   shows the flip-clock percentage only
   ([tui-token-percent-flip-clock.md](./tui-token-percent-flip-clock.md)).
2. **Auto-loaded system files** surfaced inside `/context` — makes
   implicit context (e.g. `AGENTS.md`, project skills) discoverable to
   the user.
3. **Checkpoint buffer accounted separately** — explicitly excluded from
   "used" tokens, with a `/rewind` affordance attached.
4. **Three-tab help overlay** (`general` / `commands` / `shortcuts`) —
   keeps the slash catalog and keymap reachable from a single anchor.
5. **Slash palette with inline descriptions** opened by `/` with
   `tab`-to-complete — a small but high-leverage discoverability win
   over remembering names.
6. **Multiple newline keybindings** (`alt+enter`, `ctrl+j`,
   `shift+enter`, `\+enter`) — covers terminals that swallow one or
   more of these.
7. **`ctrl+g` → open prompt in `$EDITOR`** — escape hatch for long
   prompts that Quark currently lacks.
8. **Reasoning blocks rendered as `▸ Thought for Ns` collapsible
   regions** — keeps thinking visible without flooding the transcript.

None of these are blocking; they are concrete UI patterns to crib from
when prioritising future TUI work.
