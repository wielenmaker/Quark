---
title: Delegate Tool Migration
date_created: 2026-06-02
date_modified: 2026-06-07
revision: 2
history:
  - 2026-06-02: Initial draft
  - 2026-06-07: Reworked against current runtime, session, tool, event, TUI, web, and test boundaries
status: draft
---

# Delegate Tool Migration

## 1. Goal

Replace the private bash-based sub-agent protocol with a first-class,
single-turn `delegate` tool.

```text
Current

parent model
  -> bash("quark --sub-agent ...")
  -> child process
  -> QUARK_EVENT NDJSON on stderr
  -> bash plugin parses and re-emits subagent-* events
  -> parent receives stdout as the tool result

Target

parent model
  -> delegate({ agent, prompt })
  -> in-process child agent loop
  -> standard routed bus events
  -> final assistant text as the tool result
```

The migration must preserve strict agent identity:

- User-facing agents appear in profile pickers.
- Delegates are callable workers and never appear in profile pickers.
- A caller can invoke only its explicitly declared delegates.
- A delegate receives only its own tools, skills, model, prompt, and
  permissions.

## 2. Scope

This specification covers:

- The logical `agents` and `delegates` catalog.
- The built-in `delegate` tool.
- In-process child-loop execution and cancellation.
- Agent-scoped tool and skill resolution.
- Run-scoped event, provider, and undo context.
- Nested delegate rendering in the TUI and web client.
- Persisting a completed delegate summary on the parent tool part.
- Compatibility with the existing bash path during migration.
- Removal of the legacy CLI and stderr event protocol after migration.

This specification does not cover:

- Multi-turn delegate conversations.
- Delegates invoking other delegates.
- A `delegate_external` tool. External process delegation should be a separate
  issue after the in-process path is stable.
- New ACP visualization for nested delegate activity.
- Arbitrating concurrent delegates that edit the same file.

## 3. Current Codebase

### 3.1 Current invocation path

1. `AgentConfig.subAgents` is populated from `profiles[*].sub_agents`.
2. `buildSubAgentBlock()` teaches the model the
   `quark --sub-agent --no-store --profile ...` command.
3. The user-owned bash tool detects that command with a regular expression.
4. Bash spawns another Quark process with `QUARK_EMIT_EVENTS=1`.
5. `src/session/event-writer.ts` writes compact `QUARK_EVENT:` records to
   stderr.
6. Bash parses those records and emits the separate `subagent-*` event family.
7. TUI and web state attach those events to a parent bash tool call through
   `parentCallId`.

### 3.2 Existing reusable pieces

- `prompt()` already accepts an `AgentConfig`.
- `ToolContext` already carries `sessionId`, `messageId`, `callId`, and abort
  state.
- Ephemeral sessions already store messages and parts in memory.
- The event bus is process-local and shared by all in-process loops.
- TUI and web already have nested sub-agent state and rendering components.
- `resolveToolSet()` already filters the global registry by `agent.tools`.

### 3.3 Gaps that must be fixed first

The current runtime cannot safely execute delegates in-process without these
changes:

| Gap | Current behavior | Required behavior |
|---|---|---|
| Session semantics | `kind: "ephemeral"` replaces `kind: "subagent"` | Persistence and semantic kind are independent |
| Parent linkage | `prompt({ ephemeral: true })` drops `parentSessionId` | Ephemeral child retains parent linkage |
| Result extraction | `prompt()` returns only `sessionId` | Child final text and usage are returned |
| Cancellation | `prompt()` always creates its own abort controller | Parent tool abort cancels the child loop |
| Tool loading | Bootstrap loads only the active primary agent's tools | Reachable delegates have their tools registered |
| Skill binding | One global skill tool is built with the primary's skills | Skill tool is constructed for the active agent |
| Event routing | TUI filters by exact `sessionId` | Child events route to the parent tool call |
| Event identity | Child `messageId` is not the parent message ID | Route carries parent session, message, and call IDs |
| Provider state | `setForceAgent()` mutates all Copilot fetch instances | Initiator state is scoped to one async run |
| Undo state | Current turn is a module-level singleton | Delegate edits belong to the root user turn |
| Ephemeral cleanup | In-memory sessions and events have no disposal API | Completed child state is removed |
| Tool persistence | Tool result metadata is discarded | Delegate summary metadata survives reload |

