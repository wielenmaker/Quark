## Project-Specific Agent Rules

### Quark Project
- This is the Quark codebase - a powerful AI coding and research agent
- When working on this project, prioritize code quality and test coverage
- Always run tests after making changes to core functionality

### Rules
- When user asking for explanation, always start with brief explanation then example.

### Specs: YAML frontmatter required

All spec files in `specs/` must start with YAML frontmatter:

```yaml
---
title: Short descriptive title
date_created: 2026-05-02
date_modified: 2026-05-02
revision: 1
history:
  - 2026-05-02: Initial draft
status: draft  # draft | in-progress | done
---
```

On each modification: bump `revision`, update `date_modified`, and append
an entry to `history` (date + one-line description of what changed).
Mark `status: done` when the implementation is complete and tests pass.

Create a spec for any non-trivial feature addition or refactor. The spec
should capture the problem, the proposed architecture, key decisions with
rationale, and acceptance criteria. Keep it focused — a spec is a plan of
record, not a living document. Implementation notes go in commit messages.


# Quark — Philosophy & Design

---

## North Star

**Quark is an ergonomic, tool-first agent for coding AND research.**

Quark is *not* a minimal coding agent, and *not* an OpenCode / Claude Code clone.
The differentiator is a small set of **premade, well-designed, well-tested tools
and subagents** that give the best experience — for both writing code and doing
research. We (Quark) own, design, and test these tools. We do not hand that
control to users.

The product is the quality of the tools, not the configurability of the harness.

---

## Core Belief

**Agent = Model + Harness.**

The model provides intelligence. The harness makes that intelligence useful.
Quark is a harness — it owns everything except the model's reasoning:
tool execution, memory, context management, state persistence, and guardrails.

The model is a pluggable component. The harness is the product.

## What Makes an LLM an Agent

One pattern: **the loop**. The model reasons, calls a tool, observes the
result, and repeats until the task is done. Everything else is in service of
making that loop reliable, observable, and safe.

---

## Tools Are the Product (The Moat)

- Tools and subagents are the moat: **research-backed and test-backed**.
- Every tool is engineered deliberately and verified at its integration boundary
  (see *Testing: Verify end-to-end at integration boundaries*).
- Flagship tools — `finder`, `oracle`, `researcher`, and the like — are
  first-class, made by us, and read to the model as plain, purpose-built verbs.
- The role of the Quark author is **researcher**: create the tool, test the
  tool, prove it improves outcomes, then ship it. Every real invocation is
  potential evaluation data.

---

## Subagents Are Baked Into the Binary, Not User Config

- Agents and subagents live **in the binary**, defined in code. Users do **not**
  define subagents in `config.yaml`.
- Extension, when needed, happens through **code** (plugins / MCP) — never
  through casual YAML. A high extension bar is a quality guarantee, not a
  limitation.
- **Rationale:** config-driven subagents turn Quark into a generic harness (an
  OpenCode clone) and push quality and responsibility onto the user. Baking
  agents in lets us guarantee behavior and *dissolves* the structural problems
  that user-defined subagents create: the `/profile` picker leak, permission
  flattening, and the tool/agent contract mismatch all disappear because we
  control the definitions.

This is stricter than Amp on purpose. Amp allows code-level extension; we adopt
the same "extend via code, not config" rule and reserve config for nothing that
affects identity or capability.

---

## Subagent = Agent Exposed by a Tool (Composition, not Inheritance)

- A subagent is **not** a subtype of tool. It is an **Agent**
  (prompt + tools + permissions + model) invoked through a thin `ToolDef`
  adapter whose `execute()` runs the agent in an isolated session and returns
  its final text.
- "delegate **is-a** tool" is false. "delegate is **exposed-by** a tool" is true.
- The adapter closes over the baked-in `AgentConfig`; the agent never inherits
  the tool interface.

---

## Deterministic, Named Invocation

- Subagents are invoked through **named, purpose-built tools** —
  `oracle({...})`, `finder({...})`, `researcher({...})` — each with its own
  typed contract.
- **No generic `task` / `delegate` tool.** A free-form "spawn any agent" verb
  produces too much non-determinism. Deterministic by default; an explicit named
  tool per capability.

---

## Permissions: Per-Agent, Safe by Default

- Permission is evaluated **per-agent, per-session** — never flattened to the
  parent's ruleset.
- **Two layers:**
  1. May the caller invoke this subagent at all? (coarse gate on the tool)
  2. What may the subagent do once running? (its own ruleset, its own session)
