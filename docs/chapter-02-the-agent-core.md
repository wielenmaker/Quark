# Chapter 2: The Agent Core

> **Rule of the Minimum Loop: An agent is four primitives — tools, memory,
> a brain, and a loop. Build each one before you build anything else.**

Chapter 1 made the case for Quark as a harness — the system of tools, memory,
persistence, and guardrails that surrounds the model. This chapter builds that
harness from first principles. By the end, you will have seen a working agent
loop: the model receives a task, picks up tools, remembers what it did, and
iterates until the work is done. Everything else — profiles, the TUI, skills,
sub-agents — is ornamentation on this core.

We will build outward from the smallest thing that could possibly work, and we
will look at the code as it actually exists, scars and all.

---

## 2.1 Start With The Smallest Mental Model

> **The agent is `task → output`. Everything else is a harness problem.**

A coding agent looks simple from the outside. You type a sentence. The machine
thinks, acts, and responds. But the moment you try to build one, the
implementation fractures into a dozen sub-problems. What tools does the model
have? Where does conversation history live? How do you know which provider to
call? What happens when the model asks for a tool, gets a result, and needs to
call another? What happens when the tool fails? When the context overflows?

These are systems problems — the kind that operating systems, databases, and
compilers have been solving for decades. The model supplies the reasoning.
The harness supplies everything else.

Quark's core identifies four primitives:

| Primitive | What It Does | Where It Lives |
|-----------|-------------|----------------|
| **Tools** | Gives the model hands — filesystem, shell, search. | `src/tool/tool.ts`, `src/tool/registry.ts`, `src/tool/ai-adapter.ts` |
| **Memory** | Records what happened so the model can remember. | `src/session/session.ts`, `src/session/message.ts`, `src/storage/session-jsonl.ts` |
| **Brain** | Resolves a provider/model string into an AI SDK model. | `src/provider/resolver.ts` |
| **Loop** | Iterates: ask model → run tools → ask again → stop. | `src/session/prompt.ts`, `src/session/processor.ts` |

These four primitives form a dependency graph. You cannot build the loop
without tools. You cannot build tools without a way to remember what they
returned. And nothing works without a provider to call. The sections that
follow address each one in the order they must be built.

---

## 2.2 Tools: Giving The Model Hands

Without tools, an LLM is a very expensive fortune teller. It predicts the next
token given the previous ones, which is useful for writing prose and useless
for reading a file, running a test, or editing code. Tools close this gap.
They are the bridge between language and action.

### The Universal Contract

Quark defines every tool through a single interface — `ToolDef<T>` in
`src/tool/tool.ts`. Every tool in the system, whether built-in or
user-defined, must conform to this contract:

```typescript
interface ToolDef<T extends z.ZodType = z.ZodType> {
  id: string                    // unique identifier
  description: string           // what the model sees
  parameters: T                 // Zod schema → JSON Schema for the API
  execute(args: z.infer<T>, ctx: ToolContext): Promise<ToolResult>
}
```

### From ToolDef to Model-Side Tool

Quark needs tools that the user can write outside the binary — a 50-line
TypeScript file dropped into `~/.config/quark/tools/` should work without
recompilation. But the AI SDK expects tools in a specific shape:
`description`, `inputSchema` (JSON Schema), and an `execute` callback. These
two formats — the user's `ToolDef` and the SDK's `ToolSet` — are different
enough that they need a bridge.

`resolveToolSet` in `src/tool/ai-adapter.ts` is that bridge. For every tool ID
in the agent's config, it looks up the `ToolDef` from the registry, converts
the Zod schema to JSON Schema via `z.toJSONSchema()`, and wraps the `execute`
call in three guardrails: a permission check via `askPermission`, Zod argument
validation at the boundary, and event emission for the TUI. The result is an
AI SDK `tool()` object that the provider can stream to.

This adapter is where the harness philosophy becomes concrete. The tool
definition — the `ToolDef` the user writes — is clean and portable. The
adapter layers on the safety mechanisms the harness requires: permissions,
validation, event emission. The tool author doesn't touch any of this.
Undo snapshots, taken before execution, are handled separately by the
harness and do not appear in the tool contract.

