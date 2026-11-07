import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TypedBus } from "../../packages/runner/src/session/events"
import { SUBAGENT_EVENT_PREFIX, parseChildEventLine } from "../../packages/runner/src/subagent/protocol"
import { closeSubagents, runSubagent, SubagentExecutionError } from "../../packages/runner/src/subagent/supervisor"
import { createSubagentTool } from "../../packages/runner/src/tool/subagent"
import type { SubagentCommand } from "../../packages/runner/src/subagent/executable"
import type { ToolContext } from "../../packages/runner/src/tool/tool"

const tempDirs: string[] = []
afterEach(() => {
  closeSubagents()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function context(abort = new AbortController()): ToolContext {
  return { sessionId: "parent-session", messageId: "parent-message", callId: "parent-call", abort: abort.signal, bus: new TypedBus() }
}

function fixture(source: string): SubagentCommand {
  const dir = mkdtempSync(join(tmpdir(), "quark-subagent-fixture-"))
  tempDirs.push(dir)
  const file = join(dir, "child.ts")
  writeFileSync(file, source)
  return { command: process.execPath, args: [file] }
}

const workerSource = `
import { createInterface } from "node:readline"
const args = process.argv.slice(2)
if (JSON.stringify(args) !== JSON.stringify(["--agent", "finder", "--sub-agent"])) process.exit(2)
const id = process.env.QUARK_SUBAGENT_SESSION_ID
const emit = (event) => console.error("${SUBAGENT_EVENT_PREFIX}" + JSON.stringify(event))
emit({ e: "ready", sessionId: id, profile: "finder" })
const history = []
createInterface({ input: process.stdin }).on("line", (line) => {
  const { prompt } = JSON.parse(line)
  history.push(prompt)
  emit({ e: "tool-start", t: "read", id: "child-call" })
  emit({ e: "tool-input", t: "read", id: "child-call", in: { path: "x" } })
  emit({ e: "tool-running", id: "child-call" })
  emit({ e: "tool-end", t: "read", id: "child-call", s: "completed" })
  emit({ e: "text-delta", d: history.join(" -> ") })
  emit({ e: "loop-end" })
  // Deliberately emit result before stdout: ordering across pipes is irrelevant.
  emit({ e: "result", sessionId: id, profile: "finder", output: history.join(" -> ") + "\\n\\nKeep talking to finder with " + id })
  console.log("display-only output")
}).on("close", () => process.exit(0))
`

describe("subagent protocol", () => {
  test("parses lifecycle and result events, validates result identity fields", () => {
    expect(parseChildEventLine(`${SUBAGENT_EVENT_PREFIX}{"e":"tool-running","id":"call-1"}`)).toEqual({ e: "tool-running", id: "call-1" })
    expect(parseChildEventLine("ordinary stderr")).toBeNull()
    expect(parseChildEventLine(`${SUBAGENT_EVENT_PREFIX}{"e":"result","sessionId":"sa-1","profile":"finder","output":"done"}`)).toMatchObject({ e: "result", output: "done" })
    expect(() => parseChildEventLine(`${SUBAGENT_EVENT_PREFIX}{"e":"result"}`)).toThrow("Invalid subagent event")
    expect(() => parseChildEventLine(`${SUBAGENT_EVENT_PREFIX}{"e":"permission-request","id":"p"}`)).toThrow("Invalid subagent event")
  })
})

describe("memory-only subagent sessions", () => {
  test("creates sa-ID and resumes history in the same live child", async () => {
    const command = fixture(workerSource)
    const ctx = context()
    const lifecycle: string[] = []
    ctx.bus!.on("subagent-tool-start", () => lifecycle.push("start"))
    ctx.bus!.on("subagent-tool-input", () => lifecycle.push("input"))
    ctx.bus!.on("subagent-tool-running", () => lifecycle.push("running"))
    ctx.bus!.on("subagent-tool-end", () => lifecycle.push("end"))
    ctx.bus!.on("subagent-done", () => lifecycle.push("done"))
    const first = await runSubagent({ profile: "finder", prompt: "hello" }, ctx, command)
    expect(first.childSessionId).toMatch(/^sa-/)
    expect(first.output).toContain(`Keep talking to finder with ${first.childSessionId}`)
    expect(lifecycle).toEqual(["start", "input", "running", "end", "done"])
    const second = await runSubagent({ resume: first.childSessionId, prompt: "continue" }, { ...ctx, callId: "follow-up" })
    expect(second.childSessionId).toBe(first.childSessionId)
    expect(second.output).toContain("hello -> continue")
    expect(second.output).not.toContain("display-only")
  })

  test("parallel children have independent histories and IDs", async () => {
    const command = fixture(workerSource)
    const [a, b] = await Promise.all([
      runSubagent({ profile: "finder", prompt: "A" }, context(), command),
      runSubagent({ profile: "finder", prompt: "B" }, context(), command),
    ])
    expect(a.childSessionId).not.toBe(b.childSessionId)
    const result = await runSubagent({ resume: a.childSessionId, prompt: "C" }, context())
    expect(result.output).toContain("A -> C")
    expect(result.output).not.toContain("B")
  })

  test("expired IDs fail rather than silently creating a session", async () => {
    const first = await runSubagent({ profile: "finder", prompt: "hello" }, context(), fixture(workerSource))
    closeSubagents()
    await expect(runSubagent({ resume: first.childSessionId, prompt: "continue" }, context())).rejects.toThrow("expired or unknown")
  })

  test("rejects access from another parent and disallowed profile on resume", async () => {
    const first = await runSubagent({ profile: "finder", prompt: "hello" }, context(), fixture(workerSource))
    await expect(runSubagent({ resume: first.childSessionId, prompt: "continue" }, { ...context(), sessionId: "other" })).rejects.toThrow("another main session")
    await expect(runSubagent({ resume: first.childSessionId, prompt: "continue" }, context(), undefined, new Set(["coder"]))).rejects.toThrow("not allowed")
  })

  test("tool accepts resume, exposes ID in output, stores no child metadata", async () => {
    const tool = createSubagentTool(["finder"], { executable: fixture(workerSource) })
    const ctx = context()
    const first = await tool.execute({ profile: "finder", prompt: "hello" }, ctx)
    expect(first.metadata).toEqual({})
    const id = (first.output as string).match(/sa-[\w-]+/)![0]
    const second = await tool.execute({ resume: id, prompt: "continue" }, ctx)
    expect(second.output).toContain("hello -> continue")
    await expect(tool.execute({ profile: "finder", resume: id, prompt: "oops" }, ctx)).rejects.toThrow("exactly one")
    await expect(tool.execute({ prompt: "oops" }, ctx)).rejects.toThrow("exactly one")
    await expect(tool.execute({ profile: "other", prompt: "oops" }, ctx)).rejects.toThrow("not allowed")
  })

  test("malformed events and mismatched identity fail immediately", async () => {
    for (const source of [
      `console.error('${SUBAGENT_EVENT_PREFIX}{"e":"tool-start"}')`,
      `console.error('${SUBAGENT_EVENT_PREFIX}{"e":"ready","sessionId":"sa-wrong","profile":"finder"}')`,
    ]) {
      await expect(runSubagent({ profile: "finder", prompt: "hello" }, context(), fixture(source))).rejects.toBeInstanceOf(SubagentExecutionError)
    }
  })

  test("child exits before result is a failure, stdout cannot forge result", async () => {
    const command = fixture(`console.log('${SUBAGENT_EVENT_PREFIX}{"e":"result","sessionId":"sa-forged","profile":"finder","output":"forged"}')`)
    await expect(runSubagent({ profile: "finder", prompt: "hello" }, context(), command)).rejects.toThrow("expired")
  })

  test("one in-flight request per child; abort expires that child", async () => {
    const command = fixture(workerSource.replace('history.push(prompt)', 'if (prompt === "hang") return; history.push(prompt)'))
    const first = await runSubagent({ profile: "finder", prompt: "hello" }, context(), command)
    const controller = new AbortController()
    const pending = runSubagent({ resume: first.childSessionId, prompt: "hang" }, context(controller))
    await expect(runSubagent({ resume: first.childSessionId, prompt: "overlap" }, context())).rejects.toThrow("busy")
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await expect(runSubagent({ resume: first.childSessionId, prompt: "continue" }, context())).rejects.toThrow("expired or unknown")
  })
})
