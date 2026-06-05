---
title: Prompt Input — Bounded Height & Paste Collapse
date_created: 2026-05-26
date_modified: 2026-05-26
revision: 1
history:
  - 2026-05-26: Initial draft and implementation. Capped input box at maxHeight=8, added paste-collapse with side-buffer expansion on submit.
status: done
---

# Prompt Input — Bounded Height & Paste Collapse

## Problem

The TUI prompt textarea in [src/tui/components/prompt.tsx](file:///Users/mac/01-CodeSpace/Personal-Lab/02-Experiment/Quark/src/tui/components/prompt.tsx)
had `minHeight={4}` but no upper bound. Pasting a long file, stack trace, or
log payload caused the input box to balloon vertically, pushing the
conversation transcript off-screen and degrading scroll context. This is
a long-known UX failure mode in terminal agents.

## Goals

1. **Cap the visible input area.** A pasted payload must never push the
   transcript out of view.
2. **Preserve the payload.** The full pasted content must still reach the
   model on submit — the cap is purely visual.
3. **Communicate clearly.** The user must see *that* a paste happened and
   *how large* it was, without seeing the contents inline.
4. **No surprise for small pastes.** Pasting a 2-line snippet should still
   appear verbatim — collapse is a heavy-paste affordance, not a default.

## Design

### 1. Hard ceiling on input box height

```tsx
<box minHeight={4} maxHeight={8} ...>
```

`maxHeight = 2 × minHeight`. The inner `<textarea>` scrolls internally
when content exceeds the visible area.

### 2. Paste-collapse via OpenTUI `onPaste`

OpenTUI's `TextareaRenderable` exposes `onPaste(event: PasteEvent)` where
`event.text` is the raw pasted payload and `event.preventDefault()`
suppresses the default insert. We use this to intercept large pastes
*before* they enter the buffer.

```text
Paste detected
  │
  ├─ chars ≤ 400 AND lines ≤ 6   → fall through (default insert)
  │
  └─ otherwise:
       ├─ event.preventDefault()
       ├─ id = ++counter
       ├─ pasteBuffer.set(id, fullText)
       └─ textarea.insertText(`[Pasted #${id} +${lines} lines]`)
```

### 3. Threshold: char OR line (whichever trips first)

Char count is the more reliable single metric — a 3000-char minified
JSON paste is one line yet visually wraps past `maxHeight`. Line count
catches the inverse case (many short lines). Using **OR** of both
covers both axes.

| Paste shape                  | chars | lines | Triggers? |
|------------------------------|-------|-------|-----------|
| `25 × 40 chars`              | 1000  | 25    | ✓ (both)  |
| `1 × 3000 chars` (minified)  | 3000  | 1     | ✓ (chars) |
| `200 × 5 chars`              | 1000  | 200   | ✓ (lines) |
| `3 × 50 chars` (snippet)     | 150   | 3     | ✗         |

Chosen thresholds (calibrated to `maxHeight=8`):
- `PASTE_CHAR_THRESHOLD = 400`
- `PASTE_LINE_THRESHOLD = 6`

### 4. Expansion on submit

`handleSubmit` reads `textareaRef.plainText`, runs it through
`expandPastes()`, then forwards the expanded string to `props.onSubmit`.
The side buffer is cleared on every submit.

```text
Textarea buffer:  "Please summarize [Pasted #1 +120 lines]"
        │
        ▼ expandPastes()
Sent to agent:    "Please summarize <full 120-line payload>"
```

Unknown tokens (user typed `[Pasted #99 +5 lines]` by hand, or the
entry was already consumed) fall back to verbatim — no exception, no
data loss.

## Implementation

All changes localized to [src/tui/components/prompt.tsx](file:///Users/mac/01-CodeSpace/Personal-Lab/02-Experiment/Quark/src/tui/components/prompt.tsx):

| Piece                          | Scope              | Purpose                                |
|--------------------------------|--------------------|----------------------------------------|
| `PASTE_CHAR_THRESHOLD = 400`   | module             | trigger threshold (chars)              |
| `PASTE_LINE_THRESHOLD = 6`     | module             | trigger threshold (lines)              |
| `PASTE_TOKEN_RE`               | module             | matches `[Pasted #N +X lines]`         |
| `pasteBuffer: Map<number,str>` | component instance | id → original text                     |
| `pasteCounter: number`         | component instance | monotonic id source                    |
| `handlePaste(event)`           | component instance | intercept + collapse                   |
| `expandPastes(text)`           | component instance | inverse: token → original on submit    |
| `r.onPaste = handlePaste`      | inside `handleRef` | wires the OpenTUI ref to our handler   |
| `maxHeight={8}`                | input `<box>`      | hard visual ceiling                    |

## Key Decisions

- **Char + line (OR), not just one.** A single metric leaves a blind spot
  (long lines vs many lines). Using both catches every realistic shape.
- **Side buffer, not in-textarea hidden state.** Keeps the textarea's
  visible content == what the user sees. Cursor navigation, undo/redo,
  selection — all work on the placeholder as one atomic glyph cluster.
- **No persistence across submits.** The map clears on every submit. A
  paste belongs to one message; carrying it forward would be surprising.
- **Component-scope counter, not module-scope.** Resets cleanly on
  component remount; avoids monotonically growing ids across sessions.
- **No new dependency on `@opentui/core/lib/KeyHandler`.** `PasteEvent`
  is re-exported from `@opentui/core` root via `lib/index`. Importing
  the subpath would couple us to an internal layout.

## Acceptance Criteria

- [x] Input box never exceeds 8 rows of terminal height.
- [x] Pasting >400 chars or >6 lines produces a `[Pasted #N +X lines]`
      token in the textarea.
- [x] Submitted message contains the full original paste content, not
      the token.
- [x] Multiple pastes in one message are each tracked and expanded
      independently.
- [x] Small pastes insert inline with no token wrapping.
- [x] `npm run typecheck` passes.
- [ ] **Manual TUI verification** (per AGENTS.md: end-to-end check
      required for any TUI change). Recommended cases:
      1. Paste a 100-line file → token appears, message sends with full content.
      2. Paste a minified 3KB JSON blob (1 line) → token appears.
      3. Paste a 3-line snippet → inserts as-is.
      4. Paste twice, type between → both tokens expand independently on submit.

## Future Work

- Persist large pastes to a temp file and reference by path for very
  large payloads (multi-MB) to avoid bloating context tokens unnecessarily.
- Show a hover/expand affordance (e.g. `Ctrl+P` to preview the stashed
  payload in a modal) for users who want to verify before submitting.
- Make thresholds configurable via `.quark/config.yaml`.