### The Registry Pattern

Tools live in a global `Map<string, ToolDef>` keyed by ID (`src/tool/registry.ts`).
Registration is strict: duplicates are rejected, and every tool is validated
on entry. The registry exposes `register()`, `get()`, `list()`, and `resolve()`
— the standard CRUD surface you would expect. Crucially, `resolveAvailable()`
tolerates missing tools — it skips IDs that were not loaded rather than
throwing. This matters because some tools are loaded from
`~/.config/quark/tools/` at bootstrap time, and if a profile declares a tool
that hasn't been installed yet, the agent should still start. It will just have
fewer tools available.

Built-in tools (`read`, `look`, `skill`, `question`, `find_session`,
`read_session`) are registered unconditionally in `src/bootstrap.ts`. All
other tools — `bash`, `write`, `edit`, `grep`, `glob`, `websearch`, `todo`,
and any custom tools the user writes — are loaded dynamically from
`~/.config/quark/tools/{id}.ts` by `loadProfileTools` in `src/tool/loader.ts`.
That loader uses Node's dynamic `import()` to load TypeScript files at
runtime, validates the export against the `ToolDef` contract, checks that the
tool ID matches the filename, and registers it into the global registry.

This separation means the agent's capabilities can be extended
without touching the Quark source tree. If you want a tool that queries your
company's internal API, you write a 50-line TypeScript file, drop it in
`~/.config/quark/tools/`, add the ID to your profile, and the agent has a new
hand.

---

## 2.3 Memory: Task, Sessions, Messages, Parts

> **The model has no memory. The harness must supply one — and it must survive
> a crash.**

An LLM is stateless. Every call starts fresh. If you want the model to remember
what it read three turns ago, or what tool it called, or what error it hit,
you must store that history and feed it back on the next turn. Quark's memory
model has four levels:

```text
Task → Session → Message → Part
```

Each level answers a different question:

- **Task:** what is the human trying to accomplish? One Task = one goal or
  problem space. It spans multiple sessions. It carries a description and a
  profile ID. It is created synchronously on the first user message of the
  first session and never rewritten.

- **Session:** one attempt, branch, or focused conversation inside a Task.
  A Session has a title, a working directory, a parent (for branches and
  sub-agents), a kind (`main`, `subagent`, `ephemeral`), and a frozen summary
  that gets set the first time the session branches.

- **Message:** a single user or assistant turn. Each Message has a role, a
  model ID, token counts, and a finish reason (`stop`, `tool-calls`, or
  `length`). Messages are ordered chronologically within a Session.

- **Part:** the atomic unit of streaming history. A Part can be text, a tool
  call, a tool result, a reasoning block, a step boundary, an image, or a
  summary. Parts are the real unit of replay — Messages are reconstructed
  from their Parts during load.

### Why Parts Matter

The AI SDK streams events, not complete messages. You don't get a clean
"assistant message." You get a firehose of `text-start`, `text-delta`,
`text-end`, `tool-input-start`, `tool-input-delta`, `tool-call`,
`tool-result`, `finish-step` — and if you don't persist each one as it arrives,
you lose the ability to replay the conversation because the intermediate
states are gone.

Quark stores each event as a Part row as soon as it arrives. During replay,
Parts are grouped by message ID, pulled apart by type, and reassembled into
`ModelMessage[]` — the format the AI SDK expects. This is the job of
`toModelMessages` in `src/session/message.ts`. It handles multi-modal content,
reasoning blocks, tool calls with results, and compaction anchors (old
messages replaced by a summary). The conversion is direct — Quark does not
go through the SDK's `UIMessage` abstraction because Quark owns the Part
shapes and can construct `ModelMessage[]` more cleanly.

### Append-Only Storage: The JSONL Design

Quark stores sessions as JSONL files — one line per event — in
`~/.config/quark/session/<id>/session.jsonl`. Every event is a single
`JSON.stringify` call written with `O_APPEND | O_WRONLY`. No line is ever
modified or deleted.

