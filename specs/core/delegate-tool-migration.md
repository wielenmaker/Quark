---
title: Delegate Tool — Migrate Sub-Agent Spawning from Bash to a First-Class Tool
date_created: 2026-06-02
date_modified: 2026-06-02
revision: 1
history:
  - 2026-06-02: Initial draft
status: draft
---

# Delegate Tool — Sub-Agent Migration

## 1. Problem

Sub-agents in Quark today are spawned by the model issuing a bash command:

```
bash("quark --sub-agent --no-store --profile finder --prompt '…'")
```

The bash tool plugin in `~/.config/quark/tools/bash.ts` regex-sniffs the command,
re-spawns it with `QUARK_EMIT_EVENTS=1`, parses `QUARK_EVENT:` NDJSON off stderr,
and re-emits each event on the parent's bus as `subagent-*` for the TUI to render.

This works, but it fails on four UX axes:

1. **Mental model leak.** Worker profiles (`finder`, `oracle`, `test-engineer`)
   appear in `/model` and `/profile` pickers alongside primary identities
   (`coder`, `research`). Users mentally re-classify the list every time.
2. **Magic incantation, not a verb.** The model must remember `--sub-agent
   --no-store --profile <id> --prompt '…'`. `AGENTS.md` has a hand-written rule
   reminding the model to pass `--no-store` — abstraction leak made visible.
3. **Two parallel event pipelines.** Tools emit `tool-*`; sub-agents emit
   `subagent-*` via stderr NDJSON parsed by a plugin regex. Same concept,
   two vocabularies, two TUI renderers, two permission paths.
4. **A CLI flag no human uses.** `quark --sub-agent` exists only because bash
   is the spawn mechanism — a private RPC dressed as a public CLI.

The single observation that unlocks the fix: **sub-agents are single-turn
request → result**, exactly the shape of a tool call. The session-spawn shape
buys nothing the tool shape doesn't.

## 2. Vision

**Two config tiers, one invocation verb.**

- `agents:` — user-facing identities; appear in `/model`, `/profile`, session picker.
- `delegates:` — invisible to pickers; callable only via the `delegate` tool.
- The model calls `delegate({ agent: "finder", prompt: "…" })`. No bash, no flags.
- The TUI renders a delegate tool call exactly the way it renders a sub-agent
  bash card today, minus the command-line regex and stderr-NDJSON plumbing.
- A `delegate_external` escape hatch preserves the Unix-composable virtue of
  the current design (spawn `claude`, `aider`, arbitrary commands) without
  leaking it into the default UX.

## 3. Architecture

### 3.1 Config schema

```yaml
main_model: copilot/claude-sonnet-4.6

agents:                           # user-selectable identities
  coder:
    prompt_file: profiles/coder.md
    tools: [read, write, edit, bash, skill]
    skills: [code-review, git-release]
    delegates: [finder, oracle, test-engineer]
  research:
    prompt_file: profiles/research.md
    tools: [websearch, webfetch, read, write]
    delegates: [finder]

delegates:                        # tool-only worker agents
  finder:
    prompt_file: delegates/finder.md
    tools: [read, grep, glob]
    # model: optional override
  oracle:
    prompt_file: delegates/oracle.md
    tools: [read, grep]
    model: openai/gpt-5
  test-engineer:
    prompt_file: delegates/test-engineer.md
    tools: [read, write, bash]

external_delegates:               # optional escape hatch (Phase 4)
  claude:
    exec: ["claude", "--print", "{prompt}"]
```

