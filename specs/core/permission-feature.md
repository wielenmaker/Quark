---
title: Permission System — Pre-Execution Gate & Profile-Level Rules
date_created: 2026-05-02
date_modified: 2026-05-03
revision: 3
history:
  - 2026-05-02: Initial draft
  - 2026-05-03: Implemented — awaiting_approval status, pre-execute gate, profile rules, rejection abort, E2E tests
  - 2026-05-03: Clarified internal Rule fields (permission/pattern/action) — config `tool` maps to Rule `permission`
status: done
---

# Permission System — Pre-Execution Gate & Profile-Level Rules

## Problem

The permission system (`src/permission/permission.ts`) existed but was not wired
to any configuration or properly integrated into the tool execution lifecycle.
Three gaps:

1. **Status lie**: The TUI showed `status: "running"` while the user was staring at
   a permission prompt. The `tool-call` stream event immediately transitioned from
   `pending` → `running`, then `ctx.ask()` blocked inside `execute()`.

2. **Hardcoded empty ruleset**: `ctx.ask()` passed `ruleset: []` with a TODO
   comment. No permission rules flowed from config → profile → agent → tools.

3. **Carryover field**: `ToolContext.messages` was defined and wired through the
   call chain but never read by any tool implementation.

Additionally, a rejected permission (user clicked "reject") did not abort the
agent step — the model could call another tool. `RejectedError` was treated as
a regular `tool-error` and the stream continued.

---

## Solution

### 1. New `awaiting_approval` tool status

A fifth tool status between `pending` and `running`:

```
pending → awaiting_approval → running → completed/error
```

- `pending` — AI SDK is still streaming the tool's input args
- `awaiting_approval` — input complete, permission check in progress (prompt visible)
- `running` — permission granted, tool executing
- `completed` — tool finished normally
- `error` — tool failed, denied, or aborted

### 2. Pre-execute permission gate

The permission check (`askPermission()`) moved from inside `def.execute()` (via
`ctx.ask()`) to the top of `toAITool().execute()`, **before** `def.execute()`
is called. The tool never runs if permission is denied or rejected.

### 3. Profile-level permission rules

`~/.config/quark/config.yaml` → `ProfileDef` → `AgentConfig` → `resolveToolSet()`
→ `toAITool()` → `ctx.ask()`.

Config format (per-profile):
```yaml
profiles:
  coder:
    tools: [read, write, edit, bash, skill]
    permissions:
      - tool: "read"
        action: "allow"
      - tool: "bash"
        action: "ask"
      - tool: "write"
        action: "deny"
```

Converted to internal `Ruleset` at `resolveToolSet()` — each config entry becomes a `Rule`:
```ts
interface Rule {
  tool: string           // ← matches config `tool` field directly (no rename)
  pattern: string        // hardcoded to `"*"` (argument-level patterns TODO)
  action: Action         // ← matches config `action` field directly
}
// Ruleset = Rule[] — evaluated with findLast() (last matching rule wins)
```
Call site in `toAITool()` passes `def.id` as `tool` → `evaluate()` matches against `rule.tool`.

### 4. Rejection abort

When the user rejects a permission request (once/always/reject → "reject"), the
entire agent step is aborted:

1. `respond({ reply: "reject" })` → throws `RejectedError` / `CorrectedError`
2. `toAITool()` catch block → `bus.emit("permission-rejected", { sessionId })`
3. `prompt.ts` listener → `cancel(sessionId)` → `controller.abort()`
4. `processStream()` sees abort → stream breaks → loop stops

Hard `deny` rules do NOT abort — the model can see the denial and respond.

### 5. Removed `messages` from ToolContext

Unused field removed from interface, `toAITool()`, `resolveToolSet()`, and the
`compact` tool (which now builds `modelMessages` from DB via `toModelMessages()`).

---

## Files Changed

| File | Change |
|---|---|
| `src/session/message.ts` | Added `"awaiting_approval"` to `ToolPartData.status` union |
| `src/tool/tool.ts` | Removed `messages: any[]` from `ToolContext` + JSDoc |
| `src/session/events.ts` | Added `"tool-running"` and `"permission-rejected"` event types |
| `src/profile/profile.ts` | Added `permissions?: Array<{ tool, action }>` to `ProfileDef`, YAML parser `parsePermissions()` |
| `src/agent.ts` | Added `permissions` to `AgentConfig`, copied in `agentFromProfile()` |
| `src/session/prompt.ts` | Removed `messages` from `resolveToolSet()`/`toAITool()` chain. Built `Ruleset` from `agent.permissions` in `resolveToolSet()`. Pre-execute `askPermission()` gate in `toAITool()`. Emits `bus.emit("tool-running")` after gate, `bus.emit("permission-rejected")` on reject. Module-level listener calls `cancel()`. |
| `src/session/processor.ts` | `tool-call` sets `"awaiting_approval"` (was `"running"`). Abort handler includes `"awaiting_approval"`. |
| `src/tool/compact.ts` | Removed `modelMessages` from ctx destructure, builds from DB |
| `src/tui/state.ts` | Added `"awaiting_approval"` to `TuiPart`/`SubAgentToolPart` unions. New `tool-running` action. `tool-input` sets `"awaiting_approval"` (was `"running"`). `tool-running` sets `"running"`. Fixed `done` logic in `dbToTuiMessages()`. Sub-agent cascade includes `"awaiting_approval"`. |
| `src/tui/events.ts` | Listens for `"tool-running"` → dispatches `tool-running` action |
| `src/tui/components/tool-result.tsx` | Added `"awaiting_approval"` to props, spinner/indicator logic, output visibility |
| `src/tui/components/sub-agent-view.tsx` | Added `"awaiting_approval"` to `parentStatus`, `StatusIndicator` (renders `? `) |

## Tests

| File | Purpose |
|---|---|
| `test/permission/permission.test.ts` | 26 existing unit tests pass unchanged |
| `test/permission/permission-gate-e2e.test.ts` | 16 new E2E integration tests: allow/deny/ask flows, last-match-wins, multi-tool rules, `tool-running` emission, `permission-rejected` emission, empty ruleset default, `clearSession` abort |
| `test/tui/events.test.ts` | Updated to expect `"awaiting_approval"` + `"tool-running"` transition |
| `test/tui/state.test.ts` | Updated tool-input and subagent-done tests for new status flow |

## Diagram

`../diagrams/permission-state-machine.html` — tool call status lifecycle state machine.

---

## Acceptance Criteria

1. Profile-level permission rules load from `config.yaml` profiles section
2. `tool: "read", action: "allow"` skips permission prompt, tool executes immediately
3. `tool: "bash", action: "ask"` shows permission prompt in TUI before execution
4. `tool: "write", action: "deny"` throws `DeniedError` immediately, no prompt
5. Status `awaiting_approval` appears between `pending` and `running` in the TUI
6. `tool-running` bus event transitions status from `awaiting_approval` → `running`
7. Permission prompt shows "awaiting" status (not "running")
8. `ctx.messages` removed from `ToolContext` interface and all wiring
9. No `messages` parameter on `resolveToolSet()` or `toAITool()`
10. Existing permission tests pass (26/26)
11. E2E gate tests pass (16/16) verifying allow/deny/ask/always/reject/rejection-abort
12. TypeScript typecheck clean
13. `permission-rejected` event aborts agent loop, model cannot call another tool
14. `deny` hard rule does NOT abort (model can respond to denial)
15. TODO comments on `ProfileDef`, `AgentConfig`, and `ctx.ask()` for future argument-level permission support
