# Quark — Product Requirements Document

> **Version:** 2.0  
> **Date:** April 16, 2026  
> **Status:** Living Document

---

## 1. Executive Summary

Quark is an AI coding agent harness — a runtime that owns the loop, the tools, the memory, and the guardrails while treating the LLM as a pluggable component. It ships as an npm package (`@quark/sdk`) with three consumption surfaces: a terminal-based interactive TUI, a CLI for one-shot/scripted usage, and a web UI for browser-based interaction. Users extend Quark with custom tools, skills, and plugins to adapt it to any workflow without modifying the core.

> Architecture, tech stack, core system design, SDK API surface, configuration reference, and epic roadmap are maintained in [architecture.md](./architecture.md).

---

## 2. Functional Requirements

### FR-1: Agent Loop & Session Engine

| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | The system SHALL create a new session or resume an existing one and drive the agent loop to completion | P0 |
| FR-1.2 | The agent loop SHALL iterate — assembling context, streaming an LLM response, executing any tool calls, and repeating — until the model signals completion or a step limit is reached | P0 |
| FR-1.3 | The system SHALL process all LLM stream events including text output, tool invocations, step boundaries, reasoning tokens, and errors | P0 |
| FR-1.4 | Session lifecycle operations (create, retrieve, update title, list, list children) SHALL be supported | P0 |
| FR-1.5 | The system SHALL reconstruct the full conversation history — including tool call/result pairs — for submission to the LLM on each iteration | P0 |
| FR-1.6 | Cancellation signals SHALL propagate through the entire execution chain — from the entry point through the LLM stream to any active tool executions | P0 |
| FR-1.7 | The system SHALL expose a cancellation API that halts a running agent loop cleanly | P0 |
| FR-1.8 | The agent loop SHALL enforce a configurable maximum step count to prevent runaway iterations | P0 |

### FR-2: Profile System

| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | Configuration SHALL support a two-level hierarchy (global → project) with project values overriding global | P0 |
| FR-2.2 | Profile resolution SHALL follow a defined precedence: explicit selection → configured default → built-in fallback | P0 |
| FR-2.3 | Profile prompt files SHALL support frontmatter metadata (name and description) | P0 |
| FR-2.4 | Project-level configuration SHALL support additive tool and skill extensions without replacing the base profile's lists | P1 |
| FR-2.5 | Sub-agent profile references SHALL be validated; unknown references SHALL be warned and stripped | P1 |
| FR-2.6 | The user SHALL be able to switch the active profile at runtime without restarting the session | P1 |
| FR-2.7 | Profile switching SHALL reset all cached bindings to prevent stale tool or skill references | P1 |

### FR-3: Tool System

| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | Every tool SHALL declare an identifier, a description, a typed parameter schema, and an execution function | P0 |
| FR-3.2 | The tool registry SHALL validate tool definitions and reject any that are incomplete, returning a structured error | P0 |
| FR-3.3 | External tools SHALL be discovered and loaded from a user-configurable directory at startup; load failures SHALL emit notifications without crashing | P0 |
| FR-3.4 | Built-in tools (file reading, context compaction, skill loading) SHALL be available without external dependencies | P0 |
| FR-3.5 | Tool definitions SHALL be converted to a format consumable by the AI SDK, with permission evaluation and plugin hooks wired in | P0 |
| FR-3.6 | Only tools declared in the active profile SHALL be registered for the session — no global tool leakage | P0 |
| FR-3.7 | Tool execution SHALL be cancellable via the session's cancellation signal | P1 |

### FR-4: Skill System

| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | Skills SHALL be discovered from project-level and global directories | P0 |
| FR-4.2 | Project-level skills SHALL override global skills of the same name | P0 |
| FR-4.3 | Only profile-bound skills SHALL have their metadata (~100 tokens each) injected into the system prompt | P0 |
| FR-4.4 | Full skill instructions SHALL be loaded into context only when explicitly requested by the agent via a tool call | P0 |
| FR-4.5 | Skill resource files (scripts, references, templates) SHALL never be automatically loaded into the LLM context | P0 |
| FR-4.6 | Skill discovery and loading SHALL be exposed as a tool callable by the agent | P1 |

### FR-5: Permission System

| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | Permission rules SHALL support wildcard pattern matching for tool names and arguments | P0 |
| FR-5.2 | Rule evaluation SHALL apply a last-matching-rule-wins strategy across merged rulesets | P0 |
| FR-5.3 | When a tool requires user approval, the system SHALL enqueue a pending request, notify the UI, and await a response | P0 |
| FR-5.4 | An "always allow" response SHALL create a session-scoped rule and auto-resolve all matching pending requests | P0 |
| FR-5.5 | Hard deny rules SHALL block tool execution immediately without prompting the user | P0 |
| FR-5.6 | The system SHALL support a "correct" response that delivers user feedback text back to the model | P1 |
| FR-5.7 | A "reject" response SHALL halt the current tool execution | P1 |
| FR-5.8 | All pending permission requests SHALL be cleaned up when a session ends | P1 |
| FR-5.9 | The system SHALL be able to identify which tools are blanket-denied by the current ruleset | P1 |

