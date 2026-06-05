# Tool Calls — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/tool-calls
> Cached: 2026-05-17

Tool calls represent actions that LLMs request Agents to perform.

## Creating

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call_001",
  "title": "Reading configuration file",
  "kind": "read",
  "status": "pending"
}
```

Fields:
- `toolCallId` (ToolCallId, required) — unique ID within session
- `title` (string, required) — human-readable description
- `kind` (ToolKind) — read, edit, delete, move, search, execute, think, fetch, switch_mode, other
- `status` (ToolCallStatus) — pending, in_progress, completed, failed
- `content` (ToolCallContent[]) — produced content
- `locations` (ToolCallLocation[]) — file locations for "follow-along"
- `rawInput` (object) — raw tool input
- `rawOutput` (object) — raw tool output

## Updating

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_001",
  "status": "in_progress"
}
```

Only changed fields need to be included. All fields except `toolCallId` are optional.

## Status Lifecycle

pending → in_progress → completed | failed

## Requesting Permission

Agent calls `session/request_permission` on the Client:

```json
{
  "method": "session/request_permission",
  "params": {
    "sessionId": "...",
    "toolCall": { "toolCallId": "call_001" },
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
    ]
  }
}
```

Client responds:
```json
{ "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } } }
```

Permission option kinds: `allow_once`, `allow_always`, `reject_once`, `reject_always`

On cancellation, Client responds with `{ "outcome": { "outcome": "cancelled" } }`.

## Content Types in Tool Calls

- `content` — standard ContentBlock
- `diff` — file modification as diff (`path`, `oldText`, `newText`)
- `terminal` — embedded terminal by terminalId

## Locations ("Follow the Agent")

```json
{ "path": "/home/user/project/src/main.py", "line": 42 }
```
