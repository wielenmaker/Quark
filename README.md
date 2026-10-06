# Quark

**The agent runtime written in TypeScript — built for the cloud, for research, and for embedding into larger agentic systems.**

Quark owns the boring parts of an agent: sessions, streaming, tools, providers, cancellation, credentials.
You own the agent.

> Status: `0.1.x` — moving fast, APIs may break. See [CHANGELOG.md](CHANGELOG.md).

---

## Two things are called Quark

The **runtime** is the product. The **coding agent** is one opinionated assembly of it.

```diagram
Quark coding agent  =  Quark runtime
                     + TUI
                     + Conversation history
                     + External tooling   (custom tools · MCP)
                     + Working spaces     (directories · git worktrees)
```

| | What it is | Package |
|---|---|---|
| **Quark runtime** | Agent loop, providers, tools, sessions, events, ACP. Headless, config-free, no process globals. | `@quark/runner` · `@quark/acp` |
| **Quark coding agent** | TUI + CLI assembled from the runtime. Batteries included, optional. | `quark` |

## Runtime anatomy

```diagram
        ╭────────────────╮         ╭────────────────────╮         ╭───────────────────╮
        │ Working spaces │         │  Session history   │         │   Agent config    │
        │ cwd · worktrees│────────▶│ append-only JSONL  │◀────────│ profile/<id>.yaml │
        ╰────────────────╯         ╰────────────────────╯         ╰───────────────────╯
                   ▲                         ▲                            ▲
                   │                         │                            │
           ╭───────┴─────────────────────────┴────────────────────────────┴────────╮
           │                             Quark runtime                             │
           │                       ╭────────────────────────╮                      │
           │                       │      Agent runner      │                      │
           │                       │  loop · streaming ·    │                      │
           │                       │  tools · subagents     │                      │
           │                       ╰────────────────────────╯                      │
           ╰────────┬─────────────────────────┬────────────────────────┬───────────╯
                    ▼                         ▼                        ▼
        ╭────────────────────╮    ╭────────────────────╮    ╭────────────────────╮
        │   Authentication   │    │  External tooling  │    │     Providers      │
        │ credential store · │    │ custom TS tools ·  │    │ anthropic · openai │
        │ OAuth device flow  │    │ stdio MCP servers  │    │ copilot · ollama … │
        ╰────────────────────╯    ╰────────────────────╯    ╰────────────────────╯
```

## Design principles

- **Cloud-first.** One process can host many runners. Each runner owns its event bus, cancellation state, hooks, and store. Turns take an explicit `targetWorkspace`, so one server can work on many repos without `chdir`.
- **Research-friendly.** Every session is an append-only JSONL log — inspect it, replay it, branch it. No hidden state in a database.
- **Integration-first.** Embed the runtime in your own system, or drive it over ACP from an editor. No UI code required.
- **Boring at the edges.** The engine never reads config files or env vars; hosts pass providers, policies, and stores explicitly.

---

## Quickstart

