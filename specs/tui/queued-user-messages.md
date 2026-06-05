---
title: Queued User Messages (Type-Ahead During Agent Run)
date_created: 2026-05-21
date_modified: 2026-05-21
revision: 3
history:
  - 2026-05-21: Initial draft — terminal-native adaptation of the Cursor-style "queued follow-up" pattern.
  - 2026-05-21: Locked visual to opencode-style single-box layout (chip = inner row with divider, not floating bubble).
  - 2026-05-21: Renamed "steer" action to "send now" (^N) to avoid collision with existing /steer slash command.
status: draft
---

# Queued User Messages

## Problem

Today, while the agent loop is running, the TUI textarea is disabled and any
typed input is silently dropped (see [src/tui/components/App.tsx#L680-L690](file:///Users/mac/01-CodeSpace/Personal-Lab/02-Experiment/Quark/src/tui/components/App.tsx#L680-L690)
and [src/tui/components/prompt.tsx#L132-L140](file:///Users/mac/01-CodeSpace/Personal-Lab/02-Experiment/Quark/src/tui/components/prompt.tsx#L132-L140)).

Users want to:
1. Type a follow-up instruction while the agent works, without losing it.
2. Have it auto-send the moment the current loop ends.
3. Optionally **steer** (inject the message immediately) or **cancel** it before it sends.

## Inspiration

Opencode-style **single unified box** with the queued message rendered as an
**inner row separated by a divider** from the active input. No floating bubble,
no separate chip widget — same rounded box, one more row when there's a queued
message.

**Queued state (chip row + input row):**

```diagram
╭─ 8% · 79k of 1000k ──────────────── deepseek-v4-pro ─╮
│ → can you also add tests                      queued │
├──────────────────────────────────────────────────────┤
│ █                                                    │
╰─ ⏵ running · ^N send now · ^D drop ─ ~/02-UM/03_year ─╯
```

**Idle state (no queued message — chip row absent, height collapses):**

```diagram
╭─ 8% · 79k of 1000k ──────────────── deepseek-v4-pro ─╮
│ █                                                    │
╰─────────────────────────────────── ~/02-UM/03_year ──╯
```

Visual rules:
- One outer rounded box (`╭╮╰╯`), no floating elements.
- Chip row only mounted when `queuedMessage !== null`; separated from input by `├─…─┤` divider.
- Right-aligned `queued` label on the chip row.
- `^N send now · ^D drop` keybinding hints appear in the bottom border only while running.
- Chip text truncates with `…` if it exceeds box width minus label width.

## Architecture

### State (new fields in `src/tui/state.ts`)

```ts
type QueuedMessage = {
  id: string
  text: string
  createdAt: number
}

// Add to store:
queuedMessage: QueuedMessage | null   // single-slot, not array (see decision #1)
```

Reducer actions:
- `queue-message` — set `queuedMessage`
- `clear-queued-message` — set to `null`
- `replace-queued-message` — overwrite (user edited it)

### Submit Flow

```diagram
   user hits Enter
        │
        ▼
   running?
   ┌────┴────┐
   no        yes
   │         │
   ▼         ▼
 send()   queue-message(text)
          (textarea clears, chip appears)
```

### Flush Hook

Subscribe to `loop-end` in [src/tui/events.ts](file:///Users/mac/01-CodeSpace/Personal-Lab/02-Experiment/Quark/src/tui/events.ts#L244-L246)
(NOT `assistant-message-end` — that fires mid-loop between tool rounds and
would corrupt context).

```ts
bus.on("loop-end", () => {
  store.set("running", false)
  const queued = store.queuedMessage
  if (queued) {
    store.dispatch("clear-queued-message")
    send(queued.text)   // becomes next turn
  }
})
```

### Steer (Inject Mid-Flight)

"Steer" = abort the current loop, prepend the queued message to the next turn.
Reuses the existing cancel path:

1. Call the same handler as `Esc` (loop abort).
2. On `loop-end`, the flush hook above sends the queued message as a fresh turn.

This avoids the hardest case (true mid-stream injection) by piggybacking on the
abort→restart cycle. Same UX outcome, zero context-corruption risk.

## Keybindings

| Key            | Action                                                |
|----------------|-------------------------------------------------------|
| `Enter`        | Send (or queue, if running)                           |
| `Ctrl+S`       | Steer — abort current loop and send queued now        |
| `Ctrl+D`       | Delete queued message                                 |
| `Ctrl+E`       | Edit queued message (pulls chip text back into input) |
| `Esc`          | Abort current loop (existing behavior, unchanged)     |

All four are no-ops when `queuedMessage` is `null`.

## Component Changes

### New: `src/tui/components/queued-chip.tsx`
Renders one-line chip above the prompt with truncated text + hint
`^S steer  ^D delete  ^E edit`. Only mounted when `queuedMessage !== null`.

### Modified: `src/tui/components/prompt.tsx`
- Remove the `disabled` guard that un-focuses the textarea.
- Keep the textarea focused and accepting input even when `running`.
- Replace "Agent is running..." placeholder with "Type a follow-up… (will send when agent finishes)".

### Modified: `src/tui/components/App.tsx`
- `handleSubmit`: branch on `running` → dispatch `queue-message` instead of early return.
- Mount `<QueuedChip />` above `<Prompt />`.
- Register `Ctrl+S` / `Ctrl+D` / `Ctrl+E` handlers (only active when `queuedMessage` exists).

## Key Decisions

1. **Single-slot queue, not a list.**
   Multiple queued messages create UX ambiguity (which one runs first? can you
   reorder?). One slot matches the reference design and keeps mental model simple.
   Sending a second message while one is queued **replaces** the first (with a
   one-line toast: "queued message replaced"). 
  

2. **Flush on `loop-end`, never `assistant-message-end`.**
   Mid-loop injection would land between tool call and tool result, breaking
   the model's reasoning chain.

3. **Send now = abort + send, not true injection.**
   True mid-stream injection requires custom provider-level support. Abort + send
   gives the user the same perceived outcome with existing primitives.

4. **Queued messages do NOT persist across TUI restarts.**
   They live only in in-memory store. If the process dies, the queued message
   is lost. Persisting it would imply auto-sending on next launch, which is
   surprising. Document this in the chip tooltip if we add one.

5. **No queueing of slash commands.**
   `/clear`, `/profile`, etc. need synchronous execution against current state.
   If user types a `/`-prefixed message while running, show inline error:
   "slash commands cannot be queued — press Esc to stop the agent first".

## Acceptance Criteria

- [ ] Typing + Enter while `running === true` adds a chip above the prompt and clears the textarea.
- [ ] The textarea remains focused and accepting input throughout an agent run.
- [ ] On `loop-end`, the queued message auto-sends as the next turn.
- [ ] `Ctrl+D` removes the queued message without sending.
- [ ] `Ctrl+E` pulls queued text back into the textarea for editing (chip disappears).
- [ ] `Ctrl+S` aborts the loop; queued message then sends via the flush hook.
- [ ] Submitting a new message while one is queued replaces it (no stacking).
- [ ] Slash commands typed while running show inline error and are NOT queued.
- [ ] Manual end-to-end test through the TUI (per AGENTS.md): start a long task,
      queue a follow-up, verify it sends exactly once when the loop ends.
- [ ] No regression in `Esc` behavior or existing `permissionQueue`/`questionQueue` handling.

## Out of Scope

- Multi-message queues with reordering.
- Persisting queued messages across restarts.
- True mid-stream model-level injection (would require provider API work).
- Web UI parity (separate spec; same state shape but different component layer).
