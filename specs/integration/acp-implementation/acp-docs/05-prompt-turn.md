# Prompt Turn — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/prompt-turn
> Cached: 2026-05-17

A prompt turn is the complete interaction cycle: user message → agent processes → streams output → tool calls → repeat → stop.

## Lifecycle

1. **User Message**: Client sends `session/prompt` with `sessionId` + `prompt` (ContentBlock[])
2. **Agent Processing**: Agent sends prompt to LLM
3. **Agent Reports Output**: Agent sends `session/update` notifications (plan, agent_message_chunk, tool_call)
4. **Check for Completion**: If no pending tool calls, end turn with StopReason
5. **Tool Invocation**: Execute tools, send status updates, request permissions if needed
6. **Continue**: Send tool results back to LLM, go to step 2

## Prompt Request

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [
      { "type": "text", "text": "Can you analyze this code?" },
      { "type": "resource", "resource": { "uri": "file:///path/to/file.py", "text": "..." } }
    ]
  }
}
```

## Agent Reports Output

### Plan notification
```json
{ "sessionUpdate": "plan", "entries": [{ "content": "...", "priority": "high", "status": "pending" }] }
```

### Text streaming
```json
{ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "I'll analyze..." } }
```

### Tool call
```json
{ "sessionUpdate": "tool_call", "toolCallId": "call_001", "title": "...", "kind": "other", "status": "pending" }
```

## Stop Reasons

- `end_turn` — LLM finished without requesting more tools
- `max_tokens` — Token limit reached
- `max_turn_requests` — Max model requests exceeded
- `refusal` — Agent refuses to continue
- `cancelled` — Client cancelled via `session/cancel`

## Cancellation

Client sends `session/cancel` notification with `sessionId`. Agent MUST:
- Stop all LLM requests
- Abort all tool calls
- Send pending updates
- Respond to `session/prompt` with `stopReason: "cancelled"`