A relational database seems the natural choice for structured conversation
data. Quark uses JSONL instead because of three properties that make it
right for this use case:

1. **Append is atomic on POSIX.** `appendFileSync` with `O_APPEND` guarantees
   that each write is a single atomic operation — no locking, no transactions,
   no corruption from concurrent writers. You can crash in the middle of a
   streaming response and every Part that made it to disk is recoverable.

2. **Replay is deterministic.** To reconstruct a session, you read the
   JSONL file line by line and fold each event into the materialized state.
   `replayEvents` in `src/storage/session-jsonl.ts` is a pure function — given
   the same event log, it always produces the same `{ session, messages, parts }`.

3. **The file is the source of truth.** You can copy it, back it up, grep it,
   pipe it through `jq`. You don't need a database client to inspect your
   conversation history.

The cost is that replay is O(events). For very long sessions, reading and
parsing the entire JSONL file on every load would be slow. Quark mitigates
this with `meta.json` — a cached `Session` envelope written atomically (write
to `.tmp`, `rename` over the real file) that carries the title, timestamps,
and other metadata needed for session listings. The TUI's `/sessions` picker
reads only `meta.json` files — it never replays a JSONL. The JSONL replay
happens only when you actually open a session.

### Ephemeral Sessions

Not every session needs to touch disk. Sub-agents that run as one-shot
processes, or quick throwaway questions, use ephemeral sessions — stored
entirely in a `Map<string, Session>` in memory and never written to the
filesystem. The `createSession` function checks the `ephemeral` flag and
routes to the in-memory store accordingly. The event bus still works. Tools
still work. The loop still runs. Nothing in the system except the storage
layer knows whether a session is ephemeral.

### Task and Branching: Continuity Across Context Boundaries

A Task is the container that holds multiple Sessions together. When the
agent's context gets too full — when the conversation history approaches
the model's context window limit — Quark doesn't just truncate. It branches:

1. The parent session's messages are split into old history (to summarize)
   and recent context (to replay directly into the child).
2. The old history is fed to the model with a prompt that asks for a
   structured summary: relevant files and a continuation context.
3. A new child Session is created under the same Task, seeded with the
   summary as a user message, the recent messages replayed, and (optionally)
   a user-provided steer prompt appended.

The parent's summary is frozen the first time it branches. Every subsequent
child branch inherits the same parent summary — siblings share a common
understanding of where they came from. This is the `createBranch` function in
`src/session/branch.ts`. It is not aggressive. It only triggers when the
input tokens exceed 90% of the model's context window (configurable via
`branching.threshold` in `config.yaml`).

The Task is the glue. It lets you ask "what have we done on this problem?"
across multiple sessions and branches. It lets you switch between branches
without losing the big picture. And it costs almost nothing — a single row
in `src/task/task.ts` created synchronously on the first user message.

---

## 2.4 The Brain: Provider Resolution

> **A harness is only as flexible as the model string it can resolve.**

Quark's initial goal was model agnosticism. The long-term interest is pushing
local LLMs harder by improving the harness around them. But to make Quark
useful enough to build Quark, I first needed OpenAI-compatible providers.
Copilot came next because I already had access to it, and it exposed a few
provider-specific scars worth telling.

### The `provider/model` Convention

Every model in Quark is specified as `provider/model`. The string
`copilot/gpt-4o` means "use the `copilot` provider, model `gpt-4o`."
`openai/gpt-4o` means "use the `openai` provider." `ollama/llama3.2` means
"use the local Ollama instance." The convention is enforced at the config
level — `parseModelSpec` in `src/config/config.ts` splits on the first `/`
and rejects bare model names:

```typescript
const parsed = parseModelSpec("copilot/gpt-4o")
// → { provider: "copilot", model: "gpt-4o" }
```

### The Resolver

`resolveModel` in `src/provider/resolver.ts` is a 83-line function that turns
a model spec string into an AI SDK `LanguageModel` object. It handles three
cases:

