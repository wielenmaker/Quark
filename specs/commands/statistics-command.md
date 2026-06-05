---
title: /statistics Command — Token Usage Visualization
date_created: 2026-05-16
date_modified: 2026-05-16
revision: 1
history:
  - 2026-05-16: Initial draft
status: in-progress
---

# /statistics Command — Token Usage Visualization

## 1. Problem

Users have no visibility into their Quark token consumption patterns. There's no
way to answer questions like: "How many tokens did I use this week?", "Which
model do I use most?", "What's my daily token burn rate?"

## 2. Solution

A `/statistics` slash command that scans all session JSONL files, aggregates
token usage by model and day, and renders a text-based chart in the TUI.

## 3. Architecture

```
/statistics → collectStatistics() → renderStatisticsChart() → display as message
                    │                        │
                    ▼                        ▼
           scanSessionMetas()         Unicode box-drawing
           replaySessionFile()        bar charts + table
```

### Data Collection (`src/commands/statistics.ts`)
- Scan all `meta.json` files → get session list
- For each session, replay the JSONL → extract `MessageEndEvent` rows with:
  - `modelId` (from `MessageEvent`)
  - `tokensIn` / `tokensOut` (from `MessageEndEvent`)
  - `timeCreated` (for daily bucketing)
- Aggregate by model + day

### Chart Rendering
- Pure text-based charts using Unicode box-drawing characters
- Table: per-model totals (input/output tokens, message count)
- Bar chart: per-model token usage with `█` blocks

## 4. Key Decisions

- **No external chart library** — terminal rendering uses Unicode block chars.
  This keeps zero dependencies for TUI mode.
- **Model grouping by spec** — uses the full `modelId` string (e.g.
  "claude-sonnet-4.5") as the grouping key. Future: could normalize to
  provider:model.
- **No caching** — stats are computed fresh on each invocation. With ~hundreds
  of sessions this is fast enough. If it becomes slow, we can add a summary
  cache.

## 5. Acceptance Criteria

- [ ] `/statistics` renders a table of per-model token usage
- [ ] `/statistics` renders a bar chart of per-model token usage
- [ ] Command works without an active session
- [ ] Handles empty state (no sessions, no token data)
- [ ] Shows input + output tokens per model
