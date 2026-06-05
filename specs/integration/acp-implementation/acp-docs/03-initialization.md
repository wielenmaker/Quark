# Initialization — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/initialization
> Cached: 2026-05-17

The Initialization phase allows Clients and Agents to negotiate protocol versions, capabilities, and authentication methods.

## Flow

```
Client → Agent: initialize
  (protocolVersion, clientCapabilities, clientInfo)
Agent → Client: initialize response
  (protocolVersion, agentCapabilities, agentInfo, authMethods)
```

## Protocol Version

The protocol version is a single integer (MAJOR version). Only incremented for breaking changes.

### Version Negotiation

- Client sends latest version it supports
- If Agent supports that version, it responds with the same
- Otherwise Agent responds with its latest supported version
- If Client doesn't support Agent's version, it SHOULD disconnect

## Capabilities

All capabilities in `initialize` are OPTIONAL. Omitted capabilities MUST be treated as UNSUPPORTED.

### Client Capabilities

- `fs.readTextFile` (boolean) — `fs/read_text_file` method available
- `fs.writeTextFile` (boolean) — `fs/write_text_file` method available
- `terminal` (boolean) — All `terminal/*` methods available

### Agent Capabilities

- `loadSession` (boolean, default false) — `session/load` available
- `promptCapabilities.image` (boolean, default false) — Image content in prompts
- `promptCapabilities.audio` (boolean, default false) — Audio content in prompts
- `promptCapabilities.embeddedContext` (boolean, default false) — Resource content in prompts
- `mcpCapabilities.http` (boolean, default false) — MCP via HTTP
- `mcpCapabilities.sse` (boolean, default false) — MCP via SSE (deprecated)
- `sessionCapabilities.resume` — `session/resume` available
- `sessionCapabilities.close` — `session/close` available
- `sessionCapabilities.list` — `session/list` available

All Agents MUST support `ContentBlock::Text` and `ContentBlock::ResourceLink` as a baseline.

## Implementation Info

Both Client and Agent SHOULD provide:
- `name` — programmatic/logical identifier
- `title` — human-readable display name
- `version` — version string
