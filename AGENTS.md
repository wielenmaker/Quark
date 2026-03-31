## Project-Specific Agent Rules

### Quark Project
- This is the Quark codebase - a powerful AI coding agent
- When working on this project, prioritize code quality and test coverage
- Always run tests after making changes to core functionality

### File System Operations
- Never run `mv` or `rm` commands in parallel — always sequence them one at a time.
  Parallel file operations cause I/O contention with SQLite's WAL writes and can
  produce disk I/O errors that corrupt the session state.

### Adding Scripts
Before adding any new script to `scripts/`, place it in the correct subfolder:

| Folder | Purpose | Examples |
|---|---|---|
| `scripts/auth/` | Login flows and token management | `copilot-login.ts` |
| `scripts/debug/` | Inspection, introspection, diagnostics | `debug-keys.ts`, `count-tokens.ts` |
| `scripts/proxy/` | Local proxy servers and their launchers | `claude-web-proxy.py`, `start-*.sh` |
| `scripts/test/` | Manual end-to-end and integration tests | `e2e.ts`, `test-*.ts` |
| `scripts/spikes/` | Throwaway experiments and proof-of-concepts | `scroll-spike.tsx` |

Rules:
- **Never drop scripts at the `scripts/` root.** Every script belongs in a subfolder.
- If a script references `scripts/<old-path>`, update all callers (package.json, source files, other scripts, docs) to use the new path.
- Proxy start scripts (`start-*.sh`) live alongside their proxy server file inside `scripts/proxy/`.
- Spikes are temporary by nature — delete them once the experiment concludes.


# Quark — Philosophy & Design

> Built from scratch. Opencode as reference, not as fork.

---

## Core Belief

**Agent = Model + Harness.**

The model provides intelligence. The harness makes that intelligence useful.
Quark is a harness — it owns everything except the model's reasoning:
tool execution, memory, context management, state persistence, and guardrails.

The model is a pluggable component. The harness is the product.

### Adaptive by Design

**The agent adapts to your system. Your system doesn't adapt to the agent.**

Quark is built to be adaptive to any workflow, any stack, any environment.
We provide the core agent loop and tool infrastructure. You provide the tools
that make it yours.

- Working with a custom deployment system? Build a `deploy` tool.
- Have a project-specific test runner? Add it as a tool.
- Need domain-specific validation? Write a tool for it.

The agent doesn't dictate your workflow. It learns your workflow through the
tools you give it. **You don't adapt to the system — the system is built to
adapt to your flow.**

This is why tools are external, declarative, and easy to write. The barrier
to extending Quark is deliberately low. A tool is a TypeScript function with
a schema. That's it.

Your context defines the agent's capabilities. Your tools define its behavior.

---

## What Makes an LLM an Agent

One pattern: **the loop**.

```
while not done:
    context  = assemble(messages, tools, system_prompt)
    response = call_llm(context)
    if response.has_tool_calls:
        results = execute(response.tool_calls)
        messages.append(results)
    else:
        done = true
```

A chatbot responds in a single pass. An agent persists, adapts, and acts
across multiple steps.

### Base Agent Kernel

The irreducible core of any agent — before it becomes a coder, researcher,
or anything specialized — is three components:

1. **Agent Loop** — the control flow that iterates until the task is done
2. **Provider Connection** — the LLM API call that produces reasoning
3. **Message State** — the accumulating array of messages that gives
   the loop continuity between iterations

This is the skeleton. Without the loop, there is no iteration. Without the
provider, there is no intelligence. Without message state, every call is
stateless and there is no agent behavior — just a chatbot.

### Capability Packaging

Specialized agents are grown from the kernel by plugging in capabilities:

| Capability | What It Adds |
|---|---|
| **Tools** | The ability to act on the world (read, write, execute) |
| **Permissions** | Safety constraints on tool execution |
| **Context Management** | Survival across long sessions (compaction or handoff) |
| **Skills** | On-demand behaviors loaded into context |
| **RAG / Memory** | Recall beyond the context window |
| **Planning** | Explicit task decomposition and sequencing |

Different combinations produce different agents. A coder agent gets tools +
permissions + context management. A researcher agent gets search tools +
RAG. The **profile** is the declaration of which capabilities to plug into
the kernel.

