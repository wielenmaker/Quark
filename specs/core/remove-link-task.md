---
title: Remove linkTask — make taskId immutable
date_created: 2026-05-16
date_modified: 2026-05-16
revision: 1
history:
  - 2026-05-16: Initial draft
status: in-progress
---

## Problem

`/steer` creates a new task instead of attaching the child branch to the
parent's task. Root cause: after `createBranch` correctly links the child to
the parent's `taskId`, the child's first agent turn runs `initializeSession`
→ `linkTask`, which unconditionally calls `createTask` and **overwrites** the
child's `taskId`. The frontend then renders two tasks for what should be one
tree.

Adjacent issues:
1. `findTaskByDescription` dedup is a string-match on an LLM-generated
   sentence — almost never hits in practice.
2. `prompt.ts` calls the initializer asynchronously, leaving a race window
   where `taskId` may not be set when the user fires `/steer`.
3. `branch.ts#ensureTask` exists only to cover that race window.

## Architecture

Replace "find-or-create + bind in one call" with **synchronous bind on
session start + asynchronous title-only upgrade**. After the change, every
session has a `taskId` the moment its first user message is saved, and
`taskId` is never rewritten thereafter.

### Key decisions

| Decision | Rationale |
|---|---|
| Drop `findTaskByDescription` dedup | Brittle string match on LLM output; rarely fires; surprising when it does. Future: explicit `/task attach <id>` if needed. |
| Sync `initializeSessionFromMessage` first | Guarantees `taskId` before any branch action. Eliminates the race. |
| Async upgrade only touches `title` | Makes `taskId` immutable post-creation — defends against future regressions. |
| Delete `ensureTask` in `branch.ts` | No longer needed; throw if parent has no taskId (invariant violation). |

## Implementation

1. **`src/session/initializer.ts`** — delete `linkTask`. Replace
   `initializeSession` with `upgradeSessionTitle` (title-only, no taskId
   writes). Make `initializeSessionFromMessage` idempotent and authoritative
   for taskId creation.
2. **`src/session/prompt.ts`** — gate on `!session.taskId`; run sync
   initializer first, then async title upgrade.
3. **`src/session/branch.ts`** — delete `ensureTask`. Throw if parent
   missing `taskId`.
4. **`src/task/task.ts`** — delete `findTaskByDescription` and its export
   in `src/index.ts`.
5. **Tests** — update initializer + task tests; add a branch regression
   test asserting child `taskId` is not mutated after creation.

## Acceptance criteria

- [ ] All unit tests pass (`bun test`).
- [ ] Type check + lint pass.
- [ ] Manual TUI E2E:
  - [ ] First message → task created synchronously, visible immediately.
  - [ ] `/steer <goal>` → child appears **under the same task**, not as a
        new task.
  - [ ] Second `/steer` → sibling appears under the same task.
- [ ] No call sites of `linkTask` or `findTaskByDescription` remain.
