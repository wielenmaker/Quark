# Quark ACP Integration Guide

How to build an editor/IDE plugin that talks to Quark via the
[Agent Client Protocol](https://agentclientprotocol.com).

## 1. Overview

Quark speaks ACP as a subprocess over **stdin/stdout**. The wire format is
**JSON-RPC 2.0** with one message per line (**NDJSON**). The editor spawns
Quark, and they communicate bidirectionally:

```
Editor (client)                  Quark (agent)
      │                                │
      │── initialize ────────────────→│
      │←─ capabilities + agentInfo ───│
      │                                │
      │── session/new ───────────────→│
      │←─ sessionId + modes + models ─│
      │                                │
      │── session/prompt ────────────→│
      │←─ session/update* (streaming) │
      │←─ result { stopReason } ──────│
      │                                │
```

Stdout is strictly JSON-RPC. Stderr is debug logs — ignore it unless
troubleshooting.

## 2. Spawning Quark

```
bun run src/cli.ts acp [--profile <id>]
```

- `--profile` / `-p` sets the default profile (mode). Falls back to the
  `default_profile` in config, then to built-in `coder`.

The process runs until stdin closes.

## 3. Wire Format

Every message is a single line of JSON. The `jsonrpc` field is always `"2.0"`.

**Request:**

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

**Response:**

```json
{"jsonrpc":"2.0","id":1,"result":{...}}
```

**Error:**

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"..."}}
```

**Notification (no id, no response expected):**

```json
{"jsonrpc":"2.0","method":"session/update","params":{...}}
```

Request IDs can be strings or integers. Match responses to pending requests by ID.

### Error Codes

| Code | Meaning |
|------|---------|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error |
| -32002 | Resource not found |

## 4. Agent Methods (Editor → Quark)

### 4.1 `initialize`

Discover capabilities. Call once at startup.

**Params:**

| Field | Type | |
|--------|------|---|
| protocolVersion | number | Must be `1` |
| clientCapabilities | object | Optional |
| clientInfo | `{name, title?, version}` | Optional |

**Result:**

| Field | Type | Notes |
|--------|------|-------|
| protocolVersion | number | `1` |
| agentCapabilities | object | See below |
| agentInfo | `{name, title?, version}` | `{"name":"quark","title":"Quark","version":"0.1.0"}` |
| authMethods | array | Always `[]` |

**agentCapabilities fields:**

```json
{
  "loadSession": true,
  "promptCapabilities": { "image": true, "embeddedContext": true },
  "mcpCapabilities": { "http": true },
  "sessionCapabilities": { "resume": {}, "close": {} }
}
```

### 4.2 `session/new`

Create a new conversation session.

**Params:**

| Field | Type | |
|--------|------|---|
| cwd | string | Working directory |
| mcpServers | array | MCP server configs (optional) |

**Result:**

| Field | Type | Notes |
|--------|------|-------|
| sessionId | string | Opaque ID — pass to session/* methods |
| configOptions | array | Model picker data |
| modes | object | Profile/mode picker data |

**configOptions** entries:

```json
[
  { "name": "model", "value": "deepseek/deepseek-v4-pro" },
  { "name": "available_models", "value": ["gpt-4o", "claude-sonnet-4", ...] }
]
```

**modes:**

```json
{
  "currentModeId": "coder",
  "availableModes": [
    { "id": "coder", "name": "Coder" },
    { "id": "finder", "name": "Finder" }
  ]
}
```

### 4.3 `session/load`

Resume an existing session. Same response shape as `session/new` (minus
`sessionId`). Quark replays the conversation history as `session/update`
notifications **before** sending the response.

**Params:** `{ sessionId, cwd, mcpServers? }`

**Result:** `{ configOptions, modes }` — same as session/new, no sessionId.

### 4.4 `session/prompt`

Send a user message and run the agent. The response only arrives after the
agent finishes its turn. Streaming output arrives via `session/update`
notifications in the meantime.

**Params:**

| Field | Type | |
|--------|------|---|
| sessionId | string | |
| prompt | ContentBlock[] | The user message (see §6) |

**Result:** `{ stopReason }` — one of `end_turn`, `cancelled`, `refusal`,
`max_tokens`, `max_turn_requests`.

### 4.5 `session/set_mode`

Switch the active profile (agent personality / tool set).

**Params:** `{ sessionId, modeId }` — modeId must be one of the IDs from
`modes.availableModes`.

**Result:** `null`. A `current_mode_update` notification is also sent.

### 4.6 `session/set_config_option`

Change a configuration value (currently only `model`).

**Params:** `{ sessionId, configOptions: [{ name, value }] }`

Set `name: "model"` to a model string to switch the LLM for the next
`session/prompt`.

**Result:** `null`. A `config_option_update` notification is also sent.

### 4.7 `session/cancel` (notification)

Interrupt a running prompt. Sent as a notification (no `id`).

**Params:** `{ sessionId }`

## 5. Session Update Notifications (Quark → Editor)

Streamed during `session/prompt`. Each has `method: "session/update"` and
a `params` object with a `sessionUpdate` discriminator.

### `agent_message_chunk`

Text delta from the assistant.

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": { "type": "text", "text": "I'll help you with that." }
}
```

