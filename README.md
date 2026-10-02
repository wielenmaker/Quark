# Quark

Modern agent harness stack with beautiful TUI and detach runner. Designed for cloud deployment. 

**Docs:** <http://quark-doc.home.arpa> — HTTP API reference, plus CLI and SDK
sections. Homelab-only; the site is a separate Docusaurus repo deployed to k3s,
not built from this one.


## Requirements

- [Bun](https://bun.sh) (runtime + package manager)
- An API key for at least one provider (see [Configuration](#configuration))

## Install

```bash
git clone https://github.com/huypham37/Quark.git
cd Quark
bun install
```

Build and launch the interactive TUI:

```bash
bun run build
bin/quark
```

Normal CLI launches use `packages/quark/dist/tui.js`, with Solid TSX compiled at
build time rather than on each launch. The cached model catalog is loaded after
the first app frame and then refreshed in the background. Theme detection is
unchanged. Rebuild after changing source; a missing compiled TUI reports build
instructions instead of silently falling back to runtime compilation.

For source development (including runtime TSX transformation):

```bash
bun run dev
```

One-off CLI help:

```bash
node packages/quark/dist/cli.js --help
```

To install `quark` globally from this checkout:

```bash
npm link
```

The interactive TUI requires [Bun](https://bun.sh). One-off messages and CLI
commands run with Node from the built distribution.

For a local convenience launcher, [`bin/quark`](bin/quark) runs the built CLI
relative to the repository root. Add `bin/` to your `PATH` after building.

---

## Usage

```bash
# Interactive TUI
quark

# One-off message with an agent
quark --agent coder --message "fix the bug in main.ts"

# Pick a specific model for a single run
quark --model copilot/claude-sonnet-4.5 "use this model for this run"

# Quick question that should never be saved to disk
quark --no-store "what does this regex do?"

# Resume an existing session
quark --session <id>

```

### CLI flags

| Flag | Description |
|------|-------------|
| `-a, --agent <name>` | Agent to use (default: from config) |
| `-m, --message <text>` | Message text (alternative to a positional arg) |
| `-s, --session <id>` | Resume an existing session |
| `--model <id>` | Model for this run, e.g. `copilot/claude-sonnet-4.5` |
| `--no-store` | Run an ephemeral session — never written to disk |
| `--verbose` | Print every tool call + result to stderr |
| `-l, --list-agents` | List available agents |
| `-h, --help` | Show help |

Breaking changes: `--profile`, `-p`, and `--list-profiles` are removed from
the CLI; use `--agent`, `-a`, or `--list-agents`. In the TUI, use `/agent`
instead of `/profile`. (`quark acp` is the exception: it accepts `--profile`/
`-p` as aliases of `--agent`/`-a`, and advertises the available profiles as
its ACP mode selector, so an editor can switch them per thread.)
`QUARK_VERBOSE` no longer activates debug output; use `QUARK_DEBUG=*` for
engine logs or `--verbose` for tool calls. Filesystem-defined `write` and
`edit` tools use `filePath`; custom tools with those IDs may use `path`, but
must provide one unambiguous target when undo tracking is enabled.
Missing/conflicting targets or failed snapshots now stop the tool before it
modifies a file.

---

## Configuration

Config lives at `~/.config/quark/config.yaml`. A missing file uses defaults;
invalid YAML or V2 config fails with migration instructions. Models use
`provider/model`. Changes made through `/settings` apply when the editor closes.

```yaml
version: 3

models:
  small: openai/gpt-5-mini

default_agent: coder

max_steps: 100

# Used for /settings and clickable file links. Defaults to $EDITOR, $VISUAL, then nvim.
editor: nvim

branching:
  auto: true
  threshold: 0.90

# Only endpoints Quark does not bundle belong here.
providers:
  quark-go:
    base_url: https://api.quark-go.example/v1
    api_key: env:QUARK_GO_API_KEY
```

Standard providers require no `providers:` entry. Authenticate interactively with
`quark auth login openrouter`, or set a user-managed environment variable for
headless use. Prefer `api_key: env:NAME` over literal secrets in config.

OpenCode Go is bundled as `opencode-go`. After subscribing and copying your key,
run `quark auth login opencode-go` (or set `OPENCODE_API_KEY`) and select a model
such as `opencode-go/kimi-k3`. Quark routes each catalog model to its documented
Chat Completions, Responses, or Anthropic Messages endpoint and sends a stable
`x-opencode-session` header.

Some models support an additional reasoning mode. For those models—currently
the GPT-5.6 family—set `thinking_mode: pro` alongside `thinking_effort`. Quark
warns and ignores the setting when the selected model does not support modes.

Older inline profiles using `model: { id, thinking: { effort, mode } }` are
supported by the offline migration only. New single-file profiles use nested
`model.id`, `model.thinking_effort`, and optional `model.thinking_mode`.
For `openai` and `openai-codex`, optional `model.fast_mode: true` requests
priority processing, independently of thinking effort. Fast API processing may
cost extra; Codex availability depends on the subscription/backend. `false`
explicitly requests standard processing; omitting it leaves the provider default
unchanged. Explicit fast-mode settings on other providers are rejected. The
profile setting does not carry over to a different model selected at runtime.
Profiles are global; project-local agent/profile directories are not loaded.

Set provider API keys through `quark auth login`, or use provider-standard
environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, and `OPENCODE_API_KEY`. Quark reads environment variables
but never edits shell startup files.

---

## Profiles

Profiles live only in `~/.config/quark/profile/<name>.yaml` (or under
`QUARK_CONFIG_DIR/profile/` when configured). Each profile holds its prompt
and settings in one file:

```yaml
name: Researcher
description: Investigates code
model:
  id: openai/gpt-5
  thinking_effort: high
tools: [read, skill]
skills: [focus]
subagents: [coder]
prompt: |
  Investigate the question and report evidence.
```

Use `quark --list-agents` and `quark --agent researcher --message "..."`.
Profiles live in `~/.config/quark/profile/<name>.yaml`. Existing installations
must convert older `agents/<name>/agent.yaml` and `instructions.md` files before
upgrading; keep the originals as backups until the profiles are verified.
V2 inline profiles require `bun scripts/migrate-config-v2-to-v3.ts --dry-run`
followed by `bun scripts/migrate-config-v2-to-v3.ts`. The script preflights all
profiles, writes `profile/<name>.yaml`, and retains a backup of `config.yaml`.
Resolve missing prompts or destination conflicts before rerunning.

---

## Tools & Subagents

Tools are the product — research-backed and test-backed.

**Built-in tools** are selected when the agent is materialized: `read`, `skill`,
and `read_session`.

**Profile-declared tools** are loaded by ID from `~/.config/quark/tools/{id}.ts`
when a profile lists them in its `tools[]` array. Copy a tool implementation into
that directory to enable it.

A **subagent** is an agent (prompt + tools + model) exposed through
a thin, named tool. It runs in its own isolated session (`kind: "subagent"`,
`parentSessionId` set) so its intermediate reasoning never pollutes the parent's
context — the parent transcript stores only the tool call and the final result.

---

## Architecture

```diagram
╭─────────────────────────────────────────────────╮
│                  TUI / SDK / CLI                  │
├─────────────────────────────────────────────────┤
│        Baked-in Agents (identities, in code)      │
│             prompt + tools[] + skills[]            │
├──────────┬──────────┬───────────┤
│  Agent   │  Tool    │  Skill    │
│  Loop    │  System  │  System   │
├──────────┴──────────┴───────────┤
│              Persistence (JSONL)                   │
│   Session (main | subagent | ephemeral)           │
│        → Message → Part   (parentSessionId)        │
╰─────────────────────────────────────────────────╯
```

See [`docs/data-model.md`](docs/data-model.md) for the persistence schema and
[`specs/`](specs/) for design records.

---

## Using Quark as an SDK

Quark also ships as the `@quark/runner` package. Execution belongs to a runner
instance: its session store, event bus, hooks, and cancellation state are not
shared with other runners by default.

```ts
import { createRunner, defineAgent, createSession } from "@quark/runner"

const agent = defineAgent({
  id: "assistant",
  instructions: "You are a helpful assistant.",
  tools: [],
  model: "openai/gpt-5-mini",
})
const runner = createRunner({ agent }) // isolated in-memory store by default
runner.bus.on("session-created", ({ sessionId }) => console.log(sessionId))
const session = createSession(undefined, runner.store)
await runner.prompt({ sessionId: session.id, parts: [{ type: "text", text: "Hello" }] })
```

For persistent sessions, pass `store: createJsonlSessionStore(root)` to
`createRunner`. Use `runner.store` for session CRUD and message replay; an omitted
store on those helpers uses the process-global JSONL store, **not** the runner's
store. App hosts can pass `eventBus: new TypedBus()` to reuse subscriptions across
runner replacements. Session storage paths and JSONL format are unchanged.

**SDK migration:** The package root no longer exports singleton `prompt`,
`cancel`, `isActive`, `bus`, `globalHooks`, `register`, or `listTools`. Replace
singleton calls with runner methods, subscribe through `runner.bus`, and provide
agent tools or runner plugins/hooks explicitly. The old singleton implementations
remain on internal subpaths for the web backend's local routes; this is not a
promise of continued public support. Direct imports of Quark's `bootstrap` and
`resetBootstrap` must likewise move to explicit runner setup.

**Undo limit:** `/undo` works with the app's default JSONL store only. A custom
store is rejected without changing files or history; it cannot use `/undo` until
snapshot tracking is made store-owned.

---

## Session discovery API

An external process — an orchestrator, a dashboard — can learn which session a
running TUI is on. Start the TUI with a port, then read the single endpoint:

```bash
QUARK_API_PORT=47831 quark
curl http://127.0.0.1:47831/api/session/current
```

```json
{ "sessionId": "PRCglgkAzWjgDWhK", "pid": 46695 }
```

It answers `204 No Content` until the first message creates a session, and
follows `/new`, session switches, and branches. Read-only, bound to `127.0.0.1`
only, off unless `QUARK_API_PORT` is set. `@quark/runner` is deliberately not
involved: it holds many sessions and cannot know which one the user is on.

---

## Web API

The full reference lives at <http://quark-doc.home.arpa> (`docs/api`).

`bun run web:serve` starts the web backend (`web/server.ts`, Bun, default port
`4173`, override with `PORT`) and serves both the UI and a JSON API under
`/api/`. External processes can send a message — including image attachments —
with a single POST:

```bash
curl -X POST http://127.0.0.1:4173/api/sessions/$SESSION_ID/messages \
  -H 'content-type: application/json' \
  -d '{
    "text": "what is wrong here?",
    "images": [{ "mime": "image/png", "data": "<base64>" }]
  }'
```

`text` is required; `images` is optional and omitted or empty behaves exactly as
before. Images are base64-encoded (a ~33% wire tax) and validated before the
engine sees them:

| Limit | Value |
| -- | -- |
| Request body | 10 MiB |
| Images per message | 8 |
| Decoded size per image | 5 MiB |
| Supported `mime` | `image/png`, `image/jpeg`, `image/gif`, `image/webp` |

Responses: `202` accepted (turn runs asynchronously — subscribe to
`GET /api/sessions/:id/events`), `400` malformed body/text/image (the message
names the offending `images[index]`), `409` session already running, `413` body
over the ceiling.

### Runner API

The routes above run the server's *own* agent against the shared session store.
For an isolated execution instance — its own event bus, cancellation state, and
hooks — mint a runner first:

```bash
RUNNER_ID=$(curl -s -X POST http://127.0.0.1:4173/api/runners \
  -H 'content-type: application/json' -d '{"agentId":"coder"}' | jq -r .runnerId)

curl -X POST http://127.0.0.1:4173/api/runners/$RUNNER_ID/session/prompt \
  -H 'content-type: application/json' \
  -d '{"text":"what is wrong here?","images":[{"mime":"image/png","data":"<base64>"}]}'
# → 202 {"runnerId":"...","sessionId":"..."}
```

Echo `runnerId` on every later call, and `sessionId` to continue that
conversation (omit it to start a new one). Sessions are shared, persistent state:
any runner can resume a session by `sessionId`, including one minted after a
server restart.

A runner is one process serving many sessions, so its cwd is the server's, not
any one task's. Name the directory a turn must execute in with the optional
`targetWorkspace` — an absolute, existing directory. It drives the system
prompt's environment block, `AGENTS.md` reads, and every tool's relative-path
resolution (and subagent cwd), so the agent runs where the caller says without a
process-wide `chdir`. On creation it is stored as the session's `directory`; on
resume the stored directory is authoritative, and naming a different one is a
`409`. Omit it to keep the server's process cwd.

| Route | Behavior |
| -- | -- |
| `POST /api/runners` | `{agentId?}` (default agent when omitted) → `201 {runnerId}`. `404` unknown agent, `503` at the 100-runner cap. |
| `POST /api/runners/:id/session/prompt` | `{sessionId?,text,images?,targetWorkspace?}` → `202 {runnerId,sessionId}`; same limits and validation as the message route above. `400` bad workspace (not absolute, missing, or not a directory), `409` session already running (across all runners) or already bound to another workspace. |
| `GET /api/runners/:id/sessions/:sessionId` | `{session,messages,tokensUsed}`; `404` unknown runner or session. |
| `GET /api/runners/:id/sessions/:sessionId/events` | SSE stream from the runner that owns the active turn (same event shapes as `/api/sessions/:id/events`). |
| `POST /api/runners/:id/sessions/:sessionId/cancel` | Aborts the in-flight turn → `{cancelled:true}`. |
| `DELETE /api/runners/:id` | Drops the runner; sessions stay on disk. `409` while a turn is in flight. |

Sessions are persisted on disk in one namespace shared by REST runners and
the CLI/TUI, `~/.config/quark/session/runners/<sessionId>/`. New CLI/TUI
sessions use this location too, so `quark --session <sessionId>` can resume a
REST runner session. Older sessions under `~/.config/quark/session/<sessionId>/`
are not found by the CLI/TUI. Session IDs are restricted to `[A-Za-z0-9_-]+` (the ID alphabet the
engine generates) so a caller cannot escape that namespace.

The runner *registry* is process-local: runner IDs are minted per process, so a
server restart ends every runner. Sessions survive — mint a new runner and
resume a `sessionId` to continue its history. Deleting a runner (or evicting the
oldest idle runner at the 100-runner cap) only drops the execution handle; it
never deletes session files. Because all runners share one namespace, two
concurrent turns on the same `sessionId` are refused with `409` rather than
interleaving writes. Tool definitions are materialized from disk; only `agentId`
is accepted over HTTP.

The server binds `127.0.0.1` by default. This API has no authentication and can
run tools on this machine, so set `QUARK_WEB_HOST=0.0.0.0` (or a specific
interface) only behind auth or a reverse proxy.

---

## Development

```bash
bun run dev          # run the TUI from source
bun run cli          # run the CLI from source
bun run typecheck    # type-check the project
bun run build        # bundle to dist/ (Bun + TypeScript declarations)
bun run docs         # generate API docs with TypeDoc
bun test             # run the test suite
```

> Always run the tests after changing core functionality. Quark's moat is
> test-backed tools — keep it that way.

---

## Status

Quark is early and under active development — some tools listed in the
[CHANGELOG](CHANGELOG.md) are still being implemented or ship as examples. Expect
the surface area to change.

## License

[MIT](LICENSE).