## 4. Proposed Architecture

### 4.1 Logical agent catalog

Runtime code consumes one catalog independent of how definitions are stored:

```ts
interface AgentCatalog {
  defaultAgentId: string
  agents: Record<string, AgentDefinition>
  delegates: Record<string, AgentDefinition>
}

interface AgentDefinition {
  id: string
  name: string
  description?: string
  promptFile: string
  tools: string[]
  skills: string[]
  delegates?: string[]
  model?: string
  permissions?: PermissionRule[]
}
```

`agents` and `delegates` have the same definition shape but different
visibility:

- `agents` can be selected from CLI, TUI, web, and ACP profile surfaces.
- `delegates` can be resolved only by the delegate runner.
- Only `agents[*].delegates` is supported in the first version.
- Delegate definitions declaring their own delegates are rejected in the first
  version.

The catalog is the stable runtime boundary. Issue #145 may later change storage
from YAML registration to single-file definitions without changing delegate
execution.

### 4.2 Configuration shape

The additive YAML shape is:

```yaml
default_agent: coder

agents:
  coder:
    prompt_file: profiles/coder.md
    tools: [read, write, edit, bash, skill, delegate]
    skills: [code-review]
    delegates: [finder, oracle, test-engineer]

delegates:
  finder:
    prompt_file: delegates/finder.md
    tools: [read, grep, glob]
    model: opencode/deepseek-v4-flash

  oracle:
    prompt_file: delegates/oracle.md
    tools: [read, grep, glob, websearch]
    model: codex/gpt-5.5

  test-engineer:
    prompt_file: delegates/test-engineer.md
    tools: [read, write, edit, bash]
```

Merge and validation rules:

1. Global config loads before project config.
2. Project entries override global entries within the same category.
3. An ID cannot exist in both `agents` and `delegates`.
4. `default_agent` must resolve from `agents`.
5. `agents[*].delegates` must resolve from `delegates`.
6. Invalid references fail activation of the affected agent; they do not
   silently fall back to `coder`.
7. Empty or missing `delegates` means the agent cannot delegate.
8. A delegate is never returned by `listAgents()`.

Compatibility during the additive release:

- `default_profile` maps to `default_agent`.
- `profiles` remains readable.
- `sub_agents` maps to `delegates` on an agent definition.
- Legacy `listProfiles()` remains as a deprecated alias for `listAgents()`.
- The new keys take precedence when both old and new keys are present.

Legacy profiles cannot be automatically classified perfectly. The migration
script classifies every ID referenced by `sub_agents` as a delegate, except the
default profile. Ambiguous IDs produce a clear error and require manual
classification.

### 4.3 Runtime agent configuration

Rename the runtime field without changing the rest of `AgentConfig`:

```ts
interface AgentConfig {
  id: string
  name: string
  prompt: string
  tools: string[]
  skills: string[]
  delegates?: string[]
  model?: string
  permissions?: PermissionRule[]
}
```

Use one `agentFromDefinition()` factory for both catalog categories. A delegate
does not need a separate runtime type; its catalog category determines whether
it can be selected by a user.

### 4.4 Delegate tool contract

The built-in tool has a deliberately small input:

```ts
delegate({
  agent: string,
  prompt: string,
})
```

The model-visible output is the delegate's final assistant text.

The internal `ToolResult.metadata` shape is:

```ts
{
  kind: "delegate",
  agent: string,
  model: string,
  usage: {
    input?: number,
    output?: number,
    cacheRead?: number,
    cacheWrite?: number,
  },
  contextTokens?: number,
  durationMs: number,
  childSessionId: string,
}
```

Validation order:

1. The caller must have `delegate` in `agent.tools`.
2. The requested ID must be present in `caller.delegates`.
3. The requested ID must resolve from `catalog.delegates`.
4. The delegate definition must pass prompt, tool, skill, model, and permission
   validation.

Unknown or unauthorized IDs throw a tool error:

```text
Agent "finder" is not a registered delegate for agent "coder".
```

### 4.5 Delegate runner

Keep orchestration outside the tool definition in a focused module:

```text
src/tool/delegate.ts
  - schema and ToolDef only

src/delegate/runner.ts
  - authorization
  - delegate resolution
  - child run construction
  - result extraction
  - cleanup
```