### `agent_thought_chunk`

Reasoning/thinking text (from models that support reasoning).

```json
{
  "sessionUpdate": "agent_thought_chunk",
  "content": { "type": "text", "text": "Let me think about..." }
}
```

### `user_message_chunk`

Replayed user messages (only during `session/load` replay).

### `tool_call`

A tool execution started. Status is `pending`.

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call_abc123",
  "title": "read",
  "kind": "read",
  "status": "pending"
}
```

### `tool_call_update`

Status change for a tool call. Sent with `status: "in_progress"` when the tool
starts running, then `status: "completed"` or `status: "failed"` when finished.

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_abc123",
  "status": "completed",
  "content": [{ "type": "text", "text": "file contents here..." }]
}
```

### `plan`

High-level plan entries derived from tool calls. Sent whenever the plan changes.

```json
{
  "sessionUpdate": "plan",
  "entries": [
    { "content": "Read config file", "priority": "high", "status": "completed" },
    { "content": "Edit main.ts", "priority": "high", "status": "in_progress" }
  ]
}
```

### `current_mode_update`

Sent after `session/set_mode`.

```json
{ "sessionUpdate": "current_mode_update", "modeId": "finder" }
```

### `config_option_update`

Sent after `session/set_config_option`.

```json
{
  "sessionUpdate": "config_option_update",
  "configOptions": [{ "name": "model", "value": "gpt-4o-mini" }]
}
```

## 6. Content Blocks

The `prompt` parameter in `session/prompt` is an array of content blocks.

### `text`

```json
{ "type": "text", "text": "What does this file do?" }
```

### `image`

```json
{
  "type": "image",
  "data": "<base64>",
  "mimeType": "image/png"
}
```

### `resource` (embedded file content)

```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///path/to/main.ts",
    "text": "console.log('hello')"
  }
}
```

### `resource_link` (pointer to a file)

```json
{
  "type": "resource_link",
  "uri": "file:///path/to/main.ts",
  "name": "main.ts"
}
```

## 7. Permissions

When a tool needs approval, Quark sends a `session/request_permission` request
to the editor. The editor must respond.

**Request from Quark:**

```json
{
  "jsonrpc": "2.0",
  "id": "perm-1",
  "method": "session/request_permission",
  "params": {
    "sessionId": "...",
    "toolCall": { "toolCallId": "...", "title": "bash", "kind": "execute" },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "allow-always", "name": "Allow always", "kind": "allow_always" },
      { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
    ]
  }
}
```

**Editor responds:**

```json
{ "jsonrpc": "2.0", "id": "perm-1", "result": { "outcome": "selected", "optionId": "allow-once" } }
```

Or to dismiss: `{ "outcome": "cancelled" }`.

## 8. Minimal Example

Here's a complete conversation that sends one message and prints the response:

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"my-editor","version":"0.1"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{...},"agentInfo":{"name":"quark","title":"Quark","version":"0.1.0"},"authMethods":[]}}

→ {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/path/to/project"}}
← {"jsonrpc":"2.0","id":2,"result":{"sessionId":"abc123","configOptions":[...],"modes":{...}}}

→ {"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"abc123","prompt":[{"type":"text","text":"What files are in this directory?"}]}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"bash","kind":"execute","status":"pending"}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"plan","entries":[{"content":"bash","priority":"high","status":"in_progress"}]}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","content":[{"type":"text","text":"..."}]}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"You have these files: ..."}}}
← {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

## 9. Profile Configuration

Profiles are defined in `.quark/config.yaml` (project) or
`~/.config/quark/config.yaml` (global). Each profile has its own system
prompt, tool set, and skills. Profiles are exposed to the editor as ACP modes.

```yaml
# ~/.config/quark/config.yaml
default_profile: coder
models:
  - gpt-4o
  - claude-sonnet-4
  - deepseek/deepseek-v4-pro
main_model: deepseek/deepseek-v4-pro

profiles:
  coder:
    name: Coder
    prompt_file: coder.md
    tools: [read, write, edit, bash, skill, todo]

  finder:
    name: Finder
    prompt_file: finder.md
    tools: [read, search, glob, websearch, webfetch]
```