### FR-6: Context Compaction

| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | Auto-compaction SHALL trigger when estimated token usage reaches a configurable threshold of the context window (default: 95%) | P0 |
| FR-6.2 | Concurrent compaction requests on the same session SHALL be deduplicated | P0 |
| FR-6.3 | The "general" compaction method SHALL create a new session seeded with an LLM-generated summary plus the most recent turn pairs | P0 |
| FR-6.4 | The "anchored" compaction method SHALL write a summary into the current session without creating a new one | P1 |
| FR-6.5 | Plugins SHALL be able to inject additional context strings into the compaction summary | P1 |
| FR-6.6 | Compaction SHALL be triggerable via TUI command, agent tool call, and automatic threshold detection — all using the same deduplication path | P0 |
| FR-6.7 | Auto-compaction SHALL be disableable via configuration | P1 |

### FR-7: Provider & Model Routing

| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | The system SHALL support a default provider (GitHub Copilot) with correct authentication | P0 |
| FR-7.2 | Models requiring extended thinking (e.g., Claude with reasoning) SHALL be routed to the appropriate native API | P0 |
| FR-7.3 | Users SHALL be able to define custom providers with a base URL and API key in configuration | P0 |
| FR-7.4 | The system SHALL route models to the correct API variant (e.g., Responses API vs Chat API) based on model capabilities | P1 |
| FR-7.5 | Model token limits SHALL be retrieved from an external registry with a time-based cache | P1 |
| FR-7.6 | Plugins SHALL be able to override the provider and model before each LLM request | P1 |
| FR-7.7 | API key configuration SHALL support both literal values and environment variable references | P0 |
| FR-7.8 | Model identifiers SHALL support a `provider/model` format; bare model names SHALL resolve to the default provider | P0 |

### FR-8: Plugin System

| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | Plugins SHALL be loaded from a user-configurable directory at startup | P0 |
| FR-8.2 | The plugin system SHALL support hook points covering provider requests, session lifecycle, tool execution, and loop iteration | P0 |
| FR-8.3 | Hook handlers SHALL execute sequentially and receive a mutable output object for modification | P0 |
| FR-8.4 | Plugin load failures SHALL emit notifications but SHALL NOT crash the agent | P0 |
| FR-8.5 | Plugins SHALL be able to register new providers at runtime without configuration file changes | P1 |
| FR-8.6 | Hook outputs SHALL be mutable — plugins SHALL be able to modify provider, model, arguments, and injected context | P0 |

### FR-9: Sub-Agent System

| ID | Requirement | Priority |
|---|---|---|
| FR-9.1 | The system SHALL support spawning child agent sessions linked to a parent session | P0 |
| FR-9.2 | Parent session identity SHALL be propagated to child processes automatically | P0 |
| FR-9.3 | Child agents SHALL stream structured events to the parent process during execution | P0 |
| FR-9.4 | The parent agent SHALL parse child events and re-emit them on the parent event bus | P1 |
| FR-9.5 | The TUI SHALL render child agent activity inline under the parent tool call | P1 |
| FR-9.6 | The system SHALL support querying child sessions of a given parent session | P1 |
| FR-9.7 | Profile declarations of sub-agent identifiers SHALL be validated; unknown identifiers SHALL be warned and stripped | P1 |

### FR-10: Interactive TUI

| ID | Requirement | Priority |
|---|---|---|
| FR-10.1 | The TUI SHALL provide a full-terminal scrollable message area with auto-scroll to the latest content | P0 |
| FR-10.2 | The TUI SHALL support slash commands for common operations: help, new session, session list, compaction, clear, model switch, profile switch, and exit | P0 |
| FR-10.3 | The TUI SHALL support file mentions with fuzzy autocomplete that inlines file content as context | P0 |
| FR-10.4 | The TUI SHALL support image paste with preview chips and keyboard navigation for removal | P1 |
| FR-10.5 | Permission prompts SHALL be presented as an overlay with keyboard shortcuts for allow, always-allow, and reject | P0 |
| FR-10.6 | Session and model selection SHALL be presented as navigable overlays | P1 |
| FR-10.7 | Token usage, cost, and active model SHALL be displayed in a status bar | P1 |
| FR-10.8 | File edit results SHALL be displayed as syntax-highlighted unified diffs | P1 |
| FR-10.9 | The TUI theme SHALL adapt to the terminal's background color (dark/light) | P2 |
| FR-10.10 | Text input SHALL support undo/redo | P2 |
| FR-10.11 | Chat input SHALL support history navigation via arrow keys, with session-scoped history and draft restoration | P1 |

### FR-11: Extended Thinking

| ID | Requirement | Priority |
|---|---|---|
| FR-11.1 | Users SHALL be able to toggle extended thinking on/off with a configurable token budget | P1 |
| FR-11.2 | Thinking-enabled requests SHALL be routed to the appropriate provider API for the active model | P1 |
| FR-11.3 | Reasoning events (start, content, end) SHALL be processed and persisted as part of the conversation | P1 |
| FR-11.4 | Reasoning output SHALL be rendered as collapsible content in the TUI | P1 |
| FR-11.5 | Extended thinking SHALL only be applied to models that support it | P1 |

