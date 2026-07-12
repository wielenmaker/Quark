# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Versioning strategy:** Versions are bumped manually by updating `package.json` and creating an annotated git tag (`git tag -a vX.Y.Z -m "Release vX.Y.Z"`). No automated release scripts — keep it simple.

---

## [Unreleased]

### Changed

- Profile model settings now use the flatter `model`, `thinking_effort`, and optional `thinking_mode` fields. The previous nested `model.thinking` form remains readable for migration.
- The exported `ProfileDef` and `AgentConfig` types now represent model and thinking settings as flat fields.

## [0.1.0] - 2026-04-01

### Added

#### Core Agent
- Agent loop with configurable `minSteps` / `maxSteps` guardrails
- Multi-provider LLM support: Anthropic (Claude) and OpenAI (GPT / o-series)
- Streaming responses with real-time token delivery
- Thinking mode toggle (Anthropic extended thinking via `Ctrl+T`)
- Context-window awareness with nudges at 25% usage intervals
- Sub-agent spawning with parent–child session linking (`--sub-agent` flag)

#### Session & Persistence
- Per-session JSONL storage (replaces earlier SQLite backend)
- Ephemeral sessions (`--no-store`) that are never written to disk
- Session resume by ID (`--session <id>`)
- Message history navigation (up/down) within the TUI

#### Profile System 
- YAML-driven profiles declaring `prompt_file`, `tools[]`, `skills[]`, and optional `model`
- Deterministic profile activation via `--profile <name>`
- Per-project profile overrides via `.quark/config.yaml`

#### Tool System
- Built-in tools: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `todo`, `websearch`, `webfetch`, `skill`
- External/project-local tools in `~/.config/quark/tools/`
- Permission layer: `allow / deny / ask` rules evaluated before each tool call

#### Skill System
- Three-level progressive loading: L1 metadata → L2 instructions → L3 resources
- Skill discovery via isolated sub-agent to avoid context pollution
- Project-local skills (`.quark/skills/`) and global skills (`~/.quark/skills/`)

#### TUI
- Full terminal UI built with OpenTUI (`@opentui/core` + `@opentui/solid`)
- Real-time streaming output with live `Write` tool progress
- Sub-agent observability — child tool calls rendered inline
- Highlight-to-copy clipboard support
- Scrollable session/profile picker dropdowns
- Tab-cycle model switching
- Undo/redo keybindings in the prompt textarea
- Notification panel with solid background
- `/new` command to open a fresh session; `/profile` to switch profiles

#### CLI & SDK
- `quark` CLI with flags: `--profile`, `--session`, `--model`, `--sub-agent`, `--no-store`
- Public SDK exports for embedding the agent loop in other projects
- Plugin system for runtime provider registration

[0.1.0]: https://github.com/your-org/quark/releases/tag/v0.1.0
