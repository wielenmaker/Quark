---
title: "Verbose Tool-Call Logging in CLI Mode"
date_created: 2026-05-27
date_modified: 2026-05-27
revision: 4
history:
  - 2026-05-27: Initial draft — plan to print tool name + parameters under --verbose
  - 2026-05-27: Implemented. Extracted formatter to src/debug/format-tool-args.ts (cli.ts runs main() on import, so the formatter could not live there for unit testing). Unit tests + typecheck green; manual TUI/CLI E2E with a real model still pending.
  - 2026-05-27: Switched output prefix to standard `[TOOL-CALL]` / `[TOOL-RESULT]` / `[TOOL-CALL:RAW]` written directly to stderr via console.error. Namespaces renamed from `tool` / `tool:input-raw` to `tool-call` / `tool-result` / `tool-call:raw`. Updated debug.ts and README.
  - 2026-05-27: Narrowed `--verbose` scope. Real-world output showed `--verbose=QUARK_DEBUG=*` floods stderr with `[processor]`, `[cli]`, `[loop]`, `[models]`, `[compaction]`. `setVerbose(true)` now sets `QUARK_DEBUG=tool-call,tool-result` so `--verbose` is a user-facing "show me what the agent is doing" flag. Engine-level debugging still available via `QUARK_DEBUG=*` or `QUARK_VERBOSE=1`.
status: in-progress
---

# Verbose Tool-Call Logging in CLI Mode

## Problem

When users run the CLI with `--verbose` (or `QUARK_DEBUG=*`), they expect to see
every tool the agent invokes along with the arguments it passed. Today, debug
output is **transport-level**, not **semantic**:

```
[processor] event: tool-input-start
[processor] event: tool-call
[processor] event: tool-result
[processor] event: finish-step (reason=tool-calls)
```

The event type is logged, but `toolName` and `input` are dropped. The CLI
itself never subscribes to `tool-start` / `tool-input` / `tool-end` on the bus,
so nothing reaches stdout/stderr from a user's point of view either.

## Goal

Under `--verbose` (or any debug namespace that opts in), the CLI must print, for
every tool invocation:

```
[tool] read({ path: "/abs/path/foo.ts", read_range: [1, 100] })
[tool] ↳ ok (1.2s, 4.3kb)

[tool] bash({ cmd: "rg -n 'foo'", cwd: "/abs/path" })
[tool] ↳ error: ENOENT
```

Non-verbose output stays unchanged (no regression to the default `prompt → text`
stream).

## Non-Goals

- No new `--print-tools` flag. Reuse the existing `--verbose` / `QUARK_DEBUG`
  surface area. One knob.
- No changes to the bus event shape or to persistence. The data is already
  there ([`src/session/events.ts`](../src/session/events.ts) — `tool-input` carries
  `tool` and `input`).
- No pretty-printer for tool outputs beyond a one-line status. Full output is
  still available via session replay / TUI.

## Architecture

Two surfaces emit logs today; we touch exactly one of each.

```
┌──────────────────────┐        ┌──────────────────────────┐
│ processor.ts          │  bus   │ cli.ts                   │
│  fullStream pump      │ ─────▶ │  bus.on("tool-input")    │ ── stderr
│  dlog("event:", t)    │        │  bus.on("tool-end")      │
└──────────────────────┘        └──────────────────────────┘
        ▲                                  ▲
        │                                  │
        └── debug("processor")             └── debug("cli")
```

### Change 1 — CLI subscribes to bus tool events (primary)

In [`src/cli.ts`](../src/cli.ts) near the existing `bus.on("text-*")` block, add:

```ts
const tlog = debug("tool")

bus.on("tool-input", ({ tool, input }) => {
  if (!tlog.enabled) return
  tlog(`${tool}(${formatArgs(input)})`)
})

bus.on("tool-end", ({ tool, status, error, output }) => {
  if (!tlog.enabled) return
  if (status === "error") tlog(`↳ ${tool} error: ${error}`)
  else                    tlog(`↳ ${tool} ok${output ? ` (${output.length}b)` : ""}`)
})
```

`formatArgs` is a small helper (same file, ~10 lines) that:
- pretty-prints small objects on one line
- truncates string values >120 chars to `"…(N chars)"`
- collapses arrays >5 items to `[a, b, c, …(N)]`
- redacts keys matching `/token|secret|key|password/i` to `"***"`

This is the **only** place the user-visible log line is emitted. The processor
keeps its low-level event log under `debug("processor")` for transport
debugging.

### Change 2 — register the new namespace

Add `tool` to the documented namespace list in
[`src/debug.ts`](../src/debug.ts#L10-L17) (header comment) and to the README's
debug-namespace table. `--verbose` already turns on `*`, so no flag wiring
needed.

### Change 3 — optional finer dump under `debug("tool:input-raw")`

For deep debugging (oversized inputs, weird unicode), let users opt in to the
raw, untruncated JSON via `QUARK_DEBUG=tool,tool:input-raw`. Gate the
unredacted dump behind a second namespace so `--verbose` (which is `*`) gets it
too, but normal `tool` usage stays readable.

## File Changes

| File                      | Change                                              | LOC  |
|---------------------------|-----------------------------------------------------|------|
| `src/cli.ts`              | Add `tool-input` / `tool-end` subscribers + helper  | ~35  |
| `src/debug.ts`            | Document `tool` and `tool:input-raw` namespaces     | ~2   |
| `README.md`               | Add row to debug-namespace table                    | ~2   |
| `test/cli/verbose.test.ts`| New: assert formatted line for one tool call        | ~40  |

Total: ~80 LOC, one new test file. No production code outside `cli.ts`.

## Test Plan

1. **Unit** — `formatArgs` table tests: short string, long string, nested
   object, array truncation, redaction.
2. **Integration** — spawn `quark --verbose -p "read package.json"` in a child
   process, capture stderr, assert it contains
   `[tool] read({ path: ".../package.json" })` and `[tool] ↳ read ok`.
3. **Regression** — without `--verbose`, stderr must NOT contain `[tool]`.
4. **Manual E2E** — per AGENTS.md "Verify end-to-end at integration
   boundaries", run a real session through the TUI's CLI entry path with a
   multi-tool task (read → edit → bash) and confirm log order matches actual
   execution order.

## Acceptance Criteria

- [ ] `quark --verbose -p "<task that uses ≥1 tool>"` prints one
      `[tool] <name>(<args>)` line per call and a matching `↳` result line.
- [ ] Default invocation produces zero `[tool]` lines.
- [ ] `QUARK_DEBUG=tool` (without `*`) works identically to `--verbose` for
      tool logs but stays quiet about `processor`/`loop`.
- [ ] Redaction works: an arg named `apiKey` shows `***`.
- [ ] All existing tests pass; new tests added.

## Open Questions

1. Should tool result `output` be truncated or omitted entirely from the `↳`
   line? Proposed: show byte count only, never the body, to keep one-line
   format. The body is available via session replay.
2. Multi-line `input` values (e.g. `edit`'s `newString`) — collapse to
   `"line1\\n…(N lines)"` or keep on multiple lines? Proposed: collapse.
3. Color? Proposed: no — stderr is often piped to files; let the user pipe
   through their own pretty-printer if they want it.