### FR-12: Retry & Error Recovery

| ID | Requirement | Priority |
|---|---|---|
| FR-12.1 | Rate-limit (HTTP 429), server error (5xx), network, and provider overload errors SHALL be classified as retryable | P0 |
| FR-12.2 | Authentication (401/403) and client errors (non-429 4xx) SHALL NOT be retried | P0 |
| FR-12.3 | Retries SHALL use exponential backoff with jitter, starting at ~1 second and capped at 30 seconds | P0 |
| FR-12.4 | Plugins SHALL be able to trigger a retry with an alternative provider/model on error | P1 |
| FR-12.5 | In-flight tool operations SHALL be marked as errored when a mid-stream abort occurs | P1 |
| FR-12.6 | User-initiated cancellations SHALL NOT be retried | P0 |

### FR-13: SDK & CLI Distribution

| ID | Requirement | Priority |
|---|---|---|
| FR-13.1 | The build system SHALL produce valid ESM and CJS bundles | P0 |
| FR-13.2 | All public types SHALL be exported from the SDK package | P0 |
| FR-13.3 | A standalone CLI binary SHALL be available and executable | P0 |
| FR-13.4 | CLI SHALL support flags for profile selection, prompt input, session management, model override, sub-agent mode, ephemeral mode, profile listing, and help | P0 |
| FR-13.5 | When no prompt is provided, the CLI SHALL launch the interactive TUI | P1 |

### FR-14: Session Title Generation

| ID | Requirement | Priority |
|---|---|---|
| FR-14.1 | Session titles SHALL be generated asynchronously using a lightweight model after the first user message | P2 |
| FR-14.2 | Title generation failures SHALL NOT affect the parent session | P0 |
| FR-14.3 | Generated titles SHALL be persisted and reflected in the session picker | P2 |

### FR-15: Event Bus

| ID | Requirement | Priority |
|---|---|---|
| FR-15.1 | The system SHALL provide a typed event bus covering all agent lifecycle events (session, loop, tool, permission, compaction, sub-agent, reasoning, retry) | P0 |
| FR-15.2 | A maximum listener count per event SHALL be enforced to prevent memory leaks | P0 |
| FR-15.3 | The TUI SHALL subscribe to bus events and dispatch them to the reactive UI state | P0 |
| FR-15.4 | The CLI SHALL subscribe to bus events and produce structured output | P0 |
| FR-15.5 | Sub-agent events SHALL be forwarded from child processes to the parent event bus | P1 |

### FR-16: Web UI

| ID | Requirement | Priority |
|---|---|---|
| FR-16.1 | The web server SHALL expose REST API endpoints for health, sessions, prompting, cancellation, compaction, model management, thinking, permissions, profiles, models, configuration, and file listing | P0 |
| FR-16.2 | A WebSocket endpoint SHALL relay all agent lifecycle events to connected clients in real-time | P0 |
| FR-16.3 | The input area SHALL support image attachment via a file picker | P1 |
| FR-16.4 | Attached images SHALL be previewed with mime type metadata before sending | P1 |
| FR-16.5 | Image previews SHALL be displayed above the input area with individual removal controls | P1 |
| FR-16.6 | Image attachments exceeding a size limit (5 MB) SHALL be rejected with user feedback | P1 |
| FR-16.7 | Images SHALL be forwarded to the backend prompt API alongside the message text | P1 |
| FR-16.8 | Sent images SHALL be rendered as thumbnails within the user's message in the chat view | P1 |
| FR-16.9 | The input area SHALL support a file/directory mention picker triggered by button or keyboard | P2 |
| FR-16.10 | The input area SHALL support a slash command palette triggered by button or keyboard | P2 |
| FR-16.11 | Text-only messages SHALL continue to work without regression after image/mention additions | P0 |

---

## 3. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | TUI render performance | 60 fps with full-terminal scrollable message area |
| NFR-2 | Plugin load resilience | Non-blocking — notifications only, never crash |
| NFR-3 | Tool load resilience | Non-blocking — notifications only, never crash |
| NFR-4 | Retry resilience | Exponential backoff with jitter (1 s → 30 s cap) for 429, 5xx, network errors |
| NFR-5 | Context budget management | Auto-compact at configurable threshold (default 95%) of context window |
| NFR-6 | Session persistence integrity | Append-only event log — crash-safe, no write-ahead log needed |
| NFR-7 | WebSocket keepalive | 120 s idle timeout with pings (iOS Safari compatibility) |
| NFR-8 | API key security | Keys resolved via environment variable indirection — never stored in plaintext config |
| NFR-9 | Tool execution safety | Permission system gates all tool execution — deny rules block immediately |
| NFR-10 | Ephemeral mode | Ephemeral sessions never written to disk |
| NFR-11 | Output security | No secrets or keys logged in output |
