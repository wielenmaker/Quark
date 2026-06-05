# Agent Plan — Agent Client Protocol

> Source: https://agentclientprotocol.com/protocol/agent-plan
> Cached: 2026-05-17

Plans are execution strategies for complex multi-step tasks. Agents share plans via `session/update` notifications.

## Creating Plans

```json
{
  "sessionUpdate": "plan",
  "entries": [
    { "content": "Analyze codebase structure", "priority": "high", "status": "pending" },
    { "content": "Identify refactoring targets", "priority": "high", "status": "pending" },
    { "content": "Create unit tests", "priority": "medium", "status": "pending" }
  ]
}
```

## Plan Entries

Each entry:
- `content` (string, required) — human-readable task description
- `priority` (PlanEntryPriority, required) — high, medium, or low
- `status` (PlanEntryStatus, required) — pending, in_progress, or completed

## Updating Plans

Agent MUST send a complete list of all entries in each update. Client MUST replace the entire plan.

## Dynamic Planning

Plans can evolve: Agent MAY add, remove, or modify entries as it discovers new requirements.
