# Session Setup — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/session-setup
> Cached: 2026-05-17

Sessions represent a specific conversation or thread between the Client and Agent.

## Creating a Session (`session/new`)

Request params:
- `cwd` (string, required) — absolute working directory
- `mcpServers` (McpServer[], required) — MCP servers to connect to

Response:
- `sessionId` (string) — unique session identifier

## Loading Sessions (`session/load`)

Requires `loadSession` agent capability.

Request params:
- `sessionId` — session to load
- `cwd` — working directory
- `mcpServers` — MCP servers

The Agent MUST replay the entire conversation as `session/update` notifications before responding. After all entries streamed, responds with `{ result: null }`.

### Replay format

User message example:
```json
{ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "..." } }
```

Agent response example:
```json
{ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "..." } }
```

## Resuming Sessions (`session/resume`)

Requires `sessionCapabilities.resume`. Unlike `session/load`, does NOT replay history. Just restores context, reconnects MCP, and responds.

## Closing Sessions (`session/close`)

Requires `sessionCapabilities.close`. Cancels ongoing work (like `session/cancel`) then frees resources.

## Session ID

Unique identifier returned by `session/new`. Used for all subsequent operations.

## Working Directory (`cwd`)

- MUST be an absolute path
- MUST be used for the session regardless of subprocess spawn location
- SHOULD serve as a boundary for file system tool operations

## MCP Servers

Three transport types:
1. **Stdio** (required): `command`, `args`, `env`
2. **HTTP** (optional, needs `mcpCapabilities.http`): `url`, `headers`
3. **SSE** (optional, deprecated): `url`, `headers`