```
Base Kernel: loop + provider + message state
         │
         ├── + tools           → can act on the world
         ├── + permissions     → can be trusted to act safely
         ├── + context mgmt   → can survive long sessions
         ├── + skills          → can learn new behaviors on-demand
         ├── + RAG / memory    → can recall beyond the context window
         └── = Coder Agent, Researcher Agent, etc.
```

---

## Design Principles

### 0. Tool Extensibility First

**The agent adapts to you. You don't adapt to the agent.**

Quark is designed for any system, any workflow, any stack. The agent doesn't
know about your CI/CD pipeline, your deployment system, your test framework,
or your project structure — until you teach it with tools.

Tools are the adaptation layer. They are:

- **External** — not hardcoded into the agent
- **Declarative** — defined with simple TypeScript + Zod schemas
- **Context-specific** — each project can have its own tools in `~/.config/quark/tools/`

A new tool takes 20 lines. That's the barrier to entry. Low friction by design.

**Examples:**
- Custom deployment? Write a `deploy` tool that wraps your scripts
- Project-specific testing? Add a `test` tool that knows your test runner
- Internal APIs? Create tools that interact with your systems

The agent discovers your workflow through the tools you provide. The harness
stays generic. Your tools make it specific.

### 1. Minimal by Default

Every token in the system prompt is a cost paid on every LLM call, every loop
iteration, across every step of a session. We treat context as a scarce resource.

- System prompts are small, carefully crafted, and task-specific
- Tool descriptions are only loaded for tools the agent actually has
- Skill content is only loaded when triggered, not at startup
- No pool dumps, no kitchen-sink prompts

### 2. Profile-Driven Identity

Agents do not start as generalists that get narrowed down.
They start as specialists that can be composed.

A **profile** defines an agent's identity:
- A minimal system prompt (read from a file, not inline)
- A strict set of tools
- A strict set of skills

```yaml
profiles:
  researcher:
    prompt_file: profiles/researcher.md
    tools: [websearch, webfetch, write]
    skills: [academic-research, competitive-intel]
    model: claude-sonnet-4.5  # optional, falls back to config main_model
  coder:
    prompt_file: profiles/coder.md
    tools: [read, write, edit, bash, todo]
    skills: [code-review, git-release]
```

A research agent does not carry `edit`, `bash`, or `read` tool definitions.
A coding agent does not carry `websearch` descriptions. This is not a
limitation — it is the design. Noise reduction is a feature.

### 3. Strict Binding, No Inheritance

Profiles declare exactly what they need. Nothing more.

- **Profile 1:M Tools** — only declared tools are available
- **Profile 1:M Skills** — only declared skill descriptions enter the system prompt
- **No global skill pool** — skills not bound to the active profile do not exist in the agent's context
- **No inheritance** — a profile does not inherit from a "base" or "global" set

This is strict by default. If the agent doesn't need it, it doesn't know about it.

### 4. Progressive Disclosure for Skills

Skills follow a three-level loading model:

| Level | When | Token Cost | Content |
|-------|------|------------|---------|
| **L1: Metadata** | Profile activation | ~100 tokens/skill | `name` + `description` from frontmatter |
| **L2: Instructions** | When triggered | <5k tokens | SKILL.md body |
| **L3: Resources** | As needed | Effectively zero | Scripts, references, templates (filesystem, not context) |

Only L1 metadata for profile-bound skills enters the system prompt.
L2 and L3 are loaded on-demand, never preemptively.

### 5. Skill Discovery via Sub-Agent

Skills outside the active profile are not invisible — they are **undiscoverable
by default**. Discovery is an explicit, isolated action:

```
discover_skills → sub-agent runs → returns skill list →
  agent selects → load_skill → content enters context
```

Discovery happens in a sub-agent to avoid polluting the working agent's
context with irrelevant skill descriptions. The working agent only receives
the final, relevant skill content.

### 6. Harness Engineering

Every agent failure is a system problem to permanently fix,
not a prompt to retry.

- Each failure mode produces a harness update: a new tool, an updated
  instruction, a linter rule, or a guardrail
