# Slash Commands — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/slash-commands
> Cached: 2026-05-17

Agents can advertise slash commands that users invoke in the editor.

## Advertising Commands

Via `available_commands_update` notification:
```json
{
  "sessionUpdate": "available_commands_update",
  "availableCommands": [
    { "name": "web", "description": "Search the web", "input": { "hint": "query to search" } },
    { "name": "test", "description": "Run tests" }
  ]
}
```

## Command Structure

- `name` (string, required) — e.g. "web", "test"
- `description` (string, required) — what it does
- `input` (AvailableCommandInput, optional) — `{ "hint": "..." }`

## Running Commands

Commands are included as regular user messages:
```json
{ "prompt": [{ "type": "text", "text": "/web agent client protocol" }] }
```

The Agent recognizes the command prefix and processes accordingly.

## Dynamic Updates

Agent can send `available_commands_update` at any time to add/remove/modify commands based on context.
