# File System — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/file-system
> Cached: 2026-05-17

Allows Agents to read/write files in the Client's environment.

## Checking Support

Check `clientCapabilities.fs.readTextFile` and `clientCapabilities.fs.writeTextFile` from `initialize` response.

## Reading Files (`fs/read_text_file`)

Request:
- `sessionId` (SessionId, required)
- `path` (string, required) — absolute path
- `line` (number, optional) — 1-based line number
- `limit` (number, optional) — max lines to read

Response:
```json
{ "content": "def hello_world():\n    print('Hello, world!')\n" }
```

## Writing Files (`fs/write_text_file`)

Request:
- `sessionId` (SessionId, required)
- `path` (string, required) — absolute path (creates if doesn't exist)
- `content` (string, required) — text to write

Response: `{ "result": null }`