1. **Copilot.** This is the special case. Copilot uses GitHub's OAuth device
   flow — you run `scripts/copilot-login.ts`, paste a code at a URL, and a
   token is saved to `~/.config/quark/copilot-token.json`. The resolver reads
   that token, attaches it to a custom `fetch` function (via
   `src/provider/copilot-fetch.ts`), and feeds it to
   `createOpenAICompatible()` with Copilot's base URL. The model string —
   `gpt-4o`, `claude-sonnet-4.5`, etc. — is passed through to the API.

2. **Known providers (openai, anthropic).** These get their own SDK
   constructors: `createOpenAI()` or `createAnthropic()`. API keys are
   resolved from the config file, which supports both literal values and
   `env:VAR_NAME` references.

3. **Everything else.** Any unknown provider ID is assumed to be an
   OpenAI-compatible API. Quark reads the `baseURL` and `apiKey` from
   `config.yaml` under `providers:`, resolves the key, and calls
   `createOpenAICompatible()`. This means any local model server — Ollama,
   LM Studio, vLLM, llama.cpp's server mode — is a one-line config entry.

Plugin hooks (`provider.request.before` and `provider.request.error`) let
plugins intercept and modify the provider/model resolution before and after
the request. A plugin can rewrite the model string mid-flight, swap providers
on error, or add custom headers. The resolver calls `fireHook` before
returning the model object, so plugins see the same provider/model pair the
rest of the system uses.

### Provider-Specific Scars: Copilot

Copilot is not a standard OpenAI-compatible API. It uses GitHub's OAuth device
flow instead of API keys. Its fetch layer needs to refresh tokens, handle
GitHub-specific error responses, and set the `editor-version` and
`editor-plugin-version` headers that Copilot expects. The custom fetch in
`src/provider/copilot-fetch.ts` wraps every outgoing request with automatic
token injection and Copilot-specific header handling.

This is the kind of thing that makes provider abstraction leak. The resolver
presents a uniform interface — `resolveModel("copilot/gpt-4o")` works exactly
like `resolveModel("openai/gpt-4o")` — but the Copilot path is 20 lines of
special-case code. The harness philosophy says: isolate that special case in
the resolver, don't let it leak into the loop, and document it so the next
person who adds a weird provider knows where to put their special-case code.

### Model Limits

Every model has limits — context window, max output tokens, sometimes an
input token cap. Quark reads these from a static data source via
`getModelLimit()` in `src/provider/models.ts`. The loop uses the context window
to decide when to branch. The TUI uses it to render the token usage bar. These
limits are not hardcoded into the resolver — they are queried after the model
is resolved, because different Copilot models have different limits and the
user should not have to configure them manually.

---

## 2.5 The Loop: Turning One Response Into An Agent

> **One call to the model is a completion. Many calls, with tools between them,
> is an agent.**

The loop is where everything comes together. It lives in `src/session/prompt.ts`
and `src/session/processor.ts`. Together they are about 900 lines of code —
approximately the length of this chapter so far. Here is the entire loop,
stripped of error handling and branching:

```typescript
while (true) {
  const messages = loadMessages(sessionId)
  const modelMessages = toModelMessages(messages, parts)
  const system = buildSystem(agent)
  const tools = resolveToolSet(agent, sessionId, messageId, abort)
  const result = await processStream({ model, system, messages: modelMessages, tools, ... })
  if (result === "continue") continue  // model called tools, loop again
  break                                 // model said stop
}
```

That is the skeleton. The flesh is what makes it reliable.

### The Entry Point: `prompt()`

`prompt()` in `src/session/prompt.ts` is the public API. It accepts a user
message (with optional images), creates or resumes a session, saves the user
message, initializes the task if this is the first message, and enters the
loop. It returns a `{ sessionId }` so the caller knows where the conversation
landed.

The function is straightforward, but it enforces several invariants:

1. **Session creation is lazy.** If you pass a `sessionId`, Quark resumes it.
   If you don't, a new session is created. No session exists until the first
   message is sent.

