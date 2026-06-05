# Terminals — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/terminals
> Cached: 2026-05-17

Allows Agents to execute shell commands in the Client's environment.

## Checking Support

Check `clientCapabilities.terminal` from `initialize` response.

## Methods

### `terminal/create`
Start a command. Returns `terminalId` immediately.

Request: `sessionId`, `command`, `args`, `env`, `cwd`, `outputByteLimit`
Response: `{ "terminalId": "term_xyz789" }`

### `terminal/output`
Get current output without waiting for exit.

Response: `{ "output": "...", "truncated": false, "exitStatus": { "exitCode": 0, "signal": null } }`

### `terminal/wait_for_exit`
Blocks until command completes.

Response: `{ "exitCode": 0, "signal": null }`

### `terminal/kill`
Terminate without releasing (ID stays valid for output/wait).

### `terminal/release`
Kill if running + free resources. ID becomes invalid.

## Embedding in Tool Calls

```json
{ "type": "terminal", "terminalId": "term_xyz789" }
```

Client displays live output even after terminal is released.

## Building Timeouts

1. Create terminal
2. Start timer
3. Wait for timer or `terminal/wait_for_exit`
4. If timer fires: kill, get output, send to model
5. Release
