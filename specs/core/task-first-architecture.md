---
title: Task-First Architecture — Replacing Compaction with Session Branching
date_created: 2026-05-07
date_modified: 2026-05-29
revision: 5
history:
  - 2026-05-07: Initial draft
  - 2026-05-08: Started Phase 1 task entity and session initializer implementation
  - 2026-05-08: Added Phase 2 branch creation, lineage context, and auto-branch loop wiring
  - 2026-05-08: Removed steer_session as agent tool; steer is TUI-only (human command)
  - 2026-05-29: Clarified branch compaction strips tool/runtime parts before splitting and preserves recent text context
status: in-progress
---

# Task-First Architecture

## 1. Problem

Compaction is a dead end. It creates orphan sessions, destroys the audit trail, and
pretends the context-window problem doesn't exist by papering over it with an LLM
summary. Every compacted session is a severed link in the chain — old context is
lost, not preserved.

The real problem: **context windows are finite, but tasks are not**. A non-trivial
task will overflow any context window. The solution isn't a smarter summary — it's
a model that accepts sessions as branches on a task, not standalone units.

## 2. Vision

**Task is the first-class citizen. Sessions are branches on a task tree.**

```
Task "Add JWT refresh token rotation"
│
├── Session 1 (root)
│   │  summary: "Built middleware structure, added token types"
│   │  files: [middleware.ts, types.ts]
│   │
│   ├── Session 1.a (child — context overflow)
│   │   │  summary: "Added blacklist check, wrote unit tests"
│   │   │  files: [middleware.ts, middleware.test.ts]
│   │   │  parentSummary: "Session 1's summary — snapshot at branch time"
│   │   │
│   │   └── Session 1.a.1 (child — context overflow)
│   │        summary: "Fixed expired-token edge case"
│   │        parentSummary: "Session 1.a's summary"
│   │
│   └── Session 1.b (child — alternative approach)
│        summary: "Refactored to strategy pattern"
│        parentSummary: "Session 1's summary — same snapshot"
```

Each node stores:
- **`summary`** — what happened *during this session*
- **`parentSummary`** — frozen snapshot of the parent's `summary` at branch time

A `read_session("1.a.1")` call reconstructs the full lineage by walking
`parentSessionId` up the tree. The agent sees a collapsed, chronological summary of
everything that led to the current branch — without replaying any full JSONL logs.

## 3. Key Design Decisions

### 3.1 No more compaction

All compaction code is deleted. There is no "summarize old messages and switch to a
new session." The agent branches, the tree grows, and every session is preserved.

| Removed | Replaced by |
|---------|-------------|
| `src/session/methods/general.ts` | `src/session/branch.ts` |
| `src/session/methods/anchored.ts` | (no replacement — single branch method) |
| `src/session/compaction.ts` | (helpers absorbed into branch.ts) |
| `src/session/compact-resolver.ts` | (no resolver needed — branching is simpler) |
| `src/tool/compact.ts` | `src/tool/steer.ts` |
| Config: `compact.*` | Config: `branching.*` |

### 3.2 Task owns sessions

Task is a standalone entity with its own identity, not a string field on Session.
A session belongs to exactly one task. The task persists across all sessions in
its tree.

### 3.3 Branching, not compacting

When context is exhausted, the agent creates a **child branch** of the current
session. The parent session is finalized (summary persisted), its summary is
frozen, and the child inherits that summary as `parentSummary`.

The branch input is first stripped to text conversation content (`text` and
`summary` parts). Tool calls, tool results, images, step metadata, and reasoning parts
are excluded before splitting. The stripped conversation is split into old
history and the last three messages. Old history is summarized; recent messages
are replayed into the child session without tool/runtime parts.

The child starts with a clean context window containing only:
- Task description
- Lineage summaries (walk up `parentSessionId`)
- The old-history summary
- The stripped recent messages
- The steering prompt, only for explicit `/steer <goal>` branches

### 3.4 Full autonomy

The agent loop detects context pressure and branches automatically (same trigger
as auto-compact today). The agent uses `find_session` and `read_session` as tools
for tree awareness. Session navigation (steering) is a **human command** (`/steer`),
not an agent tool — the agent auto-branches on pressure and reads sibling branches
for context, but never navigates the tree itself.

