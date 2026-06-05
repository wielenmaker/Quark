# Extensibility — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/extensibility
> Cached: 2026-05-17

## The `_meta` Field

All types include `_meta: { [key: string]: unknown }` for custom data.

Reserved root-level keys for W3C trace context: `traceparent`, `tracestate`, `baggage`.

Implementations MUST NOT add custom fields at the root of spec types — all names reserved for future versions.

## Extension Methods

Methods starting with `_` are reserved for custom extensions. Follow standard JSON-RPC 2.0 semantics.

### Custom Requests
```json
{ "method": "_zed.dev/workspace/buffers", "params": { "language": "rust" } }
```

Unknown methods SHOULD respond with `-32601` "Method not found".

### Custom Notifications
```json
{ "method": "_zed.dev/file_opened", "params": { "path": "..." } }
```

Implementations SHOULD ignore unrecognized notifications.

## Advertising Custom Capabilities

Use `_meta` in capability objects:
```json
{
  "agentCapabilities": {
    "loadSession": true,
    "_meta": {
      "zed.dev": { "workspace": true, "fileNotifications": true }
    }
  }
}
```
