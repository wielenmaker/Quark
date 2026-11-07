import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { closeSubagents, runSubagent } from "../../packages/runner/src/subagent/supervisor"
import { SubagentCheckpoints } from "../../packages/quark/src/subagent-checkpoints"

const dirs: string[] = []
afterEach(() => {
  closeSubagents()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "quark-worker-"))
  dirs.push(dir)
  return dir
}

function workerFixture(): { command: string; args: string[]; dir: string } {
  const dir = directory()
  writeFileSync(join(dir, "config.yaml"), "version: 3\nmodels:\n  small: ollama/test\nmax_steps: 2\nproviders: {}\n")
  const file = join(dir, "worker.ts")
  const root = resolve("packages")
  writeFileSync(file, `
import { runSubagentWorker } from ${JSON.stringify(join(root, "quark/src/subagent-worker.ts"))}
import { createQuarkRuntime } from ${JSON.stringify(join(root, "quark/src/runtime.ts"))}
import { CatalogRegistry } from ${JSON.stringify(join(root, "runner/src/provider/catalog-registry.ts"))}
import { createCatalogSnapshot } from ${JSON.stringify(join(root, "runner/src/provider/catalog-snapshot.ts"))}
import { setSessionStorageRoot } from ${JSON.stringify(join(root, "runner/src/storage/session-path.ts"))}
process.env.QUARK_CONFIG_DIR = ${JSON.stringify(dir)}
setSessionStorageRoot(${JSON.stringify(join(dir, "sessions"))})
const catalog = new CatalogRegistry(createCatalogSnapshot({ ollama: {
  id: "ollama", name: "Ollama", npm: "@ollama/ai", env: ["OLLAMA_API_KEY"], doc: "https://example.com", models: {
    test: { id: "test", name: "Test", description: "Offline test", attachment: false, reasoning: false, tool_call: true,
      release_date: "2025-01-01", last_updated: "2025-01-01", modalities: {input:["text"],output:["text"]},
      open_weights: false, limit: {context:100000,output:4000} }
  }
}}, {fetchedAt:1}))
const stream = (options) => {
  const text = options.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("")).join(" -> ")
  return { fullStream: (async function* () {
    yield {type:"text-start",id:"text"}
    yield {type:"text-delta",id:"text",text}
    yield {type:"text-end",id:"text"}
    yield {type:"finish-step",finishReason:"stop",usage:{inputTokens:1,outputTokens:1}}
    yield {type:"finish"}
  })() }
}
await runSubagentWorker({
  agent: { id: "finder", instructions: "Test", tools: [], model: "ollama/test" }, profile: "finder", model: "ollama/test",
  createRuntime: async (options) => {
    const runtime = await createQuarkRuntime({...options,loadPlugins:async()=>({fns:[]}),runnerOptions:{stream}})
    return {...runtime,prompt:(input)=>runtime.prompt({...input,catalog})}
  }
})
`)
  return { command: process.execPath, args: [file], dir }
}

test("real worker retains conversation in MemorySessionStore and creates no session/checkpoint files", async () => {
  const fixture = workerFixture()
  const ctx = { sessionId: "parent", messageId: "message", callId: "call", abort: new AbortController().signal }
  const first = await runSubagent({ profile: "finder", prompt: "first" }, ctx, fixture)
  expect(first.output).toContain("first")
  expect(first.output).toContain(`Keep talking to finder with ${first.childSessionId}`)
  const second = await runSubagent({ resume: first.childSessionId, prompt: "second" }, ctx)
  expect(second.output).toContain("first -> second")
  expect(readdirSync(fixture.dir).sort()).toEqual(["config.yaml", "worker.ts"])
}, 15000)

test("worker exits on stdin EOF while idle", async () => {
  const fixture = workerFixture()
  const proc = spawn(fixture.command, fixture.args, { stdio: ["pipe", "pipe", "pipe"] })
  proc.stdout.resume()
  let stderr = ""
  await new Promise<void>((resolveReady, reject) => {
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
      if (stderr.includes('"e":"ready"')) resolveReady()
    })
    proc.once("error", reject)
    proc.once("close", () => reject(new Error(stderr)))
  })
  const closed = new Promise<number | null>((resolveClose) => proc.once("close", resolveClose))
  proc.stdin.end()
  expect(await closed).toBe(0)
}, 15000)

test("file checkpoints keep first pre-edit bytes and new-file markers in RAM", async () => {
  const dir = directory()
  const file = join(dir, "original.txt")
  const added = join(dir, "added.txt")
  writeFileSync(file, "before")
  const checkpoints = new SubagentCheckpoints(dir)
  checkpoints.begin("turn-1")
  await checkpoints.capture("edit", { filePath: "original.txt" })
  writeFileSync(file, "after")
  await checkpoints.capture("edit", { filePath: "original.txt" })
  await checkpoints.capture("write", { filePath: "added.txt" })
  writeFileSync(added, "new")
  expect(readdirSync(dir).sort()).toEqual(["added.txt", "original.txt"])
  await checkpoints.restore("turn-1")
  expect(await Bun.file(file).text()).toBe("before")
  expect(readdirSync(dir)).toEqual(["original.txt"])
  checkpoints.clear()
  await expect(checkpoints.restore("turn-1")).rejects.toThrow("not found")
})

test("checkpoint memory limit blocks edits before untracked mutation", async () => {
  const dir = directory()
  writeFileSync(join(dir, "large.txt"), "too large")
  const checkpoints = new SubagentCheckpoints(dir, 2)
  checkpoints.begin("turn")
  await expect(checkpoints.capture("edit", { filePath: "large.txt" })).rejects.toThrow("memory limit")
})