### 3.5 Task is profile-agnostic

Every profile (coder, researcher, security-reviewer) gets tasks and session trees.
No profile-specific fields — Task is a minimal identifier and description. PM
linking and status tracking are deferred until the harness can populate them
automatically.

## 4. Architecture

```diagram
╭──────────────────────────────────────╮
│            User message              │
╰──────────────┬───────────────────────╯
               │
               ▼
╭──────────────────────────────────────╮
│       SessionInitializer             │
│  (async, fire-and-forget)            │
│  Returns { title, task }             │
│  Creates Task if new                 │
│  Links Session to Task               │
╰──────────────────────────────────────╯
               │
               ▼
╭──────────────────────────────────────╮
│          Agent Loop                  │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ Process messages             │    │
│  │ Tool calls                   │    │
│  │ Context pressure check       │─────── auto-branch → new child session
│  │                              │    │
│  │ Agent tools available:       │    │
│  │  find_session — search tree  │    │
│  │  read_session — load context │    │
│  └──────────────────────────────┘    │
╰──────────────────────────────────────╯
               │
               ▼
╭──────────────────────────────────────╮
│          Task Tree                   │
│  .quark/tasks/<id>.json              │
│  ~/.config/quark/session/<id>/       │
╰──────────────────────────────────────╯
```

## 5. Data Model

### 5.1 Task

```typescript
interface Task {
  id: string                    // nanoid, "task_<random>"
  title: string                 // "Add JWT refresh token rotation"
  description: string           // One-sentence description from SessionInitializer
  profile: string               // Profile used when the task was created (e.g. "coder", "researcher")
  timeCreated: number           // Unix ms
  timeUpdated: number
}
```

### 5.2 Session (updated)

```typescript
interface Session {
  // existing, unchanged
  id: string
  kind: SessionKind             // "main" | "subagent" | "ephemeral"
  directory: string | null

  // existing, semantics changed
  parentSessionId: string | null  // Now properly set on every branch
  title: string | null            // Auto-generated from first message

  // new
  taskId: string                  // Links to parent Task
  summary: string | null          // What happened in THIS session
  parentSummary: string | null    // Frozen snapshot of parent's summary at branch time
  filesModified: string[] | null  // Paths touched during this session
  // existing
  timeCreated: number
  timeUpdated: number
}
```

### 5.3 SessionUpdateEvent (updated)

```typescript
interface SessionUpdateEvent extends EventBase {
  type: "session-update"
  patch: {
    title?: string | null
    summary?: string | null        // NEW
    parentSummary?: string | null  // NEW
    filesModified?: string[] | null // NEW
    timeUpdated?: number
  }
}
```

## 6. Agent Loop Changes

### 6.1 Pre-call context check (replaces compaction)

```typescript
// In prompt.ts — replaces shouldCompact check
if (contextPressureExceeded(usage, ctxWindow, threshold)) {
  const newSession = autoBranch({
    sessionId: currentSessionId,
    messages: currentMessages,
    parts: currentParts,
    model: ctx.model,
  })
  currentSessionId = newSession.id
  // Reload context from new session (task + lineage summaries only)
}
```

### 6.3 Context pressure detection (unchanged from compaction)

Same as `isOverContextThreshold` today — if `inputTokens / contextWindow > threshold`,
trigger a branch. The `branching.threshold` config replaces `compact.threshold`.

## 7. Storage

### 7.1 Tasks

```
.quark/
  tasks/
    index.json          — array of all Task objects (project-scoped)
```

Example `index.json`:

```json
[
  {
    "id": "task_x1y2z3",
    "title": "Add JWT refresh token rotation",
    "description": "Add JWT refresh token rotation support to the authentication middleware",
    "profile": "coder",
    "timeCreated": 1715000000000,
    "timeUpdated": 1715003600000
  }
]
```

One JSON file per project. Small — even 100 tasks is < 50KB. Read on startup,
written atomically on task creation/update.

### 7.2 Sessions (unchanged)

```
~/.config/quark/session/<id>/
  session.jsonl         — append-only event log (unchanged)
  meta.json             — cached session envelope (now includes new fields)
```

