---
title: Prompt Loop Boundary Refactor
date_created: 2026-05-13
date_modified: 2026-05-13
revision: 3
history:
  - 2026-05-13: Initial plan for issue 137 prompt loop boundary extraction
  - 2026-05-13: Extracted prompt loop boundaries and verified focused tests
  - 2026-05-13: Verified TUI boot after session/event boundary changes
status: done
---

# Prompt Loop Boundary Refactor

## Problem

`src/session/prompt.ts` is the loop entry point, but it also owns provider
construction, AI SDK tool adaptation, branch execution details, and a TUI
message mapper. That makes the agent loop hard to reason about and leaks UI
concerns into core/session code.

## Architecture

```
prompt()
  |
  +-- provider/resolver.ts       provider + model construction
  +-- tool/ai-adapter.ts         ToolDef -> AI SDK tool()
  +-- session/branch-controller  branch checks + branch creation wrapper
  +-- session/session-switch.ts  branch/session switch event payload
  +-- shared/conversation-view   persisted rows -> display-neutral messages
```

The loop should coordinate these responsibilities, not implement them.

## Key Decisions

- Keep `prompt.ts` as the public entry point and loop coordinator.
- Keep `resolveModel` re-exported from `prompt.ts` for existing callers.
- Move persisted-row display mapping to `shared/` so session and web code do not
  import TUI state.
- Keep TUI compatibility wrappers where current tests and components import TUI
  names.

## Acceptance Criteria

- `prompt.ts` no longer owns provider construction.
- `prompt.ts` no longer owns AI SDK tool wrapping.
- Core session modules do not import `src/tui/*`.
- Web message endpoints use a shared mapper, not TUI state.
- Focused session/tool/typecheck coverage passes.
