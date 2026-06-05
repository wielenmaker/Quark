---
title: Desktop — Model picker & thinking level picker in composer
date_created: 2026-05-07
date_modified: 2026-05-07
revision: 2
history:
  - 2026-05-07: Initial draft based on audit of EPIC-17 gaps
  - 2026-05-07: Oracle review — fixed showThinking display issue, clarified API parse step, moved chat state out of DesktopState
status: in-progress
---

## Problem

The Quark Desktop app has no way to change the model or select a thinking
effort level. The only thinking control is a binary "T" toggle button in the
agent header that hardcodes `effort: "high"`. The user can't pick from
Claude's 6 effort levels (low → max), DeepSeek's 3 levels, or even know
which model is active.

## Scope

- Model picker pill in the composer bar
- Thinking level picker pill in the composer bar (model-aware)
- New session button in the agent header
- Backend API additions to expose thinking levels and accept effort
- State changes to track `selectedModel` and `thinkingEffort`
- Remove the existing "T" toggle button from the agent header

Out of scope: multi-line input, @mention, slash commands, attachment button.

## Design

### Layout

```
┌── Omnibar (border-radius: 18px) ───────────────────────────────┐
│  Ask Quark…                                                    │
│                                                                │
│  [+]    [sonnet-4.5 ▾]    [medium ▾]                    [▲]   │
└────────────────────────────────────────────────────────────────┘
```

Two pills live in `composer-tools`, between the context button and the send
button. Both are pill/capsule-shaped (border-radius: 999px), matching the
omnibar's visual language.

### Model pill

- Shows current model short-name (last segment after `/`):
  `claude-sonnet-4.5`, `gpt-5.4-pro`, `deepseek-v4-pro`
- Click opens an upward-popup dropdown listing all models from config.yaml
  (fetched from `GET /api/models`)
- Current model has a ✓ checkmark
- On select: calls `POST /api/model { model: selectedId }`, updates state

### Thinking pill

- Shows current effort level: `none`, `low`, `medium`, `high`, `xhigh`, `max`,
  or `thinking` for binary models
- Click opens an upward-popup dropdown listing only the levels valid for the
  current model (from `GET /api/thinking/levels?model=X`)
- Current level has a ✓
- When level is `none` → pill appears muted (var(--disabled)), no chevron,
  label shows `—`
- When level is active → pill border is accent-colored
- On select: calls `POST /api/thinking { enabled, effort }`, updates state

### Model-change cascade

When the user picks a different model:
1. `POST /api/model { model: newModelId }`
2. Thinking pill re-fetches levels for the new model
3. If new model has thinking support: effort resets to a sensible default
   (middle of its range, e.g. `medium` for Claude/GPT, `thinking` for binary).
   If the prior effort exists in the new model's levels, keep it.
4. If new model has NO thinking support: effort = `none`, pill disabled

### New session button

Icon button (`icon-file-plus`) in the agent header, next to the status dot:

```
┌── Agent card header ────────────────────────────────────────────┐
│  Quark                            [+]    [● connected]          │
└──────────────────────────────────────────────────────────────────┘
```

Click calls `POST /api/sessions` (create new), switches to it, clears messages.

Removes the existing "T" toggle button from the header — thinking is now
controlled via the composer pill exclusively.

**Thinking display in chat:** The `showThinking` state in `ChatState` is
retained but auto-derived. When `thinkingEffort !== "none"`, thinking parts
in the message thread are displayed. When `thinkingEffort === "none"`, they
are hidden. No separate show/hide toggle — display follows the effort level
chosen in the composer pill.

### Dropdown styling

```
  ╭──────────────────────╮
  │ claude-sonnet-4.5 ✓ │
  │ claude-opus-4.7     │
  │ gpt-5.4             │
  │ gpt-5.4-pro         │
  │ deepseek-v4-pro     │
  │ qwen3-max           │
  ╰──────────────────────╯
```