Execution sequence:

1. Resolve the caller from `ToolContext.agent`.
2. Validate the requested delegate.
3. Build the delegate's `AgentConfig`.
4. Create a linked ephemeral child session.
5. Enter a child run context carrying parent and root-turn identity.
6. Call `prompt()` with the parent tool's abort signal.
7. Wait for the child loop to stop.
8. Return the final assistant text and metadata.
9. Dispose of the ephemeral session in `finally`.

Delegate failures are ordinary tool failures. The parent model receives the
error through the normal AI SDK tool-error path and may recover in its next
step.

### 4.6 Prompt result contract

Extend `prompt()` to return a reusable run result:

```ts
interface PromptResult {
  sessionId: string
  finalMessageId?: string
  output: string
  model: string
  usage: TokenUsage
  contextTokens?: number
}
```

Result extraction happens from the finalized in-memory or persisted message
state:

- Select the last completed assistant message.
- Concatenate its text parts in part order.
- Sum token usage across `step-finish` parts for `usage`.
- Use the final step's input token count for `contextTokens`.
- Return an empty output only when the delegate completed without a text part.

This contract also removes the existing output-extraction TODO in the goal
orchestrator without coupling that feature to delegation.

### 4.7 Session lifecycle

Separate session role from persistence:

```ts
type SessionKind = "main" | "subagent"

interface Session {
  kind: SessionKind
  ephemeral: boolean
  parentSessionId: string | null
  // existing fields
}
```

Compatibility when replaying existing sessions:

- Stored `kind: "ephemeral"` normalizes to
  `{ kind: "main", ephemeral: true }`.
- Missing `ephemeral` normalizes to `false`.

A delegate child is:

```text
kind: subagent
ephemeral: true
parentSessionId: parent session
```

Add `disposeEphemeralSession(sessionId)` to remove both:

- Session metadata from `ephemeralStore`.
- Message and part events from `ephemeralEvents`.

The child is disposed only after its final output and summary metadata have
been extracted.

### 4.8 Run-scoped context

Introduce a narrow `AsyncLocalStorage` context for state that must survive
through the child async call chain:

```ts
interface RunContext {
  sessionId: string
  agentId: string
  initiator: "user" | "agent"
  rootSessionId: string
  rootUserMessageId: string
  parent?: {
    sessionId: string
    messageId: string
    callId: string
    agentId: string
  }
}
```

Responsibilities:

- Stamp routed events.
- Mark delegate provider requests as agent-initiated.
- Associate delegate file changes with the root user turn.
- Keep parallel delegate calls isolated.

The delegate path must not use `process.env.QUARK_SESSION_ID` or the global
`setForceAgent()` toggle for correctness. Those may remain temporarily for
legacy subprocess compatibility.

### 4.9 Abort propagation

`prompt()` accepts an optional parent abort signal:

```ts
prompt({
  abort?: AbortSignal,
  // existing input
})
```

It creates its normal local controller and links the parent signal:

- Parent abort aborts the child controller.
- `cancel(childSessionId)` still aborts only the child.
- Cleanup removes the parent abort listener.
- Aborting one parallel delegate does not abort sibling delegates.
- Rejecting a delegate permission request aborts the child loop, not the parent
  loop.

The parent delegate tool still participates in the existing
`Promise.race(..., abortSignalToPromise())` behavior.

### 4.10 Agent-scoped tools and skills

The registry may contain the union of loaded tool definitions, but an agent
still receives only `agent.tools`.

At primary-agent activation:

1. Resolve the primary agent.
2. Resolve all delegates listed by that primary.
3. Collect the union of their external tool IDs.
4. Load and register those definitions once.
5. Resolve each loop's actual tool set from its own `AgentConfig`.

Agent-dependent built-ins are constructed at tool-set resolution time:

- `buildSkillTool(agent.skills)` ensures the description and allowed skills
  belong to the current agent.
- `delegate` receives the caller through `ToolContext.agent`.

Extend `ToolContext` with:

```ts
agent: AgentConfig
```

This preserves strict binding while avoiding one registry per delegate.

The skill tool must reject loading a skill not present in `agent.skills`.
The current implementation filters only the description/listing but allows
`loadSkill(name)` to load an unbound skill; this must be corrected before
delegate isolation is considered complete.

