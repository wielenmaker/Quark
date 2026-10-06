# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Versioning strategy:** Versions are bumped manually by updating `package.json` and creating an annotated git tag (`git tag -a vX.Y.Z -m "Release vX.Y.Z"`). No automated release scripts — keep it simple.

---

## [Unreleased]

### Added

- Local installation from the checkout: `bun scripts/install-local.ts` packs the workspace packages, installs them with dependencies into a versioned tree under `~/.local/share/quark` (`QUARK_HOME` overrides), verifies the install boots, then atomically switches the `current` pointer and writes the `~/.local/bin/quark` launcher. `--list`, `--use <version>`, and `--rollback` manage installed versions; `~/.config/quark` is never touched.
- `quark doctor`: read-only diagnosis of the app location, Node/Bun runtimes, config and profile discovery, tool-file health (imports every personal and bundled tool), session storage, ripgrep availability, and the resolved subagent command. Exit code 1 on hard failures.
- Bundled standard tools: `bash`, `edit`, `write`, `grep`, `glob`, `websearch`, `webfetch`, `todo` ship with the app (compiled into `dist/tools`); personal tools in `<config>/tools/` keep precedence.
- ACP profile selector: `quark acp` advertises every agent manifest as a `category: "mode"` session config option, so an editor (Zed) renders them as its mode picker. Switching profile rebinds that session's runner to the new profile's agent — tools, system prompt, skills, and model — on the same persisted session, and drops the session's explicit model/effort picks so the profile's own settings apply. The model and effort pickers follow the selected profile's own settings rather than the launch-time agent's.
- `quark acp --profile <id>` (also `-p`) selects the profile sessions start on. `--agent`/`-a` is an alias for it; an id no manifest backs is refused at launch, naming the available profiles.
- HTTP runner API for external orchestrators. `POST /api/runners` mints an isolated execution instance (own event bus, cancellation state, and hooks) bound to a configured agent; `POST /api/runners/:id/session/prompt`, `GET /api/runners/:id/sessions/:sessionId`, `GET …/events`, `POST …/cancel`, and `DELETE /api/runners/:id` drive it.
- Image attachments on prompts: `POST /api/sessions/:id/messages` and the runner prompt route accept `images: [{ mime, data }]` (PNG / JPEG / GIF / WebP), capped at 8 images, 5 MiB decoded each, 10 MiB body.
- Session-discovery API for external processes: with `QUARK_API_PORT` set, the app serves a read-only localhost `GET /api/session/current` reporting the current session id, so an orchestrator can link its tasks to a Quark session.
- Live viewing of someone else's running session: `quark --session <id>` follows an in-flight turn started by another process (REST runner) instead of refusing it.

### Changed

- `QUARK_DIR` is no longer required for normal use. The CLI, TUI, bundled tools, and subagent launches resolve from the running app's own location (`src/app-paths.ts`); `QUARK_DIR` remains supported as an explicit override, and `quark doctor` reports when it is set.
- Subagent children spawn from an explicit command resolved by the app and passed through `createSubagentTool({ executable })`, instead of argv/marker-path guessing inside the engine.
- CLI/TUI session actions now use the active runtime's store for resume, listing, rename, pin, branching, replay, and export. Existing JSONL session paths and format are unchanged by this refactor.
- `/undo` is supported only with the app's default JSONL store. Custom stores fail before restoring files or rewriting session history; their runs do not write global undo snapshots.
- **Breaking (SDK):** `@quark/runner` no longer exports the singleton `prompt`, `cancel`, `isActive`, `bus`, `globalHooks`, `register`, or `listTools`. Use `createRunner({ agent, store?, plugins?, hooks? })`, then `runner.prompt()`, `runner.cancel()`, `runner.bus`, and `runner.store`. The internal singleton subpaths still exist for the web backend's local routes; they are not removed by this change.
- **Breaking (direct source imports):** `packages/quark/src/bootstrap.ts` and `resetBootstrap` were removed. Set up the agent, runner, store, and plugins explicitly instead.
- **Breaking:** the runner prompt route moved from `POST /api/runners/:id/messages` to `POST /api/runners/:id/session/prompt`. The old path now falls through to `404`.
- **Breaking:** runner sessions are no longer in-memory. Every runner shares one disk-backed namespace, `~/.config/quark/session/runners/<sessionId>/`, so history outlives the runner: a new runner (including one minted after a server restart) resumes any session by id. `DELETE /api/runners/:id` and eviction at the 100-runner cap drop only the execution handle — never session files.
- **Breaking:** the CLI/TUI now store sessions in that same shared namespace, so `quark --session <sessionId>` resumes a session created over REST. Sessions created under the old `~/.config/quark/session/<sessionId>/` path are no longer found by the CLI/TUI.
- Runner prompt `sessionId` is restricted to `[A-Za-z0-9_-]+` (the id alphabet the engine generates) so an id can never escape the session directory. Rejected with `400 sessionId must match [A-Za-z0-9_-]+`; other runner session routes answer `400 Invalid session id`.
- Concurrent turns on one session are refused with `409` across **all** runners, since they share a namespace. `events` and `cancel` address whichever runner owns the in-flight turn, regardless of which runner path the caller used.
- Profile model settings now use the flatter `model`, `thinking_effort`, and optional `thinking_mode` fields. The previous nested `model.thinking` form remains readable for migration.
- The exported `ProfileDef` and `AgentConfig` types now represent model and thinking settings as flat fields.

### Fixed

- ACP image prompts: the up-front "model cannot see" rejection follows the session's selected profile and model instead of the launch-time agent, so a profile or model switch can no longer leave the gate stale (it refused images a vision model accepts, and waved through a blind one's). The catalog lookup is memoized per model spec.
- Canceled turns now finish when the provider stream stalls instead of leaving the session marked running.

### Removed

- **Breaking:** `quark acp` and Quark's Agent Client Protocol server implementation were removed. External editor integrations that depend on ACP must migrate to another supported interface or pin to a prior release.

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
