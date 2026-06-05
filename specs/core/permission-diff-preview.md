---
title: "Permission Prompt Diff Preview"
date_created: 2026-05-05
date_modified: 2026-05-05
revision: 1
history:
  - 2026-05-05: Initial spec from Oracle plan
status: draft
---

# Permission Prompt Diff Preview

## Problem

When the edit tool requires permission (`action: "ask"`), the permission prompt shows only the filename:

```
▲ Allow Edit?  ~/file.ts
(a) Always  (o) Once  (r) Reject
```

The user must blindly accept or reject without seeing what changes will be made. The diff only appears **after** the tool completes — too late.

## Root Cause

The permission gate (`askPermission()`) fires **before** `def.execute()`. The edit tool computes the diff **inside** `execute()` after reading and modifying the file. So at permission-check time, the diff does not exist.

## Solution

Compute a preview diff in `toAITool.execute()` **before** `askPermission()`, using a read-only file read and the existing `generateUnifiedDiff()` utility. Pass it through `PendingRequest.metadata` to the permission prompt.

## Architecture

```
Model calls edit(filePath, oldString, newString)
  │
  ▼
toAITool.execute(args)
  │
  ├─ fs.readFileSync(filePath) → before    ← read-only, no side effect
  ├─ after = before.replace(oldString, newString)
  ├─ generateUnifiedDiff(before, after, filePath) → diff
  │
  ├─ askPermission({ metadata: { diff, filePath, oldString, newString } })
  │     │
  │     ▼
  │   permission.ask() → emits "permission-request" with diff in input
  │     │
  │     ▼
  │   PermissionPrompt renders:
  │     ▲ Allow Edit?  ~/file.ts
  │     (a) Always  (o) Once  (r) Reject
  │     ──────────────────────────────────
  │      context line before change
  │     - old line of code
  │     + new line of code
  │      context line after change
  │
  │   User presses (o) → respond("once")
  │     │
  │     ▼
  │   permission.respond() → req.resolve()
  │
  ├─ (permission resolved, gate passes)
  ├─ bus.emit("tool-running", ...)
  ├─ def.execute(args, ctx) → reads file, applies replace, WRITES file
  └─ returns { metadata: { diff } }
```

## Files Changed

### 1. `src/session/prompt.ts`

**Add imports** at the top:
```ts
import { generateUnifiedDiff } from "../tui/diff-utils"
import * as fs from "fs"
```

**In `toAITool.execute()`** (around line 642), before `askPermission()`:

```ts
// Compute preview diff for file-modifying tools (read-only)
let previewDiff: string | undefined
let previewFilePath: string | undefined
let previewOldString: string | undefined
let previewNewString: string | undefined

try {
  if (def.id === "edit" || def.id === "write") {
    const filePath = args.path ?? args.filePath ?? ""
    if (filePath) {
      previewFilePath = filePath
      const before = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf-8")
        : ""

      if (def.id === "edit") {
        const oldStr = args.old ?? args.oldString ?? ""
        const newStr = args.new ?? args.newString ?? ""
        previewOldString = oldStr
        previewNewString = newStr
        if (oldStr && before) {
          const after = before.replace(oldStr, newStr)
          if (after !== before) {
            previewDiff = generateUnifiedDiff(before, after, filePath)
          }
        }
      } else if (def.id === "write") {
        const content = args.content ?? ""
        if (before || content) {
          previewDiff = generateUnifiedDiff(before, content, filePath)
        }
      }
    }
  }
} catch {
  // Diff computation failed — proceed without preview
}

await askPermission({
  sessionId,
  tool: def.id,
  pattern: previewFilePath ?? "*",
  ruleset,
  metadata: {
    diff: previewDiff,
    filePath: previewFilePath,
    oldString: previewOldString,
    newString: previewNewString,
  },
});
```

**Key change to `pattern`**: Pass the actual file path instead of `"*"`. This makes permission rules like `{ tool: "edit", pattern: "*.ts", action: "allow" }` work correctly.

### 2. `src/tui/components/permission-prompt.tsx`

**Add imports**:
```ts
import { parseDiffHunks } from "../diff-utils"
import type { DiffHunk, DiffLine } from "../diff-utils"
```