### 4.11 Undo ownership

Delegates that edit files operate on behalf of the parent user turn.

Replace the global current-turn singleton with explicit or run-scoped identity:

```text
root session ID
root user message ID
```

`toolPreExecute()` uses this root identity even when the modifying tool belongs
to a child session. Therefore `/undo` on the parent session reverts edits made
by the parent and its delegates during that user turn.

Snapshot tracking must be keyed by root session and user message so concurrent
delegate tool calls do not overwrite another run's bookkeeping.

### 4.12 Standard event routing

Keep existing event names and add optional routing metadata:

```ts
interface EventRoute {
  parentSessionId: string
  parentMessageId: string
  parentCallId: string
  agentId: string
}
```

The event payload keeps the child's real `sessionId` and `messageId`.
`TypedBus.emit()` attaches `route` from the active `RunContext`.

Example:

```text
event: tool-input
sessionId: child session
messageId: child assistant message
callId: child tool call
route.parentSessionId: visible parent session
route.parentMessageId: parent assistant message
route.parentCallId: delegate tool call
route.agentId: finder
```

This is required because `parentCallId` alone is insufficient:

- TUI state currently finds a parent tool part through its parent message.
- Child and parent message IDs are different.
- TUI and web currently filter events by exact session ID.

Top-level projections handle events with no route. Nested projections handle
events with a route. Child `loop-start` and `loop-end` must never toggle the
parent conversation's global running state.

### 4.13 TUI and web state

Replace sub-agent-specific view state with generic nested-run state:

```ts
interface NestedRunState {
  agent: string
  model?: string
  prompt: string
  tools: NestedToolPart[]
  tokensUsed: number
  tokenLimit: number
  textPreview?: string
  done: boolean
}
```

Rename:

- `SubAgentState` to `NestedRunState`.
- `SubAgentView` to `NestedToolView`.
- Web `SubAgentTree` to `NestedToolTree`.
- Parent tool field `subAgent` to `nestedRun`.

Initialization:

- A `delegate` `tool-input` event creates the nested run immediately from
  `{ agent, prompt }`.
- Routed child events update that nested run.
- Parent `tool-end` provides the terminal status.
- Late child events are ignored after the parent tool reaches a terminal state.

During compatibility, legacy `subagent-*` events are adapted into the same
`NestedRunState`; they do not need a second renderer.

### 4.14 Persisted parent summary

Delegate child sessions are ephemeral, so the parent tool part must retain a
small completed summary.

Add optional metadata to `ToolPartData`:

```ts
metadata?: Record<string, unknown>
```

On `tool-result`, persist safe result metadata alongside output. For delegate
calls this includes:

- Agent ID.
- Model ID.
- Token usage.
- Context tokens.
- Duration.
- Child session ID for diagnostics.

On transcript reload:

- Detect `tool === "delegate"`.
- Reconstruct a completed `nestedRun` from tool input and metadata.
- Do not attempt to restore the ephemeral child tool history.

Runtime child activity is visible live; the durable parent record contains the
task, final output, status, model, tokens, and duration.

### 4.15 Permissions

There are two permission layers:

1. The parent agent's permission to call `delegate`.
2. The delegate's permission to call its own tools.

The existing permission engine remains authoritative.

- Parent rules are evaluated for `tool: delegate`.
- Child rules come from the delegate's `AgentConfig.permissions`.
- Child permission requests carry event routing metadata and appear in the
  active parent UI.
- Approval resolves the child request.
- Rejection aborts only the child and returns a delegate tool error.

Argument-level delegate permissions remain out of scope. Authorization by
delegate ID is enforced mechanically by `caller.delegates`.

### 4.16 System prompt

Replace `buildSubAgentBlock()` with `buildDelegateBlock()`.

The block is emitted only when:

- `agent.delegates` is non-empty.
- `delegate` is present in `agent.tools`.

Example:

```text
# Available Delegates

Use the `delegate` tool for isolated, single-turn tasks:

- finder: Locate code by behavior or concept.
- oracle: Review architecture and difficult engineering decisions.

The delegate returns its final response as the tool result.
```

Do not include CLI syntax, storage instructions, timeout instructions, or bash
implementation details.

## 5. Implementation Plan