The `meta.json` gains: `taskId`, `summary`, `parentSummary`, `filesModified`.
This is what `find_session` reads — no JSONL replay needed for search.

## 8. Tools

### 8.1 `find_session`

```
find_session(query: string, taskId?: string)
  → SessionMatch[]
```

Search within the current task (or a specified task) for sessions matching `query`.
Scores `title + summary + filesModified` against the query. Returns ranked matches
with summary snippets. Uses keyword matching (no embeddings needed — the search
space is a single task's branches).

### 8.2 `read_session`

```
read_session(sessionId: string)
  → string
```

Returns the session's `summary` text. The output is injected into the current
conversation as context — the agent doesn't switch sessions, it just gains
awareness of what happened in that branch.

## 9. SessionInitializer

Replaces `src/session/title.ts`. One async LLM call that returns structured JSON:

```
SessionInitializer prompt:

Analyze the user's first message. Return ONLY valid JSON:

{
  "title": "2-5 word noun phrase describing the topic area",
  "task": "One-sentence description of the development task. If the user is just
           chatting, testing, or asking a general question (not a dev task),
           set this to the same value as title."
}

Examples:
"Hello" → {"title": "Greeting", "task": "Greeting"}
"Add JWT refresh token rotation to the auth middleware" →
  {"title": "Auth Token Rotation", "task": "Add JWT refresh token rotation support to the authentication middleware"}
[...]
```

Validated with Zod:

```typescript
const InitSchema = z.object({
  title: z.string().min(1).max(80),
  task: z.string().min(1).max(200),
})
```

On success:
1. If `task` matches an existing Task (simple string equality), link to it
2. Otherwise, create a new Task with `title = task`
3. Set `session.title` and `session.taskId`

Fires async, does not block the agent loop.

## 10. TUI

### 10.1 Session view (`/session`)

Shows all sessions in the workspace, grouped by task. Each session is displayed
as a horizontal chain showing its lineage from root to current.

```
╭────────────────────────────────────────────────────────────╮
│ › Auth Middleware Refactor                                 │
│   ╰─▶ from Add JWT refresh token rotation · current · 5/4  │
│      ╰─▶ from Workspace Auth Cleanup · root · 5/3          │
│                                                            │
│   Login Bug Fix                                            │
│   ╰─▶ from Fix Login Redirect Loop · root · 5/2            │
╰────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────╮
│ /se                                                        │
╰────────────────────────────────────────────────────────────╯
```

- **`· current ·`** marks the active session
- **`· root ·`** marks the original session in the task
- **`╰─▶ from`** shows the parent relationship — the session was branched from its parent
- Each chain reads left to right: leaf session → its parent → grandparent → root
- Sessions are grouped under their task (the root session's title)
- The `›` prefix highlights the current task

### 10.3 `/steer` command

```
/steer add tests for the auth middleware
```

Creates a new child branch of the current session with the given text as the
first user message, then switches to it. The current session is summarized (LLM),
the summary is frozen as `parentSummary` on the child, and the child starts with
a clean context window containing the task description + lineage summaries +
the steer text.

No separate `/branch` command. No `reason` parameter — the text IS the reason.

Existing sessions are navigated with `/sessions <id-prefix>`, not `/steer`.

### 10.4 Status bar

When on a task: `Task: Add JWT refresh token rotation | Session 1.a`
When on no task: `Session sess_abc`

### 10.5 Tool call rendering

`find_session` and `read_session` render as normal tool calls. No special TUI.
Their output text is the formatted context block.

## 11. Config Changes

```yaml
# .quark/config.yaml — removed compact section, added branching
branching:
  auto: true            # auto-branch on context pressure (was compact.auto)
  threshold: 0.90       # fraction of context window — branch when 90% full
```

`compact.method`, `compact.retain_turns` are removed.

## 12. Files to Delete

| File | Reason |
|------|--------|
| `src/session/methods/general.ts` | Replaced by `branch.ts` |
| `src/session/methods/anchored.ts` | Replaced by `branch.ts` |
| `src/session/compaction.ts` | Replaced by `branch.ts` |
| `src/session/compact-resolver.ts` | No resolver needed |
| `src/tool/compact.ts` | (no replacement — compact is gone) |
| `test/session/methods/general.test.ts` | Tests for deleted code |
| `test/session/methods/anchored.test.ts` | Tests for deleted code |
| `test/session/compaction.test.ts` | Tests for deleted code |
| `test/session/compact-resolver.test.ts` | Tests for deleted code |
| `test/session/multimodal-tool-result.test.ts` (compaction portions) | Tests for deleted code |

## 13. Files to Create

| File | Purpose |
|------|---------|
| `src/task/task.ts` | Task CRUD (create, get, list, update) |
| `src/session/branch.ts` | Branch creation logic (replaces compaction) |
| `src/session/initializer.ts` | SessionInitializer — title + task generation |
| `src/tool/steer.ts` | REMOVED — steer is a TUI command, not an agent tool |
| `src/tool/find_session.ts` | `find_session` tool |
| `src/tool/read_session.ts` | `read_session` tool |
| `task-first-architecture.md` | This spec |

## 14. Files to Modify

| File | Change |
|------|--------|
| `src/config/config.ts` | Replace `compact` with `branching` section |
| `src/session/session.ts` | Add `taskId`, `summary`, `parentSummary`, `filesModified` |
| `src/session/prompt.ts` | Replace compaction calls with branching |
| `src/session/processor.ts` | Replace `"compact"` return with `"branch"` |
| `src/storage/session-format.ts` | Add new fields to `SessionUpdateEvent.patch` |
| `src/storage/session-jsonl.ts` | Handle new fields in `replayEvents` |
| `src/tui/index.tsx` | Task tree in `/session`, new commands (`/steer`, `/task`) |
| `src/tui/components/App.tsx` | Task-aware session picker, `/session` view, `PickerItem` with task |
| `src/tui/state.ts` | Task-related state fields |
| `src/bootstrap.ts` | Register `findSession`/`readSession` tools, remove compact tool + method registration, do NOT register steer |

## 15. Implementation Phases

### Phase 1: Task entity + SessionInitializer
- Create `src/task/task.ts` — Task CRUD
- Create `src/session/initializer.ts` — replaces `title.ts`
- Add `taskId`, `summary`, `parentSummary`, `filesModified` to Session
- Update storage layer to persist new fields
- TUI: show task in session picker

**Tests:** Task CRUD, SessionInitializer prompt + Zod validation, meta.json
round-trip with new fields.

### Phase 2: Branching (replaces compaction)
- Create `src/session/branch.ts` — branch creation logic
- Modify agent loop to branch instead of compact
- Wire auto-branch on context pressure

**Tests:** Branch creation, parentSummary snapshot, lineage walking, auto-branch
trigger.

### Phase 3: Agent context tools
- Create `src/tool/find_session.ts`
- Create `src/tool/read_session.ts`

**Tests:** find_session returns ranked matches within task scope,
read_session returns the session summary.


### Phase 4: Delete compaction code
- Delete all files listed in §12
- Update config, bootstrap, imports
- Run full test suite
- Remove `compact` from built-in tools list
**Tests:** End-to-end: start task → branch → read sibling.
**Tests:** Verify no imports of deleted modules remain. All existing tests pass
(accounting for deleted test files).

## 16. Acceptance Criteria

1. **Task is first-class.** Creating a session without a task creates a Task
   automatically. The task appears in `/session` and persists across restarts.
2. **Branching works.** When context pressure is detected, a child session is
   created. The parent's summary is frozen. The child inherits lineage.
3. **Steering works.** The user can `/steer <goal>` to create a child branch and
   switch to it. The parent's summary is frozen, the child inherits lineage.
4. **Search works.** `find_session` within a task returns relevant sessions.
   `read_session` returns the session summary.
5. **No compaction code remains.** All files in §12 are deleted. The compact
   tool is unregistered. Config has no `compact` section.
6. **TUI shows tree.** `/session` groups by task and shows branching structure.
   The dropdown picker shows task for each session.
7. **Existing tests pass.** All non-compaction tests pass without modification.
   New tests cover all new modules.
8. **Agent can complete a multi-branch task.** End-to-end: a task that requires
   3+ branches completes with the agent auto-branching and reading sibling
   context autonomously.