**Add diff rendering section** after the existing button hints row:

```tsx
const diff = () => props.request.input.diff as string | undefined
const oldString = () => props.request.input.oldString as string | undefined
const newString = () => props.request.input.newString as string | undefined
const hunks = () => (diff() ? parseDiffHunks(diff()!) : [])
const hasDiff = () => hunks().length > 0

// Inside the return JSX, after the button hints row:

<Show when={hasDiff()}>
  <box marginTop={1} marginLeft={2}>
    <box flexDirection="column">
      <For each={hunks().slice(0, 3)}>
        {(hunk) => (
          <box flexDirection="column">
            <For each={hunk.lines.slice(0, 12)}>
              {(line) => (
                <box flexDirection="row">
                  <text fg={colors.muted}>
                    {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                  </text>
                  <text fg={
                    line.type === "added" ? colors.diffAdded
                      : line.type === "removed" ? colors.diffRemoved
                      : colors.textDim
                  }>
                    {line.content.slice(0, 100)}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  </box>
</Show>

<Show when={!hasDiff() && oldString() && newString()}>
  <box marginTop={1} marginLeft={2}>
    <text fg={colors.diffRemoved}>- {oldString()!.slice(0, 100)}</text>
    <text fg={colors.diffAdded}>+ {newString()!.slice(0, 100)}</text>
  </box>
</Show>
```

### 3. No other files changed

- `src/permission/permission.ts`: No changes. `PendingRequest.metadata` is already `Record<string, any>`, and `bus.emit` already spreads metadata into the event: `input: { pattern: input.pattern, ...input.metadata }`.
- `src/session/events.ts`: No changes. `permission-request.input` is already `Record<string, unknown>`.
- `src/tui/events.ts`: No changes. Already passes `data.input` through.
- `src/tui/state.ts`: No changes. `PermissionRequest.input` is already `Record<string, unknown>`.
- `src/tool/tool.ts`: No changes. `ToolDef` contract unchanged.

## Tool Handling

| Tool | Strategy |
|------|----------|
| **edit** | Read file → `before.replace(oldString, newString)` → `generateUnifiedDiff(before, after, path)`. Fallback: show raw `- old / + new` inline. |
| **write** | Read existing file (if any) → `generateUnifiedDiff(existing, content, path)`. New files show all lines as additions. |
| **bash** | No diff preview — cannot predict shell command effects. |
| **read, grep, glob, etc.** | No diff preview — read-only tools. |

## Trade-offs Accepted

- **Approximate diff for non-exact matches**: The simple `String.replace()` won't capture line-trimmed or block-anchor matches from the real edit tool. The fallback shows raw old/new strings — still better than nothing.
- **Synchronous file read**: Uses `readFileSync` — negligible for text files (sub-millisecond). Can switch to `await readFile()` later if needed.
- **Read-only side effect before gate**: The file is read (not written) before permission is granted. This is safe — the permission gate exists to block writes, not reads.

## Risks and Guardrails

| Risk | Mitigation |
|------|-----------|
| File read fails (permissions, deleted) | Wrapped in try/catch — falls back gracefully |
| Large files cause slow reads | `generateUnifiedDiff` limits context to 3 lines. Add >1MB size guard if needed |
| Permission prompt layout breaks with vertical diff | Limit to 3 hunks × 12 lines = 36 lines max |
| `write` tool with existing file shows full replacement | Acceptable — user sees exactly what will be written |

## Future: ToolDef.preview()

Revisit when a third file-modifying tool needs custom diff logic:

```ts
export interface ToolDef<T extends z.ZodType = z.ZodType> {
  // ... existing fields ...
  preview?(args: z.infer<T>): Promise<{ diff?: string }>
}
```

The wrapper would call `def.preview?.(args)` first, falling back to the heuristic.

## Acceptance Criteria

1. Permission prompt for edit shows unified diff preview when `action: "ask"`
2. Permission prompt for write shows diff preview (or full content for new files)
3. Tools without diff preview (bash, read, etc.) work unchanged
4. Diff computation failures do not block permission — prompt still appears
5. Permission pattern in rules uses actual file path (enables `*.ts` rules)
6. TypeScript typecheck clean
7. TUI renders without layout breaking