### Phase 1: Agent catalog

Files:

- `src/profile/profile.ts`
- `src/agent.ts`
- `src/cli.ts`
- `src/tui/index.tsx`
- `src/web/server.ts`
- `src/acp/agent.ts`
- `test/profile/profile.test.ts`

Tasks:

1. Introduce `AgentCatalog` and category-aware parsing.
2. Add `agents`, `delegates`, and `default_agent` compatibility parsing.
3. Add `listAgents()`, `listDelegates()`, `resolveAgent()`, and
   `resolveDelegate()`.
4. Reject category collisions and invalid active-agent delegate references.
5. Rename runtime `subAgents` to `delegates`.
6. Update all user-facing pickers to call `listAgents()`.
7. Keep deprecated profile APIs as adapters for one release.

Exit condition:

- Delegates can be configured and resolved but invocation behavior is
  unchanged.
- No delegate appears in CLI, TUI, web, or ACP profile lists.

### Phase 2: Reentrant child-run foundation

Files:

- New `src/session/run-context.ts`
- `src/session/session.ts`
- `src/storage/session-jsonl.ts`
- `src/storage/session-format.ts`
- `src/session/prompt.ts`
- `src/session/message.ts`
- `src/provider/custom-fetch.ts`
- `src/provider/copilot-fetch.ts`
- `src/commands/undo.ts`
- `src/tool/ai-adapter.ts`

Tasks:

1. Separate session kind from persistence.
2. Preserve parent linkage for ephemeral child sessions.
3. Add ephemeral-session disposal.
4. Add `PromptResult` extraction.
5. Add linked abort input to `prompt()`.
6. Add run-scoped context and event route data.
7. Replace delegate-path provider global toggles with run-scoped initiator
   state.
8. Scope undo tracking to the root user turn.

Exit condition:

- Two in-process child prompts can run concurrently without sharing event,
  abort, provider initiator, session, or undo state.

### Phase 3: Agent-scoped tool resolution

Files:

- `src/bootstrap.ts`
- `src/tool/loader.ts`
- `src/tool/registry.ts`
- `src/tool/ai-adapter.ts`
- `src/tool/skill.ts`
- `src/tool/tool.ts`

Tasks:

1. Preload the union of tools used by the active agent and its delegates.
2. Continue filtering each loop to its exact `agent.tools`.
3. Construct the skill tool from the current agent's bound skills.
4. Enforce skill membership during execution.
5. Add the active `AgentConfig` to `ToolContext`.
6. Register `delegate` as a built-in tool.

Exit condition:

- A delegate can use a tool unavailable to its parent.
- The parent cannot see that tool unless it declares it.
- A delegate cannot load an unbound skill.

### Phase 4: Delegate execution

Files:

- New `src/tool/delegate.ts`
- New `src/delegate/runner.ts`
- `src/session/system.ts`
- `src/bootstrap.ts`
- `src/index.ts`
- New `test/tool/delegate.test.ts`

Tasks:

1. Implement authorization and catalog lookup.
2. Build the delegate agent.
3. Run a linked ephemeral child prompt.
4. Return final text and metadata.
5. Propagate abort and child tool errors.
6. Dispose child state.
7. Replace the bash instructions in the system prompt.

Exit condition:

- A parent model receives a delegate's final text as a normal tool result.
- Unauthorized delegates fail before a child session is created.

### Phase 5: Unified nested rendering

Files:

- `src/session/events.ts`
- `src/session/processor.ts`
- `src/tui/events.ts`
- `src/tui/state.ts`
- `src/tui/components/message-item.tsx`
- Rename `src/tui/components/sub-agent-view.tsx`
- `src/shared/conversation-view.ts`
- `src/web/server.ts`
- `src/web/client/app.tsx`
- `src/web/client/state.ts`
- Rename `src/web/client/components/sub-agent-tree.tsx`
- Delegate and rendering tests under `test/tui/` and `test/web/`

Tasks:

1. Attach route metadata to standard child events.
2. Split top-level and nested projections.
3. Rename sub-agent state and components to generic nested-run names.
4. Initialize nested state from delegate tool input.
5. Route child text, tools, usage, model, completion, errors, and permission
   requests under the parent tool.
