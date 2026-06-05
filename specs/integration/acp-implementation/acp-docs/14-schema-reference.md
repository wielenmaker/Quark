# Schema Reference — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/schema
> Cached: 2026-05-17

Full ACP schema reference. See the [online schema page](https://agentclientprotocol.com/protocol/schema) for the most up-to-date version, and [schema/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json) for the canonical JSON Schema.

## Key Types Summary

### Agent Methods
- `initialize` — negotiate version + capabilities
- `authenticate` — authenticate client
- `session/new` — create session
- `session/prompt` — process user prompt
- `session/load` — load existing session (needs `loadSession`)
- `session/resume` — resume without replay (needs `sessionCapabilities.resume`)
- `session/close` — close active session (needs `sessionCapabilities.close`)
- `session/list` — list known sessions (needs `sessionCapabilities.list`)
- `session/set_mode` — change session mode
- `session/set_config_option` — set config option

### Client Methods
- `session/request_permission` — ask user for tool authorization
- `fs/read_text_file` — read file (needs `fs.readTextFile`)
- `fs/write_text_file` — write file (needs `fs.writeTextFile`)
- `terminal/create` — execute command
- `terminal/output` — get terminal output
- `terminal/wait_for_exit` — wait for command completion
- `terminal/kill` — kill command
- `terminal/release` — release terminal

### Notifications
- `session/update` — agent progress updates
- `session/cancel` — cancel ongoing turn

### SessionUpdate variants
- `user_message_chunk` — user message content
- `agent_message_chunk` — agent response content
- `agent_thought_chunk` — internal reasoning
- `tool_call` — new tool call initiated
- `tool_call_update` — tool call status/progress
- `plan` — execution plan
- `available_commands_update` — available slash commands
- `current_mode_update` — mode change
- `config_option_update` — config option change
- `session_info_update` — session metadata change

### Core Types
- `ContentBlock` — text | image | audio | resource | resource_link
- `ToolCallStatus` — pending | in_progress | completed | failed
- `ToolKind` — read | edit | delete | move | search | execute | think | fetch | switch_mode | other
- `StopReason` — end_turn | max_tokens | max_turn_requests | refusal | cancelled
- `PlanEntryPriority` — high | medium | low
- `PlanEntryStatus` — pending | in_progress | completed
- `PermissionOptionKind` — allow_once | allow_always | reject_once | reject_always
- `ProtocolVersion` — integer (uint16)
- `SessionId` — string
- `ToolCallId` — string

### Error Codes
- `-32700` Parse error
- `-32600` Invalid request
- `-32601` Method not found
- `-32602` Invalid params
- `-32603` Internal error
- `-32000` Authentication required
- `-32002` Resource not found
