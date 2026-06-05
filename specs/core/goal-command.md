---
title: /goal Command — Autonomous Goal-Driven Agent Loop
date_created: 2026-05-14
date_modified: 2026-05-14
revision: 1
history:
  - 2026-05-14: Initial draft — brainstorm + architecture decisions
status: draft
---

# /goal Command — Autonomous Goal-Driven Agent Loop

## 1. Problem

Single-turn `prompt()` calls are bounded — the agent works, then stops. Complex
goals (refactors, migrations, feature implementations) span many turns. Today the
human must manually feed each next step.

The Ralph Wiggum pattern solves this with a `while` loop that feeds a plan file
to a fresh agent process each iteration. Quark should embed this pattern natively
as a `/goal` command that:

1. Generates a plan of atomic, verifiable tasks
2. Executes them one-by-one with fresh context per task
3. Verifies each task deterministically (test command, file check)
4. Tracks progress in an append-only file on disk
5. Enters "explore mode" if the plan is exhausted but the goal isn't met

## 2. Architecture

```
╭──────────────────────────────────────────────────────────────────────────╮
│                    /goal orchestrator (outer loop)                       │
│                                                                         │
│  PLAN → JUDGE_ATOMICITY → TASK_LOOP → FINAL_JUDGE → EXPLORE | DONE     │
│    │                         │                                          │
│    │                         ▼                                          │
│    │              prompt({ agent, task })  ← fresh context per task     │
│    │                         │                                          │
│    │                         ▼                                          │
│    │                   runCheck(cmd)  ← deterministic verification      │
│    │                         │                                          │
│    │                    edit progress.md                                 │
│                                                                         │
╰──────────────────────────────────────────────────────────────────────────╯
```

The orchestrator is a module inside Quark that calls `prompt()` programmatically —
the same function the TUI and CLI use. No shelling out to the `quark` binary.

### 2.1 Why not a bash loop?

- **Debuggability**: bash can't introspect sub-agent failures, parse verification
  output, or attach debug traces.
- **Permission override**: the orchestrator needs to pre-seed `sessionApproved`
  for auto-approve mode — this is internal Quark state.
- **Judge calls**: sub-agent spawn for judge uses `prompt()` with the oracle
  profile — same programmatic path, no CLI overhead.

### 2.2 State Machine

```
GOAL_RECEIVED
  │
  ▼
PLAN_GENERATE ───→ progress.md written
  │
  ▼
JUDGE_ATOMICITY ───→ PASS → continue
  │                  FAIL → back to PLAN_GENERATE
  ▼
TASK_LOOP (for each `- [ ]` in Plan section):
  │
  ├── prompt(agent, task) → agent works
  ├── runCheck(task.check_command) → PASS | FAIL
  └── edit progress.md: mark [x] or FAIL
  │
  ▼
FINAL_JUDGE: "Is the goal achieved?"
  │
  ├── YES → DONE
  └── NO → EXPLORE (budget N)
              │
              ├── prompt(agent, "generate one delta task")
              ├── prompt(agent, delta) → runCheck → PASS | FAIL
              ├── PASS → back to FINAL_JUDGE
              ├── FAIL → next iteration (sees prior failures in progress.md)
              └── budget exhausted → REPORT PARTIAL
```

### 2.3 No retry per task

The agent loop (`prompt()` → `loop()`) already retries tool calls internally.
If a task finishes and the deterministic check fails, re-running the identical
task is just a different LLM dice roll. Instead, mark it FAIL and let the final
judge + explore mode handle the gap.

### 2.4 Single session, auto-compaction

All tasks execute in one parent session. If the context window overflows, the
existing auto-branching system (`branch.ts`, `branch-controller.ts`) handles it
transparently — summarizes, creates a child session, continues. No per-task
sub-sessions needed.

## 3. File Format: progress.md

One file serves as plan, progress tracker, and state machine. Located at
`.quark/specs/goals/<slug>/progress.md`.

```markdown
# Goal: Refactor the session module to separate concerns

## Plan
- [x] **task-01**: Extract `Session` interface to `types.ts`
  → AC: `src/session/types.ts` exists, `bun test` passes
  → Check: `bun test src/session/types.test.ts`
- [x] **task-02**: Move JSONL storage to `storage/session-jsonl.ts`
  → AC: imports updated across codebase, `bun test` passes
  → Check: `bun test src/storage/`
- [ ] **task-03**: Add unit tests for session CRUD edge cases
  → AC: coverage > 80% on `session.ts`
  → Check: `bun test --coverage src/session/`

## Explore
- [x] **delta-01**: Add missing `createSession` import → PASS
- [ ] **delta-02**: Fix mock setup for JSONL write → FAIL (no write perms)

## Meta
- Explore budget: 1/5
- Last action: 2026-05-14 15:42 UTC — task-02 passed, moving to task-03
- Judge: plan atomicity APPROVED | goal check #1: NO
```