6. Persist delegate metadata on the parent tool part.
7. Reconstruct completed delegate cards after reload.
8. Adapt legacy `subagent-*` events into the same state during compatibility.

Exit condition:

- The delegate path and legacy bash path render through one nested-run
  component.
- Delegate events never add child messages to the parent transcript.

### Phase 6: User migration

Files:

- New `scripts/migrate-config.ts`
- `README.md`
- `AGENTS.md` examples where applicable

User-owned files affected:

- `~/.config/quark/config.yaml`
- `~/.config/quark/AGENTS.md`
- `~/.config/quark/profiles/coder.md`
- `~/.config/quark/tools/bash.ts`

Migration script requirements:

1. Support `--check`, `--write`, and explicit `--path`.
2. Never overwrite without writing a timestamped backup.
3. Convert `default_profile` to `default_agent`.
4. Convert `profiles` to `agents` and `delegates`.
5. Convert `sub_agents` to `delegates`.
6. Add `delegate` to callers that have delegates.
7. Report ambiguous classifications without modifying the file.
8. Preserve unrelated model, provider, permission, and goal configuration.

Exit condition:

- A migrated configuration loads with no compatibility warning.
- The model no longer receives bash sub-agent instructions.

### Phase 7: Legacy removal

Remove after one compatibility release and a successful manual TUI test:

- `src/session/event-writer.ts`.
- `subagent-*` event types and adapters.
- `--sub-agent` and `--parent-session` CLI flags.
- `QUARK_EMIT_EVENTS`.
- `QUARK_EVENT:` parsing.
- Bash `isSubAgentCommand`, `executeSubAgent`, and `forwardEvent`.
- Command-regex reconstruction in TUI, web, and conversation views.
- Legacy `profiles` and `sub_agents` parsing, subject to the release
  deprecation policy.
- Legacy bash-subagent tests.

## 6. Test Plan

### 6.1 Catalog tests

- New schema parses agents and delegates separately.
- Project config overrides the same global category.
- Cross-category duplicate IDs fail.
- Unknown delegate references fail active-agent resolution.
- Legacy schema maps correctly.
- Pickers and ACP modes contain agents only.
- Migration preserves unrelated config.

### 6.2 Session and result tests

- Ephemeral sub-agent retains `parentSessionId`.
- Ephemeral sub-agent has `kind: "subagent"`.
- No child files are written to disk.
- Disposal removes metadata, messages, and parts.
- `PromptResult.output` returns the final assistant text.
- Usage is aggregated and final context input is retained.
- Existing persisted `kind: "ephemeral"` data still normalizes.

### 6.3 Delegate tool tests

- Allowed delegate returns final text.
- Missing caller authorization returns the specified tool error.
- Missing delegate definition fails before session creation.
- Delegate model override wins over the main model.
- Delegate receives only its configured tools.
- Delegate receives only its configured skills.
- Delegate permission allow, deny, ask, and reject paths work.
- Child failure becomes a parent tool error.
- Empty final text returns a valid empty output.
- Child state is disposed on success, failure, and abort.

### 6.4 Concurrency and cancellation tests

- Two parallel delegate calls retain distinct parent call IDs.
- Text and tool events never cross between delegate cards.
- Aborting the parent aborts all active child calls for that parent tool.
- Aborting one child by session ID does not abort its sibling.
- Child `loop-end` does not mark the parent loop idle.
- Provider initiator state does not leak to a concurrent top-level prompt.
- Undo tracking remains attached to the root user turn.

### 6.5 TUI and web boundary tests

- Delegate tool input creates a nested card before the first child event.
- Child tool calls render under the correct delegate card.
- Child text preview, model, and token usage update live.
- Child permission requests display in the active parent UI.
- Parent tool success and error stop all nested spinners.
- Late child events cannot overwrite a terminal parent state.
- Reload reconstructs the completed delegate summary from parent tool metadata.
- Delegates do not appear as top-level transcript messages.
- Legacy bash events and new routed events produce equivalent nested state
  during compatibility.

### 6.6 Commands

Run focused tests during each phase, then:

```bash
bun test test/profile test/session test/tool test/tui test/web
bun run typecheck
bun run build
```

### 6.7 Manual end-to-end TUI test

Required before marking the specification done:

1. Configure `coder` with `tools: [..., delegate]` and
   `delegates: [finder]`.
