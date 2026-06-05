---
title: Tool Rendering Unification & Read-Only Tool Hiding
date_created: 2026-05-03
date_modified: 2026-05-03
revision: 4
history:
  - 2026-05-03: Initial draft
  - 2026-05-03: Implemented — ToolCard component, dispatch-level filtering, files deleted
  - 2026-05-03: Removed "skill" from READ_ONLY_TOOLS — skill tool invocations now render in TUI (Issue #128)
  - 2026-05-03: Removed event filtering entirely — read-only tools now render header-only (body suppressed via ToolCardBody), not filtered at dispatch (Issue #128)
status: done
---

# Tool Rendering Unification & Read-Only Tool Hiding

## Problem

The TUI tool rendering (`src/tui/components/message-item.tsx` `PartView`) uses a
fragile cascade of `Match` conditions that mixes status phases and tool identity:

```
skill + running       → ToolInvocationBlock   (special case)
bash + subAgent       → ToolResultView + SubAgentView  (special case)
bash + running        → ToolInvocationBlock   (special case)
everything else       → ToolResultView        (catch-all — handles ALL phases)
```

Three specific issues:

1. **Component duplication**: `ToolResultView` and `ToolInvocationBlock` both
   render status indicators (spinner vs ✓/✗) but are used inconsistently.
   `ToolResultView` handles non-terminal states (`pending`, `awaiting_approval`)
   where there are no results yet — a component named "result view" showing empty
   cards is conceptually broken.

2. **Per-tool body logic buried in ToolResultView**: `WriteStreamView`, `DiffView`,
   and `ScrollableOutput` are shown/hidden via `Show when={props.tool === "write" ...}`
   conditions inside `ToolResultView`. This couples rendering logic to a single
   component that also handles unrelated tool types.

3. **No filtering for read-only tools**: `read`, `grep`, `glob`, `websearch`,
   `webfetch`, `perplexity-search`, and `skill` events are dispatched and stored
   in state even though they contribute nothing useful to the conversation view.

## Goal

1. **Unify tool rendering** into a single `ToolCard` component with clear
   header/body separation:
   - **Header** (always visible): spinner/status + tool name + args label
   - **Body** (polymorphic by tool): stream/diff/error/output or empty

2. **Filter read-only tools at dispatch** so they never enter the TUI state store.

## Architecture

### Proposed Component Structure

```
┌──────────────────────────────────┐
│ ⠋ Bash  ~/deploy.sh              │  ← Header: status icon + tool name + args
│ ──────────────────────────────┐ │
│ │ Output                       │ │  ← Body: polymorphic by tool + status
│ │                              │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

### Header Evolution

| State | Header |
|---|---|
| `pending` | `… Read ~/src/tool.ts` (muted ellipsis) |
| `awaiting_approval` | `? Write ~/out.ts` (question mark) |
| `running` | `⠋ Bash ls -la` (animated spinner) |
| `completed` | `✓ Bash ls -la` (green check) |
| `error` | `✗ Bash exit 1` (red cross) |

### Body Rendering (polymorphic by tool + status)

| Tool | Status | Body |
|---|---|---|
| `write` | `running` + `streamingContent` | `WriteStreamView` (progressive green lines) |
| `edit` | `completed` + `diff` | `DiffView` (unified diff) |
| `bash` | terminal + `output` | `ScrollableOutput` |
| `todo` | any | empty |
| `question` | any | empty |
| `skill` | any | empty body, **header renders "Skill" with label** |
| read-only (`read`, `grep`, …) | — | **filtered at dispatch, never rendered** |

### `PartView` Simplification

The 4 Match cases for tools collapse to 2:

```tsx
<Switch>
  <Match when={props.part.type === "text"}>
    ...
  </Match>

  {/* Sub-agent: bash tool with subAgent state */}
  <Match when={props.part.type === "tool" && asTool().subAgent}>
    <ToolCard {...asTool()} />
    <SubAgentView ... />
  </Match>

  {/* All other tools — ToolCard handles everything */}
  <Match when={props.part.type === "tool"}>
    <ToolCard {...asTool()} />
  </Match>

  <Match when={props.part.type === "thinking"}>
    ...
  </Match>
</Switch>
```

### Dispatch-Level Filtering (REMOVED — Issue #128)

Originally, `src/tui/events.ts` skipped `tool-start`, `tool-input`, `tool-end`
bus events for tools in `READ_ONLY_TOOLS`. This was incorrect — it prevented
the ToolCard header from rendering, making read-only tool invocations invisible.

**Current approach:** All tool events flow through dispatch. Instead,
`ToolCardBody` suppresses the output body for read-only tools via
`!READ_ONLY_TOOLS.has(props.tool)`, so they render as header-only:
`✓ Read ~/file.ts` (no file content dump).

## Files Changed

| File | Action | Description |
|---|---|---|
| `src/tui/events.ts` | Edit | Add `READ_ONLY_TOOLS` import, skip dispatch for read-only tools |
| `src/tui/components/tool-card.tsx` | **New** | Unified `ToolCard` with header + polymorphic body |
| `src/tui/components/message-item.tsx` | Edit | Simplify `PartView` — remove `ToolResultView`/`ToolInvocationBlock` imports, collapse Match cases |
| `src/tui/components/tool-result.tsx` | **Delete** | Absorbed into `ToolCard` |
| `src/tui/components/tool-invocation.tsx` | **Delete** | Absorbed into `ToolCard` |
| `test/tui/tool-result-view.test.ts` | Edit → Rename | Update for `ToolCard`, add read-only filtering tests |

## Shared Utilities

`getToolDisplayName()`, `getToolLabel()` exist in both `tool-result.tsx` and
`tool-invocation.tsx`. These will be consolidated into `tool-card.tsx`.

## Migration Notes

1. Create `ToolCard` first, keep `ToolResultView`/`ToolInvocationBlock` imports
   in `message-item.tsx` pointing to the new file (re-export for gradual migration)
2. Wire dispatch filtering in `events.ts`
3. Replace `PartView` tool handling to use `ToolCard`
4. Delete old files
5. Update tests

## Acceptance Criteria

1. `ToolCard` renders a unified header (status icon + tool name + args) for all tools
2. Body renders `WriteStreamView` for `write` (running), `DiffView` for `edit` (completed), `ScrollableOutput` for `bash` (terminal), **empty for read-only tools** (`read`, `grep`, `glob`, `websearch`, `webfetch`, `perplexity-search`, `skill`), empty for `todo`/`question`
3. `PartView` has only 2 tool-related `Match` cases (sub-agent + catch-all)
4. All tool events flow through dispatch — no filtering (body suppression happens in ToolCardBody)
5. `tool-result.tsx` and `tool-invocation.tsx` are deleted
6. Existing tests for tool rendering pass (updated for `ToolCard`)
7. New tests assert read-only tools create parts but body is suppressed
8. TypeScript typecheck clean
9. `bun test test/tui/` passes
