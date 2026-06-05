Note: The research anchor files should not not be mentioned in the writing.
# How Quark Is Built - Book Structure

This series is a technical deep dive into how Quark was built from scratch.
The through-line should stay simple:

```text
task -> output
```

A coding agent looks simple from the outside, but the implementation becomes a
set of harness problems: tools, memory, provider integration, loop control,
context isolation, UI, permissions, skills, and packaging.

Each chapter should answer three questions:

1. What problem was I trying to solve?
2. What tradeoff did I choose?

## Chapter 1: Why Quark

Draft: `docs/chapter-01-why-quark.md`

Purpose: explain the motivation before touching architecture.

### 1.1 The Agent Landscape I Was Stuck In

- Codex and Claude Code: good products, closed harnesses.
- Opencode: open source, but not the UX/config style I wanted.
- Amp: strong autonomous harness, but expensive and closed.
- The recurring frustration: every tool has useful ideas, but the harness is not mine (and sometimes it is not good "enough")

Research anchors:

- `docs/notes.md`
- `docs/how-quark-is-built.md`
- `package.json`

### 1.2 The Problems I Wanted To Own

- Provider lock-in.
- Conversation data owned by someone else.
- Hard-to-change system prompts and tool definitions.
- Poor fit for research workflows.
- UI/UX that gets in the way of daily use.

### 1.3 The Four Design Goals

- Model freedom: provider/model strings such as `copilot/gpt-4o`.
- Hackability: CLI, SDK, headless runs, local config.
- Data ownership: sessions written to local disk.
- Avoiding context window contamination

Code anchors:

- `src/provider/resolver.ts`
- `src/cli.ts`
- `src/index.ts`
- `src/storage/session-path.ts`

### 1.4 Quark As A Harness

- The model supplies reasoning.
- The harness supplies tools, memory, persistence, guardrails, and UI.
- The product is not "a prompt"; the product is the system around the model.

### 1.5 What Quark Is Not

- Not a thin API wrapper.
- Not a model company.
- Not trying to hide the machine.
- Not trying to make one universal agent context for every task.

### 1.6 Transition To Chapter 2

End with the minimum viable agent:

```text
tools + memory + brain + loop
```

## Chapter 2: The Agent Core

Draft: `docs/chapter-02-the-agent-core.md`

Purpose: build the first working agent loop from first principles.

### 2.1 Start With The Smallest Mental Model

- Agent as `task -> output`.
- Why this is incomplete: the model must act, remember, think, and iterate.
- Introduce the four primitives:
  - Tools
  - Memory
  - Brain/provider
  - Loop

Code anchors:

- `src/session/prompt.ts`
- `src/session/processor.ts`

### 2.2 Tools: Giving The Model Hands

- Why a chatbot is not an agent without tools.
- Choosing AIsdk as the framework which I used as the one to build
  - Aisdk provides enough abstraction to quickly get start and build the agent (abstraction to multiple provider which is what I need)
- Zod schemas as both JSON Schema and runtime validation: 
  - Why do we need zod and even why tooldef but not AI-sdk toolset? Initialy Quark is designed as the minial agent where tool can be written out of the binary. And zod is perfect for this, I want some package that can do runtime validation for tool argument because Typescript types are erased at runtime, they only exists during compile time.
  - with zod, args from the tool is fully typed, no caseting no manual checking. 

Code anchors:

- `src/tool/tool.ts`
- `src/tool/ai-adapter.ts`
- `src/tool/loader.ts`
- `src/tool/read.ts`
- `src/tool/look.ts`
- `examples/tools/write.ts`
- `examples/tools/edit.ts`
- `examples/tools/bash.ts`

### 2.3 Memory: Task, Sessions, Messages, Parts

Quark's memory model has four levels:

```text
Task -> Session -> Message -> Part
```

- Task as the human unit of work: one goal or problem space.
- Session as one attempt, branch, or focused conversation inside that task.
- Message as a user/assistant turn.
- Part as the real unit of streaming history.
- The first user message creates a task synchronously and links the session with `taskId`.
- Branching creates a new session under the same task, carries forward a summary, and keeps the new context smaller.
- Past sessions inside the same task can be searched/read when a later branch needs old context.
- Why the part model falls out of the AI SDK stream.
- Why JSONL fits append/replay better than a relational model for this use case.

Code anchors:

- `src/session/session.ts`
- `src/task/task.ts`
- `src/session/initializer.ts`
- `src/session/message.ts`
- `src/session/branch.ts`
- `src/storage/session-format.ts`
- `src/storage/session-jsonl.ts`
- `src/storage/session-path.ts`
- `src/tool/find_session.ts`
- `src/tool/read_session.ts`

### 2.4 The Brain: Provider Resolution

Quark's initial goal is model agnostic, with a long-term interest in pushing local LLMs harder by improving the harness around them. But to make Quark useful enough to build Quark, I first needed OpenAI-compatible providers. Copilot came next because I already had access to it, and it exposed a few provider-specific scars worth telling.

- Models are specified as `provider/model`.
- Quark resolves a model string into an AI SDK model.
- OpenAI-compatible (local) providers are first-class.
- Copilot is handled as a provider with special fetch/auth behavior.

Code anchors:

- `src/provider/resolver.ts`
- `src/provider/copilot-auth.ts`
- `src/provider/copilot-fetch.ts`
- `src/provider/custom-fetch.ts`
- `src/provider/models.ts`

### 2.5 The Loop: Turning One Response Into An Agent

- `prompt()` as the public entry point.
- `loop()` as the agent driver.
- `processStream()` as the bridge between provider stream, storage, and UI events.
- Continue when tools were called.
- Stop when the model is done.
- Branch/recover when context is too long.
- Stop runaway behavior with `max_steps`.

Code anchors:

- `src/session/prompt.ts`
- `src/session/processor.ts`
- `src/session/retry.ts`
- `src/session/branch-controller.ts`
- `src/session/branch.ts`
- `src/session/context.ts`

### 2.6 Implementation Scars

- Copilot auth/device flow.
- Copilot response quirks that need a custom fetch layer.
- Append-only storage and replay.
- Retry and context-too-long handling.

Code anchors:

- `src/provider/copilot-auth.ts`
- `src/provider/copilot-fetch.ts`
- `src/session/retry.ts`
- `src/session/branch.ts`

### 2.7 Transition To Chapter 3

Once the core loop works, the next problem appears:

```text
If every agent sees every tool, every skill, and every instruction,
the context becomes noisy before the task even starts.
```

## Chapter 3: Profiles And Context Isolation

Purpose: explain why Quark starts from isolated agent identities instead of one
global agent context.

Chapter 2 solves the core loop. Chapter 3 solves the next problem: even a
working loop gets worse if every run carries every tool, every skill, and every
instruction. Profiles are Quark's answer to that. A profile gives the agent a
bounded identity before the task begins.

### 3.1 The Incentive: Context Contamination

- A coding agent should not carry 100 tools it will never call.
- A research agent should not carry shell/edit/write tools by default.
- A tester agent should not need web-search descriptions unless testing needs them.
- Noise reduction is a feature, not a limitation.

### 3.2 Profile As Agent Identity

- A profile defines:
  - system prompt
  - tools
  - skills
  - sub-agents
  - model override
  - permission rules
- Profiles are deterministic by default: explicit `--profile`, then default config, then built-in coder.

Code anchors:

- `src/profile/profile.ts`
- `src/agent.ts`
- `src/bootstrap.ts`

### 3.3 Version One: Prompt File + Tool Set

- Start with the smallest useful profile.
- Read prompt from a file instead of inlining it.
- Bind only the tools declared by the profile.
- Show how this affects the tool definitions sent to the model.

Code anchors:

- `src/profile/profile.ts`
- `src/session/system.ts`
- `src/tool/ai-adapter.ts`

### 3.4 Building The System Prompt

- Global instructions.
- Project instructions.
- Profile prompt.
- Bound skill metadata.
- Sub-agent metadata, as a short list of profiles this agent is allowed to spawn.
- Environment block.

Sub-agents only need a brief note here: they are not a separate architecture yet,
just another use of profiles. The parent profile declares which narrower profiles
it can delegate to; the execution details can be saved for a later follow-up post.

Code anchors:

- `src/session/system.ts`
- `AGENTS.md`
- `.quark/config.yaml`
- `~/.config/quark/config.yaml`

### 3.5 Strict Binding, No Global Skill Pool

- Only profile-bound tools are registered for the session.
- Only profile-bound skill metadata enters the system prompt.
- Unknown sub-agents are stripped with a warning.
- Project overrides can add tools/skills without changing the global profile.

Code anchors:

- `src/profile/profile.ts`
- `src/skill/skill.ts`
- `src/session/system.ts`

### 3.6 The Tradeoff

- Benefit: smaller, cleaner context.
- Benefit: more predictable agent identity.
- Cost: the user must think about profiles.
- Cost: discovery becomes an explicit action, not an accidental side effect.

### 3.7 Transition To Chapter 4

Profiles decide what the agent is allowed to know and do. The next problem is
visibility: while the loop is running, the user needs to see what is happening.

## Chapter 4: The TUI, Event Bus, And Thinking Toggle

Purpose: explain why Quark has a first-class terminal UI and how the core loop
communicates with it.

Thinking belongs in this chapter as a concrete TUI case study: it starts as a
keyboard/UI control, changes provider options, produces reasoning stream events,
and then has to be rendered back to the user. That makes it a good example of
the full path from UI intent to agent runtime behavior.

### 4.1 Why A TUI

- Working with a coding agent through shell output is useful, but I wanted a richer interface like Opencode, Codex, or Claude Code. So I built the TUI. The components were largely built by Quark; the important hand-written part is the bridge between the headless loop and the UI.
- The user needs to see streaming text, tool calls, diffs, permissions, thinking, session state, and some TUI animation for fun.
- The TUI should expose enough of the harness to make the agent understandable while it runs.

Code anchors:

- `src/tui/index.tsx`
- `src/tui/components/App.tsx`

### 4.2 The Core Emits Events

- The session loop should stay headless: it should not import TUI components or know how it is being rendered.
- The core emits typed events; consumers decide what to do with them.
- The TUI should not poll storage to know what is happening.
- The event bus connects the agent core to UI, CLI, ACP, and plugins.

Introduce the event bus here as Quark's runtime pub/sub layer:

```text
processStream() -> bus.emit(...) -> TUI / CLI / ACP / plugins
```

The loop stays reusable because it only emits events such as `text-delta`,
`tool-start`, `tool-end`, `reasoning-delta`, and `permission-request`.

Code anchors:

- `src/session/events.ts`
- `src/session/processor.ts`
- `src/cli.ts`
- `src/acp/agent.ts`

### 4.3 Projecting Events Into UI State

- Runtime events become TUI actions.
- TUI state is a live projection of the stream.
- Stored sessions can be replayed into the same message model.

Code anchors:

- `src/tui/events.ts`
- `src/tui/state.ts`
- `src/shared/conversation-view.ts`
- `src/session/message.ts`

### 4.4 Rendering The Agent At Work

- User messages.
- Assistant streaming text.
- Tool cards.
- Diff views.
- Sub-agent views.
- Scrollable command output.

Code anchors:

- `src/tui/components/user-message.tsx`
- `src/tui/components/assistant-message.tsx`
- `src/tui/components/tool-card.tsx`
- `src/tui/components/diff-view.tsx`
- `src/tui/components/sub-agent-view.tsx`
- `src/tui/components/scrollable-output.tsx`

### 4.5 Thinking Toggle

- Thinking is a provider option, not just a UI flag.
- The UI needs to show whether thinking is active.
- The user can toggle thinking without rewriting the agent loop.

Code anchors:

- `src/provider/thinking.ts`
- `src/tui/components/App.tsx`
- `src/tui/components/thinking.tsx`
- `src/tui/components/prompt.tsx`

### 4.6 Commands, Sessions, And Model Switching

- Slash commands as control plane.
- Session switch/load.
- Model picker/cycle.
- Clipboard and mention helpers.

Code anchors:

- `src/tui/commands.ts`
- `src/tui/session-tree-picker.ts`
- `src/tui/model-cycle.ts`
- `src/tui/clipboard.ts`
- `src/tui/components/autocomplete.tsx`
- `src/tui/components/mention-chips.tsx`

### 4.7 Closing The Core Build

The main series can finish here. By the end of Chapter 4, the reader has seen
the core Quark agent built from the inside:

- Tools give the model hands.
- Memory gives the loop continuity.
- Providers give the harness a brain.
- The loop turns one response into an agent.
- Profiles keep context clean.
- The TUI and event bus make the harness visible while it runs.

Follow-up posts can go deeper on features that extend the core:

- Skills and progressive disclosure.
- Permissions and guardrails.
- Sub-agents and delegation.
- CLI/package/SDK distribution.
- ACP, web, and remote-control surfaces.
