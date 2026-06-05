---
title: Sub-Agent TUI Redesign
date_created: 2026-05-05
date_modified: 2026-05-05
revision: 3
history:
  - 2026-05-05: Initial draft
  - 2026-05-05: Implementation complete — all backend + frontend changes done, tests pass
  - 2026-05-05: Fixed model resolution to use priority chain (CLI > profile > config). Added onMouseUp click for expand/collapse.
status: done
---

## Problem

When Quark spawns a sub-agent via bash (e.g., `quark --sub-agent --profile finder`), the TUI shows two overlapping displays:
1. A regular Bash tool card with the raw command + raw stdout/stderr
2. A SubAgentView tree nested below it

This is cluttered, redundant, and the raw command text is verbose and hard to read.

## Solution

Replace the bash tool card entirely for sub-agent invocations with a single unified view that shows:
- Header: verb + profile name + token usage + model ID
- Prompt line: extracted `--prompt` with clickable `[expand]`/`[collapse]`
- Tool tree: revealed on expand, hidden on collapse
- Streaming label: cycling quirky labels while sub-agent generates text

### States

| State | Header | Prompt/Tree |
|-------|--------|-------------|
| Running (no events yet) | `⠋ Summoning Finder · model` | Prompt + [expand], no tools |
| Running (streaming) | `⠋ Summoning Finder · tokens (X%) · model` | Prompt + tools + streaming label |
| Done (collapsed) | `✓ Finder responded · tokens (X%) · model` | Prompt + [expand] |
| Done (expanded) | same as above | Prompt + [collapse] + tool tree |
| Error | `✗ Finder failed · model` | Prompt + [expand] + error message |

## Key Decisions

### 1. Raw output suppression
For sub-agent bash commands, the raw stdout/stderr is never shown. The structured SubAgentView tree is the only output. Non-sub-agent bash commands render as normal ToolCards (no regression).

### 2. Model ID source
The model ID is resolved with full priority chain: CLI `--model` flag > profile `model` > config `main_model`. This resolved model is passed to `startEventWriter()` in `cli.ts` and embedded in every `step-finish` event. Previously the event-writer read `loadConfig().main_model` directly, ignoring profile and CLI overrides.

### 3. Prompt extraction
Extracted from the bash command string via regex. Handles `--prompt "..."` (quoted) and `--prompt unquoted` (until next flag). Truncated to 200 chars for display. If extraction fails, the prompt line is omitted.

### 4. Expand/collapse
Local `createSignal` in the SubAgentView component. SolidJS fine-grained reactivity preserves the signal across store mutations to the same component instance. Keyboard-navigable via Enter/Space on the `[expand]`/`[collapse]` control.

### 5. Streaming labels
Cycles through 6 labels every 3s: ✨ Thinking out loud… / 🧠 Processing vibes… / 🔮 Divining answer… / 💭 Having thoughts… / 📡 Beaming back… / 🌀 Spinning up…

### 6. Verb transitions
`Summoning` (running) → `responded` (done) → `failed` (error)

## Files to Change

| File | Change |
|------|--------|
| `src/session/event-writer.ts` L67-73 | Add `model` to step-finish emitted event |
| `src/session/events.ts` L125-129 | Add `modelName?` to BusEvents["subagent-step-finish"] |
| `src/tui/events.ts` L348-357 | Forward `modelName` to dispatch |
| `src/tui/state.ts` | Add `modelName?`, `prompt?` to SubAgentState. Add `parseSubAgentCommand()`. Store modelName in reducer. |
| `src/tui/components/message-item.tsx` L41-60 | Remove ToolCard from sub-agent branch |
| `src/tui/components/sub-agent-view.tsx` | Full redesign (see layout spec below) |

## Component Layout (SubAgentView)

```
box (flexDirection="column")
  ├── Header row: StatusIndicator + verb/profilename + token info + model
  ├── Prompt row: "Task: " + truncated prompt + [expand]/[collapse] toggle
  └── Tool tree (show when expanded):
        ├── ChildToolLine for each tool
        └── Streaming label (when hasTextPreview)
```

## Acceptance Criteria

- [ ] Bash sub-agent shows no raw command text or stdout/stderr
- [ ] Header shows `Summoning {Profile}` with spinner (running), `✓ responded` (done), `✗ failed` (error)
- [ ] Model ID displayed: `· opencode/deepseek-v4-flash`
- [ ] Prompt extracted from `--prompt` shown as `Task: "..." [expand]`
- [ ] `[expand]` reveals full prompt + tool tree; `[collapse]` hides both
- [ ] `[expand]`/`[collapse]` keyboard-navigable
- [ ] Streaming label cycles through 6 labels every 3s
- [ ] Non-sub-agent bash renders as normal ToolCard (no regression)
