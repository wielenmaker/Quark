---
title: Specs Index
date_created: 2026-06-04
date_modified: 2026-06-07
revision: 2
history:
  - 2026-06-04: Initial classification and folder reorganization
  - 2026-06-07: Archived all done specs to specs/archives/
status: done
---

# Specs Index

## 📐 Foundation
*Core product definition, architecture, and roadmap.*

| File | Status | Description |
|---|---|---|
| [PRD.md](foundation/PRD.md) | Living | Product Requirements Document — all functional requirements (FR-1 through FR-9) |
| [epics.json](foundation/epics.json) | Living | Epic tracking — EPIC-01 through EPIC-19 with requirements, status, acceptance criteria |
| [tech_stack.json](foundation/tech_stack.json) | — | Tech stack reference (Bun, TypeScript, AI SDK, OpenTUI, SQLite, Tauri) |

## 🏗️ Core Platform
*Agent loop, profiles, tools, permissions, sessions, provider layer.*

| File | Status | Description |
|---|---|---|
| [permission-diff-preview.md](core/permission-diff-preview.md) | Draft | Compute edit diffs **before** the permission prompt so user sees what will change |
| [remove-link-task.md](core/remove-link-task.md) | In Progress | Make `taskId` immutable; synchronous init, async title-only upgrade |
| [task-first-architecture.md](core/task-first-architecture.md) | In Progress | Task as first-class citizen; session branching replaces compaction |
| [goal-command.md](core/goal-command.md) | Draft | Autonomous `/goal` orchestrator: plan → execute → verify → loop |
| [delegate-tool-migration.md](core/delegate-tool-migration.md) | Draft | Migrate sub-agent spawning from bash to a first-class `delegate` tool |

## 🖥️ TUI / UX
*Terminal user interface: rendering, themes, input, interaction patterns.*

| File | Status | Description |
|---|---|---|
| [markdown-rendering-theme.md](tui/markdown-rendering-theme.md) | In Progress | Fix markdown theme scopes, align with Atom One palette, conceal delimiter markers |
| [verbose-tool-logging.md](tui/verbose-tool-logging.md) | In Progress | `--verbose` prints `[TOOL-CALL]` / `[TOOL-RESULT]` to stderr in CLI mode |
| [queued-user-messages.md](tui/queued-user-messages.md) | Draft | Type-ahead follow-up while agent runs — opencode-style unified input box with queued chip |

## 📊 Commands
*Slash commands and their implementations.*

| File | Status | Description |
|---|---|---|
| [statistics-command.md](commands/statistics-command.md) | In Progress | `/statistics` — token usage charts (per-model, per-day) via Unicode bar charts |
| [tool-list-add.md](commands/tool-list-add.md) | Draft | `/tool list` enumerates user tools in `~/.config/quark/tools/`; `/tool add <id>` temporarily loads one into the session |

## 🖼️ Desktop App
*Tauri desktop application: diff workspace, composer, model pickers.*

| File | Status | Description |
|---|---|---|
| [quark-desktop-tauri.md](desktop/quark-desktop-tauri.md) | Draft | Desktop V1: three-pane shared diff workspace (Tauri + Vite) |
| [desktop-model-thinking-pickers.md](desktop/desktop-model-thinking-pickers.md) | In Progress | Model & thinking-level picker pills in the desktop composer bar |

## 🔌 Integration
*Protocol implementations and external system connectors.*

| File | Status | Description |
|---|---|---|
| [ACP Spec](integration/acp-implementation/spec.md) | Draft | Make Quark speak Agent Client Protocol (Zed, JetBrains, Neovim, Emacs) |
| [ACP Integration Guide](integration/acp-implementation/integration-guide.md) | Draft | Step-by-step ACP integration walkthrough |
| [ACP Docs](integration/acp-implementation/acp-docs/) | Reference | Cached ACP protocol reference pages |

## 🔬 Competitive Surveys & References
*TUI/UX patterns from other tools, captured for comparative study.*

| File | Status | Description |
|---|---|---|
| [tui-opentui-notes.md](surveys/tui-opentui-notes.md) | In Progress | Working notes for OpenTUI development — prop naming, theme wiring, ANSI compat |

## 🛠️ Tool Specs
*Specifications for individual tools.*

| File | Status | Description |
|---|---|---|
| [computer-tool.md](tools/computer-tool.md) | Draft | macOS computer-use tool — screenshots, click, type, scroll, window control |

## 📈 Diagrams
*Interactive HTML diagrams for architecture, event flows, and state machines.*

| File | Description |
|---|---|
| [stream-events.html](diagrams/stream-events.html) | AI SDK stream events flow |
| [message-event-flow-overview.html](diagrams/message-event-flow-overview.html) | Message event flow (overview) |
| [message-event-flow-replay.html](diagrams/message-event-flow-replay.html) | Message event flow (replay) |
| [message-event-flow-projections.html](diagrams/message-event-flow-projections.html) | Message event flow (projections) |
| [message-part-model.html](diagrams/message-part-model.html) | Message part data model |
| [permission-state-machine.html](diagrams/permission-state-machine.html) | Permission state machine |
| [prompt-responsibility-breakdown.html](diagrams/prompt-responsibility-breakdown.html) | Prompt responsibility boundaries |
| [quark-er.html](diagrams/quark-er.html) | Entity-relationship diagram |

---

**Summary:** 0 done, 7 in-progress, 6 drafts, 1 reference survey, 1 tool spec, 8 diagrams, 3 foundation artifacts.

*Done specs have been archived to [`specs/archives/`](archives/).*
