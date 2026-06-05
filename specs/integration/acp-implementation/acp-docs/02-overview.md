# Protocol Overview — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/overview
> Cached: 2026-05-17

The Agent Client Protocol allows Agents and Clients to communicate by exposing methods that each side can call and sending notifications to inform each other of events.

## Communication Model

The protocol follows the JSON-RPC 2.0 specification with two types of messages:
- **Methods**: Request-response pairs that expect a result or error
- **Notifications**: One-way messages that don't expect a response

## Message Flow

1. **Initialization Phase**: `initialize` to establish connection, `authenticate` if required
2. **Session Setup**: `session/new` (create) or `session/load` (resume)
3. **Prompt Turn**:
   - Client → Agent: `session/prompt` to send user message
   - Agent → Client: `session/update` notifications for progress updates
   - Agent → Client: File operations or permission requests as needed
   - Client → Agent: `session/cancel` to interrupt processing if needed
   - Turn ends and the Agent sends the `session/prompt` response with a stop reason

## Agent (Server-Side)

Agents implement these baseline methods:
- `initialize` — Negotiate versions and exchange capabilities
- `authenticate` — Authenticate with the Agent (if required)
- `session/new` — Create a new conversation session
- `session/prompt` — Send user prompts to the Agent

Optional methods: `session/load`, `session/set_mode`

## Client (Editor-Side)

Clients implement these baseline methods:
- `session/request_permission` — Request user authorization for tool calls

Optional methods:
- `fs/read_text_file` — Read file contents (requires `fs.readTextFile` capability)
- `fs/write_text_file` — Write file contents (requires `fs.writeTextFile` capability)
- `terminal/create`, `terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill`

## Key Rules

- All file paths in the protocol MUST be absolute
- Line numbers are 1-based
- Successful responses include a `result` field
- Errors include an `error` object with `code` and `message`
- Notifications never receive responses

## Extensibility

- Add custom data using `_meta` fields
- Create custom methods by prefixing their name with underscore (`_`)
- Advertise custom capabilities during initialization