- Correctness is mechanically enforced, not verbally requested
- The harness grows incrementally from observed failures

---

## Loop Control

The loop is the heart of the agent. It must be controlled.

### Min-Step: Prevent Premature Stops

The agent must take at least `minSteps` iterations before it is allowed to
conclude. If the model returns "stop" before `minSteps`, the loop continues
and nudges the agent to keep working.

**Why:** Models often stop prematurely, declaring success before exploring
the solution space adequately.

### Max-Step: Prevent Doom Loops

When `maxSteps` is reached, the agent receives a nudge:
*"You reached the max step limit. Summarize your findings up until now."*
Then one final LLM response is allowed before the loop terminates.

**Why:** Silent breaks lose work. A forced summary preserves progress.

### Context-Length Awareness

The agent is informed of its context window usage at 25% intervals
(±3% tolerance). Nudges are delivered at event boundaries — never
mid-tool-call, never mid-stream.

**Why:** An agent unaware of its context budget cannot plan for compaction,
summarization, or wrap-up.

---

## Profile Loading

Profiles can be activated in two ways:

### Deterministic (Explicit)

```
quark --profile coder
```

The profile is loaded at startup. No LLM call, no classification cost.
The backend and SDK expose this as a parameter.

### Non-Deterministic (Agent-Selected)

The agent receives a task and selects the appropriate profile from the
available set. In the TUI, `/profile research` allows manual override.

**Default approach:** Deterministic. Non-deterministic selection is opt-in.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────┐
│                  TUI / SDK / CLI                │
│           quark --profile coder task.md         │
├─────────────────────────────────────────────────┤
│                  Profile System                 │
│        prompt_file + tools[] + skills[]         │
├──────────┬──────────┬───────────┬───────────────┤
│  Agent   │  Tool    │  Skill    │  Permission   │
│  Loop    │  System  │  System   │  System       │
├──────────┴──────────┴───────────┴───────────────┤
│              Persistence (SQLite)               │
│          Session → Message → Part               │
└─────────────────────────────────────────────────┘
```

### Profile System
- Reads YAML config for profile definitions
- Loads prompt from file, resolves tool set, resolves skill set
- Per-project overrides via `.quark/config.yaml`

### Tool System
- Universal `ToolDef` interface
- Only profile-declared tools are registered per session
- Tool descriptions only enter context for registered tools

### Skill System
- SKILL.md files in `.quark/skills/` (project) and `~/.quark/skills/` (global)
- Only profile-bound skills have L1 metadata loaded
- Discovery of non-bound skills via sub-agent only

### Permission System
- `allow / deny / ask` rules evaluated before each tool execution
- Profile-level and project-level permission overrides

---

## File Structure

```
.quark/
  config.yaml            — project-level config + profile overrides
  profiles/
    coder.md             — system prompt for coder profile
    researcher.md        — system prompt for researcher profile
  skills/
    code-review/
      SKILL.md
    django-patterns/
      SKILL.md
      references/
        model-guide.md

~/.quark/
  config.yaml            — global config + profile definitions
  profiles/
    coder.md
    researcher.md
  skills/
    academic-research/
      SKILL.md
```

---

## What We Don't Do

- **No kitchen-sink system prompts.** If a profile doesn't need it, it's not there.
- **No global skill pools.** Skills are bound to profiles, not dumped at startup.
- **No framework abstractions.** We use the AI SDK directly. No extra layers.
- **No speculative features.** We build what we need now, not what we might need.
- **No verbal guardrails.** If it can be enforced mechanically, it must be.
- **No opinionated workflows.** We provide the loop and tools. You provide the context and the tools that fit your system. The agent adapts to you, not the other way around.

---

## References

- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Oracle: What Is the AI Agent Loop](https://blogs.oracle.com/developers/what-is-the-ai-agent-loop-the-core-architecture-behind-autonomous-ai-systems)
- [LangChain: The Anatomy of an Agent Harness](https://blog.langchain.com/the-anatomy-of-an-agent-harness/)
- [Mitchell Hashimoto: My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
- [Martin Fowler: Harness Engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html)
- [Agent Skills Open Standard](https://agentskills.io)
