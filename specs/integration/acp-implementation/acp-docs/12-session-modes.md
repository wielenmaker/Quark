# Session Modes — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/session-modes
> Cached: 2026-05-17

Agents can provide modes (e.g., "ask", "architect", "code") that affect system prompts, tool availability, and permission behavior.

> Note: Session Config Options is the newer replacement. Dedicated mode methods will be removed in a future version. Until then, offer both for backward compatibility.

## Initial State

During session setup, Agent MAY return:
```json
{
  "modes": {
    "currentModeId": "ask",
    "availableModes": [
      { "id": "ask", "name": "Ask", "description": "Request permission before changes" },
      { "id": "code", "name": "Code", "description": "Write code with full tool access" }
    ]
  }
}
```

## Setting Mode from Client

`session/set_mode` with `sessionId` and `modeId`. Mode must be in `availableModes`.

## Setting Mode from Agent

Agent sends `current_mode_update` notification:
```json
{ "sessionUpdate": "current_mode_update", "modeId": "code" }
```

Common pattern: "exit mode" tool in plan/architect modes. LLM calls it, it requests permission (with mode options as permission options), then switches mode.