**Rules:**
- The orchestrator is the sole writer. The agent never touches this file.
- Only final states exist: `[x]` (PASS) or `FAIL` appended. No "in-progress."
- On crash/resume, the first `- [ ]` is the next task.
- The `## Meta` section is machine-written — the orchestrator appends, the agent ignores it.

## 4. Schemas

### 4.2 Task

```typescript
interface Task {
  task_type: "planned" | "delta"
  id: string
  title: string
  objective: string            // prompt for the agent
  acceptance_criteria: string[] // what the judge verifies
  check_command?: string        // deterministic: exit 0 → PASS
  status: "pending" | "pass" | "fail" //NEED REVIEW
  fail_reason?: string
}
```

## 5. Verification

### 5.1 Deterministic (preferred)

A shell command. Exit code 0 → PASS, non-zero → FAIL.

```markdown
→ Check: `bun test src/session/`
→ Check: `tsc --noEmit`
→ Check: `grep -q 'export interface Session' src/session/types.ts`
```

### 5.2 Non-deterministic (LLM judge)

For subjective checks (tone, UX, architecture quality). Spawned via `prompt()`
with the oracle profile and a cheap model.

```typescript
const result = await prompt({
  agent: oracleAgent,
  parts: [{
    type: "text",
    text: `Goal: ${goal.user_goal}\n\nProgress so far:\n${plan.fullText()}\n\n` +
          `Does this satisfy the acceptance criteria?\n${task.ac.join("\n")}\n\n` +
          `Answer YES or NO only.`
  }]
})
```

The judge is used for:
1. **Plan atomicity review** — "Are these tasks atomic and independently verifiable?"
2. **Final goal check** — "Is the goal achieved?"
3. **Delta task quality** — (implicit, via pass/fail of the delta)

## 6. Permission: Auto-Approve Mode

The orchestrator pre-seeds `sessionApproved` with an allow-all rule so the agent
never pauses for permission prompts:

```typescript
import { sessionApproved } from "../permission/permission" // need to export
sessionApproved.set(sessionId, [
  { tool: "*", pattern: "*", action: "allow" }
])
```

This requires exporting the `sessionApproved` Map from the permission module
(currently module-private).

## 7. TUI Integration

When `/goal` is invoked from the TUI:

1. The footer shows: "Quark is achieving: refactor session module — task 3/7 ⠋"
2. Messages stream normally — the user sees the agent working
3. `Ctrl+C` interrupts → state preserved in `progress.md`
4. `/goal resume` picks up where it left off
5. A `goalStatus` entry is added to the TUI state store to show progress

The command is added to `src/tui/commands.ts`:
```typescript
{ id: "goal", description: "Pursue a goal autonomously", usage: "<goal description>" }
```

## 8. Debug Traces

When `--verbose` is set (or `QUARK_DEBUG=goal`), each step writes to
`.quark/specs/goals/<slug>/debug/`:

```
debug/
  001-plan-generation.txt       ← raw LLM output for plan
  002-atomicity-review.txt      ← judge's atomicity review
  003-task-01-execution.txt     ← raw agent output for task 1
  003-task-01-verify.txt        ← verification command output
  004-task-02-execution.txt
  ...
```

This is write-only — only created when debugging is enabled.

## 9. Configuration

New optional section in `.quark/config.yaml`:

```yaml
goal:
  explore_budget: 5           # max delta iterations (default: 5)
  max_planned_tasks: 20       # safety cap on plan size (default: 20)
  judge_model: "copilot/gpt-5-mini"  # model for judge calls
  planner_profile: "coder"    # profile for plan generation
  executor_profile: "coder"   # profile for task execution
  verbose: false              # write debug traces
```

## 10. File Structure

```
src/
  goal/
    orchestrator.ts   — outer loop: plan → execute → verify → judge → explore
    plan.ts           — parse/edit progress.md, Task/Goal types
    verify.ts         — runCheck(), judgeAtomicity(), judgeGoal()
    types.ts          — Goal, Task, Plan interfaces

.quark/specs/goals/<slug>/
  progress.md         — plan + progress + state (single file)
  debug/              — (only when --verbose)
```

## 11. Acceptance Criteria

- [ ] `/goal "refactor the session module"` generates a plan in `progress.md`
- [ ] Plan is reviewed for atomicity by a judge sub-agent
- [ ] Tasks execute sequentially, one `prompt()` call per task
- [ ] Deterministic checks run after each task; PASS/FAIL recorded in `progress.md`
- [ ] Agent runs in auto-approve mode (no permission prompts)
- [ ] Final judge determines if goal is met
- [ ] If NOT met, explore mode generates delta tasks (within budget)
- [ ] Deltas see prior failures via `progress.md` context
- [ ] `Ctrl+C` during execution preserves state; `/goal resume` resumes
- [ ] TUI footer shows progress during goal execution
- [ ] Debug traces written to `debug/` when verbose enabled
- [ ] Existing agent loop is unchanged — orchestrator composes on top of `prompt()`