Requirements: [Bun](https://bun.sh) (build + TUI), Node 20+ (built CLI), and an API key for at least one provider.

```bash
git clone https://github.com/huypham37/Quark.git
cd Quark
bun install
bun run build

bin/quark                      # interactive TUI
bin/quark "explain this repo"  # one-off message
```

Authenticate once (or set a standard env var such as `ANTHROPIC_API_KEY`):

```bash
bin/quark auth login anthropic
bin/quark auth status
```

Docker:

```bash
docker build -t quark .
docker run -it --rm -v ~/.config/quark:/root/.config/quark quark
```

Install locally from the checkout (no registry needed):

```bash
bun scripts/install-local.ts   # build → pack → install → verify → switch
quark doctor                   # check runtimes, config, tools, subagent command
```

The command lands at `~/.local/bin/quark` and runs a versioned copy under `~/.local/share/quark` (`QUARK_HOME` overrides; `--list`, `--use <version>`, `--rollback` manage versions). Your config at `~/.config/quark` is never touched. Development checkouts keep using `bin/quark` / `bun run dev`.

## CLI

| Command | What it does |
|---|---|
| `quark` | Interactive TUI |
| `quark "message"` | One-off run (`-m` also works) |
| `quark -a <agent>` | Pick an agent (default: `default_agent` in config) |
| `quark --model <provider/model>` | Override model for this run |
| `quark -s <session-id>` | Resume a session |
| `quark --no-store` | Ephemeral run — never written to disk |
| `quark -l` | List available agents |
| `quark --verbose` | Print every tool call and result to stderr |
| `quark auth login\|status\|logout <provider>` | Manage credentials |
| `quark acp [--agent <id>]` | Serve ACP over stdio (editor integration) |
| `quark doctor` | Diagnose the install: app location, runtimes, config, tools, subagent command |

TUI essentials: `/new` fresh session · `/agent` switch agent · `/settings` edit config · `/undo` revert last file changes.

## Configuration

Config lives at `~/.config/quark/config.yaml` (`QUARK_CONFIG_DIR` overrides the whole config root).

```yaml
version: 3

models:
  small: openai/gpt-5-mini        # titles, compaction

default_agent: coder
max_steps: 100
editor: nvim

branching:
  auto: true
  threshold: 0.90

# Only endpoints Quark does not bundle belong here.
providers:
  my-endpoint:
    base_url: https://api.example.com/v1
    api_key: env:MY_ENDPOINT_KEY
```

Agents are single YAML files at `~/.config/quark/profile/<id>.yaml`:

```yaml
name: Researcher
description: Investigates code and reports evidence
model:
  id: anthropic/claude-opus-4-6
  thinking_effort: high
tools: [read, skill, write, bash]
skills: [focus]
subagents: [coder]
prompt: |
  Investigate the question and report evidence.
```

**Bundled providers:** Anthropic, OpenAI, OpenRouter, DeepSeek, OpenCode Go, GitHub Copilot, OpenAI Codex (ChatGPT plan), Ollama, LM Studio — plus any OpenAI-compatible endpoint.

## Tools, skills, subagents

- **Engine built-ins:** `read`, `look` (images), `skill`, `question` (ask the user mid-run).
- **External tools:** TypeScript modules at `<config>/tools/<id>.ts`, referenced by id from an agent's `tools[]`. Typical set: `write`, `edit`, `bash`, `glob`, `grep`, `websearch`, `webfetch`, `todo`. The typical set ships with the app (compiled into `dist/tools`); a personal file of the same id overrides the bundled one.
- **Skills:** progressive-disclosure instructions at `.quark/skills/*/SKILL.md` (project) and `<config>/skills/*/SKILL.md` (global).
- **Subagents:** a subagent is an agent exposed as a tool. It runs in an isolated child session, so its reasoning never pollutes the parent transcript.
- **MCP:** when driven over ACP, stdio MCP servers handed over by the client are connected per session, and their tools are namespaced `mcp__<server>__<tool>`.

## Sessions

```diagram
~/.config/quark/session/runners/<session-id>/
├── session.jsonl   # append-only: messages, tool calls, usage
└── meta.json       # listing cache: title, timestamps, pin
```

- Resume with `quark -s <session-id>` — any interface (CLI, TUI, ACP) can pick up the same session.
- Subagent sessions link back to their parent (`parentSessionId`).
- `--no-store` skips disk entirely.

---

## Embedding the runtime

```ts
import { createRunner, defineAgent, createJsonlSessionStore } from "@quark/runner"

const agent = defineAgent({
  id: "reviewer",
  instructions: "Review diffs and report issues.",
  tools: [],
  model: "anthropic/claude-opus-4-6",
})

const runner = createRunner({ agent, store: createJsonlSessionStore(root) })

runner.bus.on("text-delta", ({ delta }) => process.stdout.write(delta))

await runner.prompt({
  parts: [{ type: "text", text: "Review the staged changes." }],
  targetWorkspace: "/srv/checkout",   // absolute; drives tools + system prompt
})
```

Rules of thumb:

- Two runners with the same session id never share history — state is instance-scoped by default.
- `targetWorkspace` pins a turn (and its subagents) to one directory; the process never `chdir`s.
- Pass an explicit store to persist; the default is in-memory so nothing touches `~/.config`.

## Editor integration (ACP)

`quark acp` speaks the Agent Client Protocol over stdio (works with Zed's Agent Panel):

- Every agent manifest appears as a **mode** in the editor's picker.
- Model and thinking-effort pickers follow the active agent's settings and your credentials.
- Switching modes rebinds the session — tools, prompt, skills, and model — without relaunching.
- Stdio MCP servers from the editor are connected per session.

## Repository layout

```diagram
Quark/
├── packages/runner/   # engine + SDK          → @quark/runner
├── packages/acp/      # ACP server            → @quark/acp
└── packages/quark/    # CLI + TUI             → quark
```

## Development

```bash
bun run dev        # TUI from source
bun run cli        # CLI from source
bun test           # test suite
bun run typecheck  # type-check everything
bun run build      # bundle dist/ (Bun + .d.ts)
bun run docs       # generate TypeDoc
```

## Documentation

- Full docs (CLI, SDK, design notes): <http://quark-doc.home.arpa> — internal homelab deployment, separate repo.

## License

MIT — see [LICENSE](LICENSE).