2. Configure `finder` with a tool not available to `coder`.
3. Start the TUI as `coder`.
4. Trigger a finder delegation.
5. Confirm the card appears immediately with agent and task.
6. Confirm finder-only tool activity renders under the delegate card.
7. Confirm tokens, model, text preview, and completion update.
8. Confirm the parent receives the final text and continues its response.
9. Trigger a long delegate and cancel the parent.
10. Confirm parent and child spinners stop with no late-event regression.
11. Restart Quark and reload the session.
12. Confirm the completed delegate summary remains visible.
13. Confirm `finder` is absent from profile pickers.

## 7. Acceptance Criteria

- [ ] `delegate({ agent, prompt })` returns the delegate's final assistant text.
- [ ] Only explicitly allowed delegate IDs can be invoked.
- [ ] Delegates receive their own strict tools, skills, prompt, model, and
      permissions.
- [ ] Delegates never appear in user-facing profile pickers.
- [ ] Delegate sessions are linked, ephemeral, and disposed after result
      extraction.
- [ ] Parent cancellation reaches the child loop.
- [ ] Parallel delegate events and provider state remain isolated.
- [ ] Delegate edits are included in the parent turn's undo history.
- [ ] Standard events with route metadata drive nested TUI and web rendering.
- [ ] Completed delegate summary metadata survives parent session reload.
- [ ] Child permission requests are actionable from the parent UI.
- [ ] The compatibility release supports both native delegate and legacy bash
      paths.
- [ ] After legacy removal, source contains no `QUARK_EVENT:`,
      `QUARK_EMIT_EVENTS`, `subagent-*`, or `--sub-agent` protocol code.
- [ ] Automated tests, typecheck, build, and the manual TUI test pass.

## 8. Dependencies and Coordination

### Issue #145: single-file profiles

This is a real schema dependency, not an independent concern. The catalog
contract in this specification should be agreed first. Either:

1. #146 lands the catalog using current YAML storage and #145 later supplies a
   new storage adapter, or
2. #145 lands first with separate user-agent and delegate directories and #146
   consumes that catalog.

Do not implement two competing profile migrations.

### Issue #143: global mutable state

The full runtime refactor is not required, but #146 must introduce scoped state
for the specific globals made unsafe by in-process concurrency:

- Provider initiator state.
- Current undo turn.
- Event parent routing.

### Issue #144: event registration

No hard dependency. Route metadata should be added without creating another
event family. A later event-registry refactor can consume the same route
contract.

## 9. Key Decisions

| Decision | Rationale |
|---|---|
| Single-turn tool, not a child CLI | Matches request/result semantics and removes private IPC |
| In-process child loop | Reuses the model, tool, permission, session, and event systems |
| Logical catalog separate from storage | Avoids coupling this feature to issue #145's file format |
| Separate session kind and persistence | A delegate is both a sub-agent and ephemeral |
| Standard events plus route metadata | Preserves one vocabulary while retaining child identity |
| Route includes parent message and call | `parentCallId` alone cannot update current UI state safely |
| Agent-scoped skill tool | Enforces strict binding for delegates |
| Preload reachable tool definitions | Supports delegate-only tools without mutating the registry mid-run |
| Root-turn undo ownership | Delegate file changes were requested by the parent user turn |
| Persist summary on parent tool part | Child state is ephemeral but completed UI must survive reload |
| Defer external delegates | Keeps the first implementation focused and testable |
| One compatibility release | Allows config and prompt migration before deleting the working path |

## 10. Risks

| Risk | Mitigation |
|---|---|
| In-process state leaks between parallel delegates | Async-local run context plus concurrency tests |
| Delegate-only tools are missing at runtime | Preload reachable definitions and test strict resolution |
| Child events alter parent running state | Separate routed and top-level event projections |
| Child permission prompt cannot be answered | Route permission events and test approval/rejection end to end |
| Delegate edits bypass `/undo` | Root-turn identity in tool pre-execution |
| Ephemeral memory grows indefinitely | Dispose child session and event state in `finally` |
| Profile work conflicts with #145 | Stabilize catalog API before storage migration |
| TUI works live but loses state after restart | Persist delegate summary metadata on parent tool result |
| Legacy deletion breaks user-owned bash config | Migration script, backup, compatibility release, manual test |