Notes:
- `profiles:` is renamed to `agents:` to match the user's vocabulary.
- `delegates:` is a sibling key — same shape as `agents:` but never shown in pickers.
- `agents[*].delegates: [id…]` lists which delegates a given agent may invoke
  (analogous to today's `sub_agents:`). Empty/missing → agent cannot delegate.

Backwards compatibility: if `agents:` is absent and `profiles:` is present, load
`profiles:` as `agents:` and emit a one-line migration notice on startup.
A `sub_agents:` key on an entry maps to `delegates:` for the same entry.
Removal of the legacy keys: Phase 6.

### 3.2 The `delegate` tool

Built-in tool, registered like `read`/`skill`. Signature:

```ts
delegate({
  agent: string,                  // must be in caller's allowed delegates list
  prompt: string,                 // the task to perform
}): {
  output: string,                 // final assistant text from the delegate
  metadata: { agent, model, tokens, durationMs, sessionId }
}
```

Execution path (in-process, no subprocess):

1. Validate `agent` is in the caller `AgentConfig.delegates`. If not → tool error
   `"Agent 'X' is not a registered delegate for this agent."`
2. Resolve the delegate definition from `loadProfileConfig().delegates`.
3. Read its prompt file, build an `AgentConfig` via a new
   `agentFromDelegate(def, promptContent)`.
4. Create an **ephemeral** child session with `parentSessionId = ctx.sessionId`
   and `kind: "subagent"`. Reuses today's session model unchanged.
5. Run `prompt({ agent: childAgent, parts: [{type:"text", text: prompt}],
   ephemeral: true, parentSessionId, parentCallId: ctx.callId })`.
6. The child runs on the **same event bus** as the parent. The bus carries a
   new `parentCallId` field on every event during the delegate run (set via an
   async-local-storage context — see §3.3) so the TUI can attach activity to
   the correct delegate tool call without a separate event namespace.
7. On loop-end, collect the final assistant text, return as `output`.
8. Abort: `ctx.abort` propagates to the child loop's abort signal.

The delegate tool replaces, not supplements, the `quark --sub-agent` mechanism
for the default UX. The CLI flag remains in Phase 1–4 for compatibility and is
removed in Phase 6.

### 3.3 Single event pipeline

Today: `subagent-tool-*` are a parallel set of bus events. Migration:

- **Remove** the entire `subagent-*` event family from `src/session/events.ts`.
- **Add** an optional `parentCallId?: string` field to existing `tool-*`,
  `text-*`, `step-finish`, `loop-end` events.
- Inside the delegate tool's `execute()`, run the child loop within an
  `AsyncLocalStorage` context that stamps every emitted event with the
  delegate's `parentCallId`. The bus emit wrapper reads from ALS and merges
  the field automatically.
- TUI groups events by `parentCallId`: top-level events render in the main
  transcript; events with a `parentCallId` render nested under that tool part.

Net effect: tool rendering and delegate rendering share one code path. The
`sub-agent-view.tsx` component becomes "nested-tool-view.tsx" with no behavior
change visible to users.

### 3.4 Bash tool — remove the special case

In `~/.config/quark/tools/bash.ts`:
- Delete `isSubAgentCommand`, `executeSubAgent`, `forwardEvent`,
  `stripStderrRedirect`, the EVENT_PREFIX parsing, and the bus import.
- Bash is once again a plain command runner. ~200 lines removed.

In `src/session/event-writer.ts`: delete entirely.

In `src/cli.ts`: remove `--sub-agent`, `--parent-session` flag handling and
the `QUARK_EMIT_EVENTS` plumbing.

### 3.5 System prompt

`buildSubAgentBlock` in `src/session/system.ts` becomes `buildDelegateBlock`:

```
# Available Delegates

You can delegate tasks to specialized agents using the `delegate` tool:

- **finder** — Locates code by behavior or concept across the repo.
- **oracle** — Deep engineering judgment on architecture and tricky bugs.
- **test-engineer** — Writes failing tests before implementation (TDD).

Use `delegate({ agent: "<id>", prompt: "<task>" })`. The delegate runs in
isolation and returns its final answer as a single string.
```

The block is only emitted when `agent.delegates` is non-empty AND the
`delegate` tool is registered.

### 3.6 Permissions

`delegate` is a tool. Existing permission rules apply uniformly:

```yaml
agents:
  coder:
    permissions:
      - { tool: delegate, action: allow }
      - { tool: bash,     action: ask }
```

Future: argument-level permissions (`{ tool: delegate, pattern: "agent=oracle",
action: ask }`) ride the same `pattern` field roadmap already noted in
`src/agent.ts` TODO.

### 3.7 Pickers

- `/model` and `/profile` enumerate `agents:` only. `delegates:` is invisible.
- `listProfiles()` becomes `listAgents()`. A separate `listDelegates()` exists
  for `/delegates` (read-only inspection command, low priority).
- Session picker shows only sessions with `kind !== "subagent"` (already true).

### 3.8 External delegates (Phase 4, optional)

`external_delegates:` entries are callable via a second tool,
`delegate_external({ name, prompt })`. It spawns the configured `exec` template
with `{prompt}` substituted, captures stdout, returns it as tool output. No
event forwarding — external processes are opaque, rendered as a single
"running…" → "done" tool card with stdout as output. This preserves
composability without bringing back the stderr-NDJSON protocol.

## 4. Key Decisions & Rationale

| Decision | Why |
|---|---|
| In-process child loop, not subprocess | Sub-agents are single-turn; subprocess isolation buys nothing once we accept that. Removes ~400 lines of IPC plumbing. Context isolation comes from a fresh `AgentConfig`, not a fresh process. |
| Rename `profiles:` → `agents:` | The word "profile" doesn't match user vocabulary. `/model` should select an "agent". |
| New top-level `delegates:` key | Forces the user-facing/worker split to be visible in the file. The data model now matches the mental model. |
| `parentCallId` on existing events, not a parallel event family | One event vocabulary. TUI renders delegates as nested tool calls — same primitive, deeper nesting. |
| Keep `kind: "subagent"` on the session record | Audit trail unchanged. Storage layer is stable. |
| Ephemeral by default, no opt-out | Delegate runs are tool results, not conversations. No reason to persist; removes the `--no-store` rule from `AGENTS.md`. |
| Escape hatch via `external_delegates:`, not by keeping bash spawning | Preserves Unix composability for power users without leaking it into the default UX or the system prompt. |
| Drop `--sub-agent` CLI flag in Phase 6 | The flag exists only to serve the bash spawn path. Once that path is gone, the flag is dead code. |

## 5. Migration Plan

### Phase 1 — Config schema (non-breaking)
- Add `agents:` and `delegates:` parsing alongside legacy `profiles:` /
  `sub_agents:`. Legacy keys still work; new keys take precedence.
- `listAgents()` returns `agents:` if present, else `profiles:`.
- No behavior change. New tests cover both shapes.

### Phase 2 — Delegate tool (parallel path)
- Implement `src/tool/delegate.ts` (in-process child loop via `prompt()`).
- Add `AsyncLocalStorage` `parentCallId` stamping in the bus emit wrapper.
- Add `parentCallId?: string` to relevant `BusEvents`.
- TUI: render tool calls with `parentCallId` nested under their parent.
- Both paths (bash spawn AND delegate tool) work. Users can opt in by
  configuring `delegates:` and adding `delegate` to `tools:`.

### Phase 3 — TUI unification
- Sub-agent view component refactored to a generic nested-tool view, driven
  entirely by `parentCallId` grouping.
- `subagent-*` bus events still emitted by the bash plugin for the legacy
  path; TUI handlers translate them to nested tool events. Both display
  identically.

### Phase 4 — External delegates (optional, can be deferred)
- Implement `external_delegates:` config + `delegate_external` tool.
- Documented as the migration path for any user spawning non-quark agents
  via the old bash trick.

### Phase 5 — Migrate built-in profiles & docs
- Convert `~/.config/quark/config.yaml` to the new shape (the user does this,
  spec ships a `scripts/migrate-config.ts` one-shot).
- Update `~/.config/quark/profiles/coder.md` and `AGENTS.md`: remove the
  `<using_subagents>` block teaching the bash incantation; replace with a
  short note on the `delegate` tool. Drop the `--no-store` reminder.
- Update `../tui/sub-agent-tui-redesign.md` to point at this spec for the
  successor design.

### Phase 6 — Remove the legacy path
- Delete `src/session/event-writer.ts`.
- Delete `subagent-*` events from `src/session/events.ts`.
- Delete `--sub-agent`, `--parent-session`, and `QUARK_EMIT_EVENTS` from
  `src/cli.ts`.
- Delete `executeSubAgent` / `forwardEvent` / `isSubAgentCommand` from the
  bash tool plugin.
- Delete legacy `profiles:` / `sub_agents:` config parsing (or keep for
  one more release with a deprecation warning).
- Drop `buildSubAgentBlock` (replaced by `buildDelegateBlock` in Phase 2).

Phases 1–4 can land in a single release as additive changes. Phase 5 is the
user-action release. Phase 6 is the cleanup release one cycle later.

## 6. Acceptance Criteria

- [ ] `/model` and `/profile` show only entries from `agents:`; `delegates:`
      never appear.
- [ ] A `coder` agent with `delegates: [finder]` and `tools: [..., delegate]`
      can invoke `delegate({ agent: "finder", prompt: "…" })` and receive
      the finder's final assistant text as the tool output.
- [ ] An agent without `finder` in its `delegates:` list receives a tool
      error if it tries to call `delegate({ agent: "finder", … })`.
- [ ] The TUI renders a delegate call as a nested tool tree under the
      parent tool part, with token usage and streaming text preview.
      Visual parity (or better) with today's sub-agent view.
- [ ] No `QUARK_EVENT:` strings exist in source after Phase 6.
- [ ] No `--sub-agent` flag accepted by the CLI after Phase 6.
- [ ] `bash.ts` plugin in `~/.config/quark/tools/` has no quark-specific
      branching after Phase 6.
- [ ] Manual end-to-end test through the TUI: launch `coder`, ask a
      question that triggers a `finder` delegate, observe nested rendering,
      verify the parent receives the finder's response and proceeds.
- [ ] Migration script converts a v1 `config.yaml` (`profiles:` +
      `sub_agents:`) to v2 (`agents:` + `delegates:`) and the result loads
      cleanly with no warnings.

## 7. Out of Scope

- Multi-turn conversations with a delegate. If ever needed, introduce a
  separate `start_delegate_session` / `continue_delegate_session` pair.
  The single-turn `delegate` tool stays.
- Parallel/concurrent delegates from a single tool call. The model can
  issue multiple `delegate` calls in the same assistant turn via standard
  parallel tool calling — no special API needed.
- Cross-process delegates beyond `external_delegates:` (no spawning another
  `quark` to act as a delegate; in-process is always faster and simpler).
- ACP integration changes. ACP entry is orthogonal.

## 8. Risks

- **Loss of process isolation for delegates.** A buggy delegate tool implementation
  could leak listeners or state into the parent bus. Mitigation: ALS context
  is unset on tool-end in a `finally`; integration test asserts no orphan
  listeners after 100 delegate calls.
- **TUI regression during the nested-tool refactor.** Mitigation: keep both
  rendering paths alive through Phase 4 and switch via feature flag; remove
  old path only after a full release cycle of dogfooding.
- **User config breakage.** Mitigation: Phase 1 keeps legacy keys working;
  migration script is shipped before Phase 6.
