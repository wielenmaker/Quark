---
title: "Permission Gate: Pre-Execution, Tool-Name Level"
date_created: 2026-05-05
date_modified: 2026-05-05
revision: 1
history:
  - 2026-05-05: Initial investigation — where permission gating fires relative to tool arguments
status: done
---

# Permission Gate: When Does It Fire?

## Question

When the agent decides to use a tool like `Edit`, does the permission gate check
just the tool name (`"edit"`), or does it also see the tool's arguments (e.g.,
`"edit filePath='/src/foo.ts' oldString='...' newString='...'"`)?

## Answer

**The permission gate fires AFTER the agent has decided tool + arguments,
but BEFORE the tool's `execute()` function runs. It currently only checks
the tool name, not the arguments.**

### Full Flow

```
Agent decides: "edit(filePath='/foo/bar', oldString='...', newString='...')"
    ↓
Permission gate checks: tool="edit", pattern="*"   ← fires here
    ↓  (if allowed)
Tool's execute() runs with the arguments
    ↓  (if denied/rejected)
Tool never executes; error thrown back to agent loop
```

### Key Code Path

**File: `src/session/prompt.ts`, lines 646-664** — inside `toAITool().execute()`:

```ts
// 1. Permission gate BEFORE any tool execution
try {
  await askPermission({
    sessionId,
    tool: def.id,      // e.g. "edit", "bash", "read"
    pattern: "*",      // ← hardcoded wildcard, always matches
    ruleset,
  });
} catch (e) {
  if (e instanceof RejectedError || e instanceof CorrectedError) {
    bus.emit("permission-rejected", { sessionId });
  }
  throw e;
}
```

The `pattern` is always `"*"` — a wildcard that matches anything. This means
`evaluate()` in `src/permission/permission.ts` (line 160) effectively only
matches on tool name:

```ts
export function evaluate(tool: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  const merged = rulesets.flat()
  const match = merged.findLast(
    (rule) =>
      wildcardMatch(tool, rule.tool) &&
      wildcardMatch(pattern, expandPath(rule.pattern)),
  )
  return match ?? { action: "ask", tool, pattern: "*" }
}
```

Since `pattern` is always `"*"`, and `"*"` matches any `rule.pattern`,
the check reduces to: does `def.id` match `rule.tool`?

## Why Pattern Is Always `"*"`

The `pattern` is designed to support argument-level gating in the future.
A tool could call `ctx.ask("edit", "/sensitive/file")` to request permission
for editing a specific file. But the **pre-execute gate** (the one that fires
before `execute()`) doesn't use this capability yet.

There's a TODO at line 675:

```ts
// TODO: later support argument-level permission via ctx.ask()
```

## What Rules Look Like Today

From config:
```yaml
permissions:
  - tool: "read"
    action: "allow"
  - tool: "bash"
    action: "ask"
  - tool: "edit"
    action: "deny"
```

These become `Ruleset` entries with `pattern: "*"` in `resolveToolSet()`
(`src/session/prompt.ts`, line 590):

```ts
const ruleset: Ruleset = (agent.permissions ?? []).map(r => ({
  tool: r.tool,
  pattern: "*",
  action: r.action,
}));
```

So a rule `{ tool: "edit", pattern: "*", action: "deny" }` will block ANY
edit call regardless of file path or content.

## Edit-Like Tool Grouping

The `disabled()` function in `src/permission/permission.ts` (line 183) groups
edit-like tools under the `"edit"` permission:

```ts
const EDIT_TOOLS = ["edit", "write", "patch"]
```

So a deny rule for `"edit"` also blocks `write` and `patch`. But this only
applies to `disabled()` — the pre-execute gate does NOT use this grouping
(permission.ts `evaluate()` matches `def.id` directly against `rule.tool`).

**Note:** Since `disabled()` maps `edit | write | patch → "edit"` for display
purposes, but the pre-execute gate in `toAITool()` passes `def.id` directly to
`askPermission()`, there's an asymmetry: a rule `{ tool: "edit", action: "deny" }`
will NOT block `write` at the pre-execute gate (because `def.id` would be `"write"`,
which doesn't match `rule.tool === "edit"`). Only `disabled()` greys it out.

## Status: `awaiting_approval` Between Pending and Running

When the gate fires and the action is `"ask"`, the tool enters the
`awaiting_approval` status (introduced in `specs/permission-feature.md`):

```
pending → awaiting_approval → running → completed/error
```

This is set in `src/session/processor.ts` where `tool-call` events now set
`status: "awaiting_approval"` instead of the old `"running"`. The status only
transitions to `"running"` after the permission gate passes and
`bus.emit("tool-running", ...)` fires in `toAITool()` (line 667).

## Related Files

| File | Role |
|------|------|
| `src/permission/permission.ts` | Rule evaluation, ask/respond lifecycle |
| `src/session/prompt.ts` | `toAITool()` — pre-execute gate + ruleset wiring |
| `src/session/processor.ts` | `tool-call` sets `awaiting_approval` status |
| `src/tool/tool.ts` | `ToolContext.ask()` — future argument-level API |
| `src/profile/profile.ts` | `ProfileDef.permissions` — config → agent passthrough |
| `test/permission/permission-gate-e2e.test.ts` | E2E tests for allow/deny/ask flows |

## Finder Timeout Investigation

The `finder` sub-agent was spawned with a 30-second timeout on the `bash`
command and killed before it could complete. This was a **bash tool timeout**,
not a sub-agent crash.

Findings:
- The 30s timeout was set on the `bash` tool call spawning the sub-agent
- Sub-agents use `--no-store` by rule (ephemeral sessions), so no session
  data was persisted to disk from the finder run
- The finder profile (`~/.config/quark/profiles/finder.md`) has only
  `[read, grep, glob, skill]` tools — it needed more than 30s to explore
  the codebase
- Lesson: for sub-agent exploration tasks, use longer timeouts or tmux
