---
title: ACP Agent Implementation — Make Quark an ACP-Compliant Coding Agent
date_created: 2026-05-17
date_modified: 2026-05-17
revision: 3
history:
  - 2026-05-17: Initial assessment + phased implementation plan
  - 2026-05-17: Cached ACP reference docs; added inline doc references
  - 2026-05-17: Moved spec + docs into specs/acp-implementation/ folder
status: draft
---

# ACP Agent Implementation

Make Quark speak the [Agent Client Protocol](https://agentclientprotocol.com) so any
ACP-compatible editor (Zed, JetBrains, Neovim, Emacs) can drive Quark as its
coding agent — with zero editor-specific integration.

> **Reference docs**: The full ACP specification pages are cached locally in
> [`acp-docs/`](acp-docs/README.md). These are authoritative for the
> implementation. Key pages are referenced inline throughout this spec using
> `→ acp-docs/` links.

---

## 1. Problem

Quark today has three interfaces: one-shot CLI (`quark --prompt "..."`), interactive
TUI (`quark` with no prompt), and a REST+WebSocket web server. None speak ACP.
Editors that support ACP (Zed, JetBrains, Neovim, Emacs) cannot use Quark as
their agent unless someone writes a bespoke adapter per editor.

ACP is the **LSP of AI agents** — one protocol, N editors × M agents instead of
N × M bespoke integrations. Supporting ACP makes Quark available to every ACP
editor immediately, and lets Quark users pick their editor freely.

---

## 2. Quark ↔ ACP Mapping

Quark's architecture maps well to ACP concepts. The table below shows what
already exists vs. what must be built.

| ACP Concept | Quark Equivalent | Status |
|---|---|---|
| Agent identity (`agentInfo`) | `AgentConfig` (id, name) from profile | **Exists** |
| Session (`sessionId`) | `Session.id` from `createSession()` | **Exists** |
| Session creation (`session/new`) | `createSession()` | **Exists** |
| Session loading (`session/load`) | `getSession()` + `loadMessages()` | **Exists** (needs replay mechanism) |
| Prompt turn (`session/prompt`) | `prompt()` + `loop()` | **Exists** |
| Cancel (`session/cancel`) | `cancel()` with `AbortController` | **Exists** |
| Streaming text updates (`agent_message_chunk`) | Event bus: `text-delta` | **Exists** |
| Tool calls + status | Event bus: `tool-start` → `tool-end` | **Exists** (needs status mapping) |
| Permission request (`session/request_permission`) | Permission system: `ask()` | **Exists** |
| Tool registry / schemas | `ToolDef` with Zod `parameters` | **Exists** |
| File system access | `read`, `write`, `edit` tools | **Exists** |
| Terminal access | `bash` tool | **Exists** |
| MCP server connections | Already supported via tools | **Exists** (can be wired at session level) |
| **JSON-RPC 2.0 transport** | — | **Missing** |
| **ACP type definitions (Zod schemas)** | — | **Missing** |
| **ACP entry mode (`quark acp`)** | — | **Missing** |
| **Bidirectional client callbacks** | — | **Missing** |
| **Capability negotiation** | — | **Missing** |
| **ContentBlock types (Image, Resource, etc.)** | Basic `{type,text}` parts only | **Missing** |
| **Tool call status model (pending→in_progress→done)** | Binary start/end events | **Partial** |
| **Plans (`Plan` / `PlanEntry`)** | — | **Missing** |
| **Session replay as stream** | JSONL storage works, no replay API | **Missing** |

---

## 3. Architecture Decisions

### 3.1 Transport: JSON-RPC 2.0 over stdio

> → [acp-docs/02-overview.md](acp-docs/02-overview.md) — Communication Model, Message Flow

ACP's primary transport is JSON-RPC 2.0 over stdin/stdout. The process model:

```
┌──────────────────┐     stdin (JSON-RPC)     ┌──────────────────┐
│  ACP Editor      │◄────────────────────────▶│  Quark (ACP mode)│
│  (Zed, JetBrains)│                          │  quark acp       │
└──────────────────┘                          └──────────────────┘
```

- Quark runs as a long-lived subprocess spawned by the editor
- Reads JSON-RPC requests line-by-line from stdin
- Writes JSON-RPC responses and notifications to stdout
- Logs go to stderr (never stdout — that breaks JSON-RPC)

**Decision**: Use a lightweight internal JSON-RPC dispatcher (not a framework).
The protocol is small (~8 methods total) and hand-rolling avoids dependency
weight. Type safety comes from Zod schemas, not a library.

### 3.2 Codec: NDJSON or framed?

ACP uses raw JSON-RPC objects on stdin/stdout. The spec doesn't mandate a
framing protocol — it's one JSON object per line (NDJSON semantics). Quark's
JSON-RPC handler reads/writes one line at a time.

**Decision**: Use NDJSON (newline-delimited JSON). Simple, debuggable, standard
for stdio protocols (MCP, LSP, and ACP all use this).

### 3.3 Client Callbacks: `Agent → Client` method calls

> → [acp-docs/02-overview.md](acp-docs/02-overview.md) — Client methods
> → [acp-docs/07-tool-calls.md](acp-docs/07-tool-calls.md) — Requesting Permission
> → [acp-docs/10-file-system.md](acp-docs/10-file-system.md) — File system methods
> → [acp-docs/11-terminals.md](acp-docs/11-terminals.md) — Terminal methods

ACP is bidirectional: the agent calls methods on the client (editor) too:

- `session/request_permission` — ask user to authorize a tool
- `fs/read_text_file` / `fs/write_text_file` — delegate file I/O to editor
- `terminal/create`, `terminal/output`, etc. — delegate terminal to editor

**Decision**: Quark tools already handle file I/O and terminal execution
internally. The permission system already gates tool execution. Strategy:

- **Phase 1**: Advertise NO client capabilities. Quark handles everything
  internally (files, terminal, permissions). This is the simplest path.
- **Phase 2+**: If the client advertises capabilities, Quark MAY delegate
  to the editor. For example, if the editor says `fs.readTextFile: true`,
  the `read` tool could call `fs/read_text_file` on the client instead of
  reading from disk directly. This respects the editor's workspace model.

### 3.4 Entry Point

A new CLI mode: `quark acp`

```
quark acp [--profile <name>]
```

- Reads `QUARK_ACP=1` env var (set by editors when spawning)
- Long-running process — does not exit after each turn
- Handles multiple sessions concurrently? **Decision: No.** One agent process =
  one ACP connection. The editor spawns one Quark per workspace. Session
  multiplexing is handled by the editor (multiple `session/new` calls).

### 3.5 Tool Call Status Mapping

ACP requires explicit tool call status: `pending` → `in_progress` → `completed` | `error`.
Quark's event bus currently emits:

```
tool-start → tool-input → tool-end (status: "completed" | "error")
```

Mapping:

| Quark Event | ACP Status | ACP `sessionUpdate` |
|---|---|---|
| `tool-start` | `pending` | `tool_call` |
| `tool-input` | — (input detail, no status change) | — (embedded in initial or as metadata) |
| `tool-running` (after input) | `in_progress` | `tool_call_update` |
| `tool-end` (completed) | `completed` | `tool_call_update` |
| `tool-end` (error) | `error` | `tool_call_update` |

**Decision**: Add a `tool-running` event emission in the processor once input
is resolved and execution begins. This is a one-line change — the processor
already knows when input is resolved. Currently `tool-input` fires and the tool
executes synchronously, so `tool-running` can fire immediately after input.

### 3.6 Session Replay

ACP's `session/load` requires replaying the full conversation history as
`session/update` notifications BEFORE responding to the request.

Quark stores messages in JSONL format with typed parts. The replay:

1. Load all messages + parts via `loadMessages(sessionId)`
2. For each message, emit `session/update` notifications:
   - User messages → `user_message_chunk`
   - Assistant text parts → `agent_message_chunk`
   - Tool calls → `tool_call` + `tool_call_update` (completed/error)
   - Reasoning parts → `agent_message_chunk` with `thinking` type
3. After all messages streamed, respond to `session/load` with `{ result: null }`

**Decision**: Build a `replaySession(sessionId, send)` function that iterates
through stored messages and calls the `send` callback for each update. This
is purely a transformation layer over existing storage.

### 3.7 Capability Negotiation

> → [acp-docs/03-initialization.md](acp-docs/03-initialization.md) — Capabilities
> → [acp-docs/09-extensibility.md](acp-docs/09-extensibility.md) — Custom capabilities

Quark advertises a fixed set of capabilities at `initialize` time:

```json
{
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {
      "image": true,
      "embeddedContext": true
    },
    "mcpCapabilities": {
      "http": true
    },
    "sessionCapabilities": {
      "resume": {},
      "close": {}
    }
  }
}
```

**Decision**: Start with a conservative set. `loadSession: true` because Quark
persists everything. `image: true` because the prompt pipeline already supports
images. `embeddedContext: true` for file:// resource blocks. `mcpCapabilities.http: true`
because Quark supports MCP via HTTP transport. `sessionCapabilities.resume` and
`close` for robustness. All can be made configurable later.

### 3.8 Content Blocks

> → [acp-docs/06-content.md](acp-docs/06-content.md) — All ContentBlock types

ACP uses structured `ContentBlock[]` for prompts:

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: "resource_link"; uri: string; name: string; ... }
```

Quark's `prompt()` currently accepts `parts: { type: "text"; text: string }[]`
and `images: { mime: string; data: string }[]`. These map cleanly to ACP
content blocks. `Resource` and `ResourceLink` would be new additions.

**Decision**: Extend the internal `prompt()` API to accept `ContentBlock[]`
as an alternative to the current `parts` + `images` split. The existing
`parts`/`images` API continues to work; ACP mode uses the new unified format.

---

## 4. Phased Implementation Plan

### Phase 1: Core Transport & Lifecycle (Week 1-2)

**Goal**: `quark acp` launches, answers `initialize`, creates sessions, and
processes `session/prompt` for text-only prompts. Tool calls stream back as
updates. `session/cancel` works.

**Deliverables**:

| # | Task | New Files | Modified Files |
|---|---|---|---|
| 1.1 | **ACP Zod schemas** — define all ACP types as Zod schemas. See [acp-docs/14-schema-reference.md](acp-docs/14-schema-reference.md) for the full type catalog and [schema/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json) for the canonical JSON Schema. | `src/acp/schema.ts` | — |
| 1.2 | **JSON-RPC transport** — `readMessage(stream)` and `writeMessage(stream, msg)` using NDJSON. See [acp-docs/02-overview.md](acp-docs/02-overview.md). | `src/acp/transport.ts` | — |
| 1.3 | **ACP agent core** — implements agent-side methods. See [acp-docs/02-overview.md](acp-docs/02-overview.md) (Agent methods), [acp-docs/03-initialization.md](acp-docs/03-initialization.md) (initialize), [acp-docs/04-session-setup.md](acp-docs/04-session-setup.md) (session/new, session/load), [acp-docs/05-prompt-turn.md](acp-docs/05-prompt-turn.md) (session/prompt, session/cancel). | `src/acp/agent.ts` | — |
| 1.4 | **Event → ACP notification bridge** — translates bus events to `session/update` notifications. See [acp-docs/05-prompt-turn.md](acp-docs/05-prompt-turn.md) (Agent Reports Output), [acp-docs/07-tool-calls.md](acp-docs/07-tool-calls.md) (tool_call + tool_call_update). | `src/acp/bridge.ts` | — |
| 1.5 | **`quark acp` CLI entry** — new subcommand that starts the JSON-RPC loop, reads from stdin, dispatches to agent, writes to stdout. Exits on stdin close or editor disconnect. | `src/acp/entry.ts` | `src/cli.ts` |
| 1.6 | **Tool call acknowledgment** — emit `tool-running` event in processor after input resolution, so ACP bridge can send `in_progress` status before the tool actually finishes. | — | `src/session/processor.ts` |

**Tests**:

- `test/acp/transport.test.ts` — NDJSON encode/decode, JSON-RPC framing
- `test/acp/schema.test.ts` — Zod schema validation for all ACP types
- `test/acp/agent.test.ts` — initialize, session/new, session/prompt (mock editor)
- `test/acp/bridge.test.ts` — event → notification mapping

**Manual Integration Test**:

Run `quark acp` in a terminal, pipe JSON-RPC messages manually, verify responses:

```bash
echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{...}}' | quark acp
```

---

### Phase 2: Rich Content & Permissions (Week 3)

**Goal**: Image prompts work. Permission requests flow through the editor.
Session loading works. Full content block parity.

**Deliverables**:

| # | Task | New Files | Modified Files |
|---|---|---|---|
| 2.1 | **Content block handling** — parse ACP `ContentBlock[]` into Quark's internal format. See [acp-docs/06-content.md](acp-docs/06-content.md). | — | `src/acp/agent.ts` |
| 2.2 | **Permission bridge** — emit `session/request_permission` to client, await response. See [acp-docs/07-tool-calls.md](acp-docs/07-tool-calls.md) (Requesting Permission). | `src/acp/permission-bridge.ts` | `src/acp/agent.ts` |
| 2.3 | **Session load with replay** — replay stored messages as `session/update` notifications. See [acp-docs/04-session-setup.md](acp-docs/04-session-setup.md) (Loading Sessions), [acp-docs/05-prompt-turn.md](acp-docs/05-prompt-turn.md). | `src/acp/replay.ts` | `src/acp/agent.ts` |
| 2.4 | **Plans** — convert model output to ACP `Plan`/`PlanEntry`. See [acp-docs/08-agent-plan.md](acp-docs/08-agent-plan.md). | — | `src/acp/bridge.ts` |
| 2.5 | **Client capabilities integration** — delegate file I/O and terminal to editor when capabilities advertised. See [acp-docs/10-file-system.md](acp-docs/10-file-system.md), [acp-docs/11-terminals.md](acp-docs/11-terminals.md). | — | `src/tool/read.ts`, `src/tool/bash.ts` |

**Tests**:

- `test/acp/content-blocks.test.ts` — text, image, resource, resource_link parsing
- `test/acp/permission-bridge.test.ts` — request → wait → response flow
- `test/acp/replay.test.ts` — message loading + notification streaming

---

### Phase 3: Polish & Ecosystem (Week 4)

**Goal**: Quark appears in the ACP Registry. Tested against real editors.
Documentation. Edge cases handled.

**Deliverables**:

| # | Task | Notes |
|---|---|---|
| 3.1 | **Registry entry** — create entry in ACP Registry so editors can discover Quark | `acp-registry` PR |
| 3.2 | **Editor smoke tests** — test `quark acp` against Zed, JetBrains, and Neovim ACP plugins | Manual |
| 3.3 | **Error resilience** — handle malformed JSON-RPC, missing fields, protocol version mismatch gracefully. Never crash the process on a bad message. | `src/acp/transport.ts`, `src/acp/agent.ts` |
| 3.4 | **ACP mode documentation** — README section + `quark acp --help` | `README.md`, `src/acp/entry.ts` |
| 3.5 | **ACP-specific config** — `acp:` section in `quark.yaml` for capability overrides, auth method configuration, model defaults for ACP sessions | `src/config/config.ts` |
| 3.6 | **Stderr logging** — all debug/info output goes to stderr so stdout stays clean JSON-RPC | All `src/acp/*.ts` |

---

## 5. File Layout

```
src/acp/
├── schema.ts            # All ACP Zod type definitions
├── transport.ts         # JSON-RPC 2.0 over NDJSON (read/write)
├── agent.ts             # ACP agent implementation (method handlers)
├── bridge.ts            # Event bus → session/update notification bridge
├── permission-bridge.ts # Permission system → session/request_permission
├── replay.ts            # Session replay for session/load
├── content.ts           # ACP ContentBlock ↔ Quark parts conversion
└── entry.ts             # quark acp entry point
```

No new dependencies. Everything built on top of existing Quark internals.

---

## 6. Acceptance Criteria

### Phase 1 ACC

- [ ] `quark acp` starts and listens on stdin
- [ ] Responds correctly to `initialize` with protocol version and capabilities
- [ ] `session/new` creates a Quark session, returns `sessionId`
- [ ] `session/prompt` with text content processes through agent loop, streams `agent_message_chunk` updates, returns `stopReason: "end_turn"` on completion
- [ ] Tool calls during prompt turn emit `tool_call` + `tool_call_update` notifications with correct status transitions (pending → in_progress → completed/error)
- [ ] `session/cancel` notification aborts the running turn, prompt responds with `stopReason: "cancelled"`
- [ ] `session/load` replays stored conversation and responds successfully
- [ ] Multiple sequential `session/prompt` calls on the same session build on previous context
- [ ] Process exits cleanly on stdin close (EOF)
- [ ] All output to stdout is valid JSON-RPC 2.0 — no stray text, logs, or errors on stdout

### Phase 2 ACC

- [ ] Image content blocks in `session/prompt` are forwarded to the LLM correctly
- [ ] Resource blocks (inline file:// content) are parsed and included in prompt
- [ ] Permission requests during tool execution emit `session/request_permission` to client
- [ ] `session/load` replays complete conversation including tool calls, images, and reasoning
- [ ] Plans extracted from model output are emitted as `sessionUpdate: "plan"`
- [ ] When client advertises `fs.readTextFile`, Quark delegates file reads to the editor
- [ ] When client advertises `terminal`, Quark delegates shell execution to the editor

### Phase 3 ACC

- [ ] Quark is listed in the ACP Registry
- [ ] Tested manually against at least 2 ACP editors (Zed + one other)
- [ ] Malformed JSON-RPC messages don't crash the process — error response is returned
- [ ] Protocol version mismatch returns correct error, doesn't crash
- [ ] `quark acp --help` shows usage
- [ ] `src/acp/` code has ≥80% test coverage

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| JSON-RPC on stdio is fragile (stray output breaks parsing) | High | All debug/log output goes to stderr. Validate in transport layer — reject non-JSON lines with error response. |
| Concurrent sessions (editor sends prompts for session A while session B is running) | Medium | Phase 1: queue prompts per session. If a turn is in progress for session X, queue new prompts for X and respond "busy" for others. Phase 2: support concurrent sessions with separate abort controllers. |
| ACP spec evolves (Quark implements v0.13, spec hits v0.14 with breaking changes) | Low | Protocol version negotiation handles this. Schema version is pinned. Minor updates are additive. |
| Permission system deadlock (editor never responds to `session/request_permission`) | Medium | Add timeout (configurable, default 120s). Timeout → deny the permission, cancel the turn. |
| Sub-agent spawning in ACP mode — how does child process inherit ACP connection? | Low | Phase 1: sub-agents spawn as separate ACP connections? Or run internally and emit `session/update` for their activity. Decision deferred to Phase 2. |

---

## 8. Out of Scope (for v1)

- **Remote agents** (HTTP/WebSocket transport) — ACP spec work in progress, revisit when stable
- **`session/resume`** — skip replay. Phase 1 does `session/load` (with replay) which is more useful.
- **Custom `_meta` extensions** — no custom capabilities or methods beyond the spec baseline
- **Multi-modal output** (agent sending images back to editor) — text-only output for v1
- **Unstable features** (`nes/*`, advanced auth) — stable spec only

---

## 9. References

All ACP specification pages are cached locally in [`acp-docs/`](acp-docs/README.md):

| Page | File | Used In |
|---|---|---|
| Introduction | [01-introduction.md](acp-docs/01-introduction.md) | §1 Problem |
| Protocol Overview | [02-overview.md](acp-docs/02-overview.md) | §3.1 Transport, §3.3 Client Callbacks, Phase 1 |
| Initialization | [03-initialization.md](acp-docs/03-initialization.md) | §3.7 Capability Negotiation, Phase 1 |
| Session Setup | [04-session-setup.md](acp-docs/04-session-setup.md) | §3.6 Session Replay, Phase 1, Phase 2 |
| Prompt Turn | [05-prompt-turn.md](acp-docs/05-prompt-turn.md) | §3.5 Tool Status, Phase 1 |
| Content Blocks | [06-content.md](acp-docs/06-content.md) | §3.8 Content Blocks, Phase 2 |
| Tool Calls | [07-tool-calls.md](acp-docs/07-tool-calls.md) | §3.3 Client Callbacks, §3.5 Tool Status, Phase 2 |
| Agent Plan | [08-agent-plan.md](acp-docs/08-agent-plan.md) | Phase 2 |
| Extensibility | [09-extensibility.md](acp-docs/09-extensibility.md) | §3.7 Capability Negotiation |
| File System | [10-file-system.md](acp-docs/10-file-system.md) | §3.3 Client Callbacks, Phase 2 |
| Terminals | [11-terminals.md](acp-docs/11-terminals.md) | §3.3 Client Callbacks, Phase 2 |
| Session Modes | [12-session-modes.md](acp-docs/12-session-modes.md) | Out of scope (future) |
| Slash Commands | [13-slash-commands.md](acp-docs/13-slash-commands.md) | Out of scope (future) |
| Schema Reference | [14-schema-reference.md](acp-docs/14-schema-reference.md) | Phase 1 (type definitions) |

**Upstream sources**:
- GitHub: [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)
- Canonical JSON Schema: [schema/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json)
- Spec site: [agentclientprotocol.com](https://agentclientprotocol.com)