2. **Task assignment is synchronous and idempotent.** `initializeSessionFromMessage`
   in `src/session/initializer.ts` generates a fallback title from the first
   line of the user's message, creates a Task, and links the session to it via
   `taskId`. This runs synchronously so the task ID is guaranteed to exist
   before any subsequent action (like `/steer`) tries to use it. A follow-up
   LLM call (`upgradeSessionTitle`) refines the title asynchronously, but it
   never touches `taskId`.

3. **Abort controllers are tracked per session.** The `active` map in
   `prompt.ts` stores one `AbortController` per running session. If the user
   presses Escape in the TUI, `cancel(sessionId)` calls `controller.abort()`,
   which propagates through the LLM stream and all active tool calls.

### The Driver: `loop()`

`loop()` is the `while(true)` block. It:

1. Resolves the model (with thinking provider options if applicable).
2. Loads the conversation history and converts it to `ModelMessage[]`.
3. Checks for auto-branching (context too close to the window limit).
4. Creates an assistant message row.
5. Resolves the tool set for this iteration.
6. Calls `processStream()` and inspects the result.

The result is one of three values: `"continue"` (the model called tools, loop
again), `"stop"` (the model finished), or `"branch"` (the context overflowed
mid-stream and the loop should branch and continue). The `max_steps` config
value (default 10) prevents runaway loops — if the model gets stuck in a
tool-call cycle, the loop stops after 10 iterations.

### The Stream Processor: `processStream()`

`processStream()` in `src/session/processor.ts` is the largest single function
in the codebase — 470 lines that convert an AI SDK stream into persisted Parts
and emitted events. It:

1. Calls `streamText()` from the AI SDK.
2. Iterates over `fullStream` events — text deltas, tool calls, tool results,
   step boundaries, reasoning blocks, errors.
3. For each event, persists the data as a Part (via `addPart` or `updatePart`),
   emits a typed event to the bus (so the TUI can update in real time), and
   tracks the current state (which text part is accumulating, which tool calls
   are pending).
4. When the stream finishes, checks the `finishReason` — `"tool-calls"` means
   another iteration, `"stop"` means the model is done.
5. Handles errors with retry logic: retryable errors (429, 5xx, timeouts) get
   exponential backoff, context-too-long errors trigger branching, and fatal
   errors propagate to the caller.

The retry logic in `src/session/retry.ts` is worth examining. It classifies
errors by HTTP status code and message patterns. Retryable errors get up to
five attempts with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s
with jitter). It respects `retry-after` and `x-ratelimit-reset` headers from
providers. And it has a special case: if a server returns a retry delay over
five minutes (e.g. a monthly quota reset), the error is surfaced immediately
rather than making the user wait.

### The Event Bus: Decoupling the Loop from the UI

The processor does not know about the TUI. It does not import any TUI
components. It emits typed events to a singleton bus — `src/session/events.ts`
— and whatever is listening decides what to do with them.

The bus carries ~30 event types: `text-delta`, `tool-start`, `tool-end`,
`reasoning-delta`, `permission-request`, `error`, `context-too-long`,
`loop-start`, `loop-end`, and so on. Each event payload is a typed interface.
The bus itself is a wrapper around Node's `EventEmitter`:

```typescript
bus.emit("text-delta", { sessionId, messageId, partId, delta, text })
```

This decoupling means the `processStream` function can
be called from the TUI (where events update React components), from the CLI
(where events print to stdout), from the ACP server (where events are
forwarded over WebSocket), and from tests (where events are captured for
assertions) — all without changing a line of the loop. The loop does one
thing: it produces a stream of typed events. How those events are consumed
is someone else's problem.

---

## 2.6 Implementation Scars

> **Show the scars. If the implementation were clean, the problem was too
> easy.**

Every agent harness has parts that don't fit neatly into any architectural
diagram. Three are worth documenting — each one evidence of the system
colliding with reality.

### Copilot's Custom Fetch

As noted in Section 2.4, Copilot uses OAuth device flow instead of API keys.
The resolver isolates this in `src/provider/copilot-fetch.ts`, but the
isolation is not perfect. The custom fetch wraps every outgoing request, and
because Copilot is built on the Azure OpenAI API, some responses carry
opaque Copilot-specific part IDs that the AI SDK can't parse. The processor
handles these with a targeted suppression:

```typescript
case "error": {
  const errMsg = String(event.error)
  if (/text part .+ not found/.test(errMsg)) break  // Copilot artifact, ignore
  throw event.error
}
```

This is a one-line special case that suppresses a known benign error from a
specific provider. It is ugly. It is also correct — suppressing that error
lets the stream continue, and the alternative (crashing on a non-fatal
artifact) would make Copilot sessions unreliable. The rule is: special-case
code belongs in the provider layer when possible, and in the processor only
when the provider layer can't catch it. This one falls in the second category.

### Context-Too-Long Mid-Stream

The model doesn't always know when its context is about to overflow. Sometimes
it streams through a full response and then, on the next tool call, the
provider rejects the request because the prompt is too large. But sometimes
it overflows *mid-stream* — the `finish-step` event reports an input token
count that exceeds the branching threshold before the next tool round even
begins.

The processor handles this with a `needsBranch` flag. When a `finish-step`
event reports input tokens over the threshold, the flag is set, the stream
loop breaks, and `processStream` returns `"branch"` instead of `"continue"`.
The outer loop then creates a branch and continues from the child session.

This is subtle because branching mid-stream means the current assistant message
is left incomplete — it called tools but those tools never ran in the new
session. The branch carries forward a summary of the old context, so the model
can pick up where it left off, but the old message's tool calls are orphaned.
This is correct behavior: replaying orphaned tool calls into a branch with a
fresh summary would be nonsensical.

### Append-Only Storage and the `updatePart` Problem

JSONL is append-only, which means you cannot modify a line once it is written.
But the processor needs to update Parts — a tool part starts as `"pending"`,
then moves to `"awaiting_approval"`, then `"running"`, then `"completed"` or
`"error"`. A text part starts empty and accumulates deltas.

The solution is to append a *new* PartEvent with the same `partId`. During
replay, `replayEvents` uses a `Map<string, PartRow>` keyed by `partId`, so
later events with the same ID overwrite earlier ones. The function is called
`updatePart`, but it is really `appendPartSnapshot` — it writes a new line
with the latest state.

This means the JSONL file grows faster than a database would. Every text delta
does not write a new line (the processor batches text in memory and only
persists on `text-end`), but tool state transitions do produce multiple lines
for the same logical Part. The tradeoff is accepted because disk is cheap and
the append-only design eliminates locking. If you ever need to reclaim space,
you can rebuild the file by replaying it into a new JSONL and discarding the
intermediate snapshots — but in practice, this has not been necessary.

---

## 2.7 Transition To Chapter 3

> **Once the core loop works, the next problem appears: if every agent sees
> every tool, every skill, and every instruction, the context becomes noisy
> before the task even starts.**

By this point, you have seen Quark's agent core built from the inside:

- **Tools** give the model hands — a universal contract, a registry, and an
  adapter that layers on permissions, validation, and undo snapshots.
- **Memory** gives the loop continuity — four levels from Task to Part, stored
  as append-only JSONL, replayed into the model's message format on each
  iteration.
- **The provider resolver** gives the harness a brain — a single function that
  turns `copilot/gpt-4o` or `ollama/llama3.2` into a callable model, with
  plugin hooks for interception.
- **The loop** turns one call into an agent — a `while(true)` block that loads
  history, calls the model, runs tools, persists everything as events, and
  decides whether to continue, stop, or branch.
- **The event bus** decouples the core from the UI — the processor emits typed
  events; the TUI, CLI, and ACP server consume them independently.

What you do not yet have is **context isolation**. The agent core described in
this chapter assumes a single identity — one system prompt, one tool set, one
skill set. But a real coding agent needs to be a coder sometimes, a researcher
other times, and a tester still other times. A coding agent should not carry
100 tools it will never call. A research agent should not carry shell and edit
tools by default. A tester agent should not need web-search descriptions
unless testing demands them.

Limiting what each agent sees keeps the context lean and the model focused.
Chapter 3 introduces profiles:
bounded agent identities that declare exactly what tools, skills, and
instructions they need — and nothing more.