- Pops upward from the pill
- border-radius: 12px, border: 1px solid var(--line)
- box-shadow: 0 4px 16px rgba(0,0,0,0.12)
- Each item: 6px 12px padding, 8px border-radius
- Hover: bg var(--hover)
- Selected: bg var(--accent-soft), color var(--accent)
- Scrollable if more than ~8 items

## Backend API changes

### 1. New endpoint: `GET /api/thinking/levels?model=claude-sonnet-4.5`

**This endpoint does not exist yet — it must be created.** The backend
already has `getThinkingLevels()` from `src/provider/thinking.ts:151`
(used in-process by the TUI), but no HTTP route exposes it. This endpoint
wraps that function.

Returns:
```json
{ "levels": ["none", "low", "medium", "high", "xhigh", "max"] }
```
If model is omitted, uses the current effective model.
If model doesn't support thinking, returns `{ "levels": null }`.

### 2. Change `POST /api/thinking` to accept `effort`

Current: `{ enabled: boolean }` — hardcodes `"high"` on enable.

New:
```json
{ "enabled": true, "effort": "medium" }
```
Or shortcut:
```json
{ "effort": "none" }
```
Backward-compatible: if `enabled` is sent without `effort`, keep current
behavior (default `"high"`).

### 3. Change `GET /api/thinking` to return `effort`

Current: `{ enabled: boolean }`

New:
```json
{ "enabled": true, "effort": "medium" }
```

## Desktop state changes

### `RightPane.tsx` — `ChatState` additions

Model and thinking state lives in `ChatState` (RightPane's local reducer), not
in `DesktopState`. `DesktopState` is for file/diff/preview concerns and should
not carry chat metadata.

```typescript
interface ChatState {
  // ... existing fields (messages, sessionId, connected, running, showThinking, errorMsg) ...
  selectedModel: string | null       // model override, null = use config default
  thinkingEffort: string             // current effort level, "none" = off
  thinkingLevels: string[] | null    // levels for current model, from GET /api/thinking/levels
}
```

`showThinking` is retained but derived: the chat display logic uses
`state.thinkingEffort !== "none"` to decide whether to render thinking parts
(rather than a separate toggled boolean). The field stays for backward
compatibility with the existing rendering code.

### Model list conversion

`GET /api/models` returns `{ models: string[], mainModel: string }` where
`models` is a flat array of provider-prefixed IDs like
`"anthropic:claude-sonnet-4.5"`. The desktop parses these client-side:

```typescript
type ModelInfo = { id: string; name: string }  // name is short-name (last segment after /)
const models: ModelInfo[] = raw.models.map(id => ({
  id,
  name: id.includes("/") ? id.split("/").pop()! : id,
}))
```

No API change needed — same pattern the TUI uses at `src/tui/index.tsx:381`.

## Acceptance criteria

- [ ] Model pill shows current model short-name in the composer bar
- [ ] Clicking model pill opens a dropdown with all configured models
- [ ] Selecting a model updates the active model via API and UI
- [ ] Thinking pill shows current effort level (or `—` when off)
- [ ] Thinking pill dropdown shows only levels valid for the current model
- [ ] Selecting an effort level updates thinking via API
- [ ] Changing the model cascades to reset thinking levels appropriately
- [ ] New session button in agent header creates a fresh session
- [ ] The old "T" toggle button is removed from the agent header
- [ ] `GET /api/thinking/levels` returns correct levels per model
- [ ] `POST /api/thinking` accepts and applies `effort`
- [ ] `GET /api/thinking` returns both `enabled` and `effort`
- [ ] Dropdowns close on click-outside and on Escape
- [ ] Dropdown selection is keyboard-navigable (arrow keys + Enter)
- [ ] Pills and dropdowns match omnibar border-radius (18px → 999px pills)
- [ ] Existing web UI and TUI are unaffected by API changes