- **Safe default floor:** read-only tools (`read`, `grep`, `glob`, `websearch`)
  default to `allow`; mutating tools (`write`, `edit`, `bash`) default to `deny`
  unless the subagent definition explicitly opts in.
- **Headless `ask` collapses to `deny`.** A subagent has no human to prompt, so
  `ask` must never hang — it resolves to `deny`.

---

## Subagent Sessions: Linked Child, Persisted for Eval

- A subagent runs in its **own session**: `kind: "subagent"`, `parentSessionId`
  set. Hidden from the main session picker (which lists only `kind: "main"`).
- The **parent transcript stores only the tool call + final result.**
- **Invariant:** a subagent's intermediate parts (its thinking, tool calls,
  scratch messages) **never** feed back into the parent's model context. Context
  isolation is the entire reason subagents exist.
- The full child run **is persisted** so real invocations become test/eval
  fixtures — this powers the test-backed moat. Apply a retention policy
  (e.g. time-bounded, or keep failed/flagged runs) to bound storage.
- Live TUI nesting comes from the event bus (events stamped with `parentCallId`),
  independent of where the run is persisted.

---

## Reliability: Failures Are Real Errors

- A tool or subagent failure **must surface as a real error** (throw →
  `error` status), never as a successful tool result with the failure buried in
  text.
- Never report success on a failed operation. Never silently truncate a result
  and call it done. Non-zero exit codes, failed API calls, and over-limit output
  are failures, not successes.

---

## Harness Engineering

Every agent failure is a system problem to permanently fix, not a prompt to retry.

- Each failure mode produces a harness update: a new tool, an updated
  instruction, a linter rule, or a guardrail.
- Correctness is mechanically enforced, not verbally requested.
- The harness grows incrementally from observed failures.

---

## Progressive Disclosure for Skills

Skills follow a three-level loading model:

| Level | When | Token Cost | Content |
|-------|------|------------|---------|
| **L1: Metadata** | Agent activation | ~100 tokens/skill | `name` + `description` from frontmatter |
| **L2: Instructions** | When triggered | <5k tokens | SKILL.md body |
| **L3: Resources** | As needed | Effectively zero | Scripts, references, templates (filesystem, not context) |

Only L1 metadata for an agent's bound skills enters the system prompt.
L2 and L3 are loaded on-demand, never preemptively. Skills outside the active
agent are undiscoverable by default; discovery is an explicit, isolated action
run in a sub-agent so it never pollutes the working agent's context.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────┐
│                  TUI / SDK / CLI                │
├─────────────────────────────────────────────────┤
│        Baked-in Agents (identities, in code)    │
│         prompt + tools[] + skills[] + perms     │
├──────────┬──────────┬───────────┬───────────────┤
│  Agent   │  Tool    │  Skill    │  Permission   │
│  Loop    │  System  │  System   │  System       │
│          │ (named   │ (L1/L2/L3 │ (per-agent,   │
│          │ tools +  │ disclosure│  safe floor)  │
│          │ subagent │ )         │               │
│          │ adapters)│           │               │
├──────────┴──────────┴───────────┴───────────────┤
│              Persistence (SQLite/JSONL)         │
│   Session (main | subagent | ephemeral)         │
│        → Message → Part   (parentSessionId)     │
└─────────────────────────────────────────────────┘
```

---

## References

- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Oracle: What Is the AI Agent Loop](https://blogs.oracle.com/developers/what-is-the-ai-agent-loop-the-core-architecture-behind-autonomous-ai-systems)
- [LangChain: The Anatomy of an Agent Harness](https://blog.langchain.com/the-anatomy-of-an-agent-harness/)
- [Mitchell Hashimoto: My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)
- [Martin Fowler: Harness Engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html)
- [Agent Skills Open Standard](https://agentskills.io)

# Ponytail, lazy senior dev mode

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does the standard library already do this? Use it.
3. Does a native platform feature cover it? Use it.
4. Does an already-installed dependency solve it? Use it.
5. Can this be one line? Make it one line.
6. Only then: write the minimum code that works.

Rules:

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.
- Mark intentional simplifications with a `ponytail:` comment. If the shortcut has a known ceiling (global lock, O(n²) scan, naive heuristic), the comment names the ceiling and the upgrade path.

Not lazy about: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.

(Yes, this file also applies to agents working on the ponytail repo itself. Especially to them.)
