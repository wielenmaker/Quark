// App runtime manager tests — the CLI/TUI's createRunner-backed execution path.
//
// Proves the legacy app behavior is adapted explicitly into createRunner
// options:
//   - ambient AGENTS.md reads (portable runners default to none)
//   - config-derived max steps (portable policies otherwise ignore config.yaml)
//   - persistent sessions via an explicit store (portable default is memory)
// and that rebinding swaps the runner on a stable bus, and seeded turns run
// through the same runner.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createQuarkRuntime } from "../../packages/quark/src/runtime"
import { defineAgent, type AgentDefinition } from "../../packages/runner/src/agent"
import { MemorySessionStore } from "../../packages/runner/src/session/store"
import {
  createSession,
  defaultSessionStore,
  getSession,
  setSessionTitle,
} from "../../packages/runner/src/session/session"
import { saveUserMessage } from "../../packages/runner/src/session/message"
import { TypedBus } from "../../packages/runner/src/session/events"
import { CatalogRegistry } from "../../packages/runner/src/provider/catalog-registry"
import { createCatalogSnapshot } from "../../packages/runner/src/provider/catalog-snapshot"
import { resetConfigCache } from "../../packages/quark/src/config/config"
import { setSessionStorageRoot } from "../../packages/runner/src/storage/session-path"
import { globalHooks } from "../../packages/runner/src/plugin/registry"
import type { StreamFn } from "../../packages/runner/src/session/processor"
import type { RunnerExecute } from "../../packages/runner/src/runner"

const MODEL = "ollama/test-model"
const PROJECT_POISON = "POISON_PROJECT_AGENTS"
const GLOBAL_POISON = "POISON_GLOBAL_AGENTS"

let configDir: string
let projectDir: string
let storageRoot: string
const originalCwd = process.cwd()
const originalConfigDir = process.env.QUARK_CONFIG_DIR

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "quark-runtime-config-"))
  projectDir = mkdtempSync(join(tmpdir(), "quark-runtime-project-"))
  storageRoot = mkdtempSync(join(tmpdir(), "quark-runtime-storage-"))

  // max_steps: 1 keeps the config-adaptation test to a single model call.
  writeFileSync(join(configDir, "config.yaml"), [
    "version: 3",
    "models:",
    `  small: ${MODEL}`,
    "max_steps: 1",
    "branching:",
    "  auto: false",
    "  threshold: 0.9",
    "providers: {}",
    "",
  ].join("\n"))
  writeFileSync(join(configDir, "AGENTS.md"), `# global\n\n${GLOBAL_POISON}\n`)
  writeFileSync(join(projectDir, "AGENTS.md"), `# project\n\n${PROJECT_POISON}\n`)

  process.chdir(projectDir)
  process.env.QUARK_CONFIG_DIR = configDir
  resetConfigCache()
  setSessionStorageRoot(storageRoot)
})

afterAll(() => {
  process.chdir(originalCwd)
  if (originalConfigDir === undefined) delete process.env.QUARK_CONFIG_DIR
  else process.env.QUARK_CONFIG_DIR = originalConfigDir
  resetConfigCache()
  setSessionStorageRoot(undefined)
  rmSync(configDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(storageRoot, { recursive: true, force: true })
})

function catalog(): CatalogRegistry {
  return new CatalogRegistry(createCatalogSnapshot({
    ollama: {
      id: "ollama",
      name: "Ollama",
      npm: "@ollama/ai",
      env: ["OLLAMA_API_KEY"],
      doc: "https://ollama.example/docs",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          description: "offline test model",
          attachment: false,
          reasoning: false,
          tool_call: true,
          release_date: "2025-01-01",
          last_updated: "2025-01-01",
          modalities: { input: ["text"], output: ["text"] },
          open_weights: false,
          limit: { context: 100_000, output: 4_000 },
        },
      },
    },
  }, { fetchedAt: 1 }))
}

function captureStream(finishReason: "stop" | "tool-calls" = "stop") {
  const systems: string[] = []
  let calls = 0
  const stream: StreamFn = (options) => {
    calls++
    systems.push(
      (options.messages as any[])
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n"),
    )
    return {
      fullStream: (async function* () {
        yield { type: "finish-step", finishReason, usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: "finish" }
      })(),
    }
  }
  return { systems, stream, get calls() { return calls } }
}

function agent(id: string): AgentDefinition {
  return defineAgent({ id, instructions: `${id} instructions`, tools: [], model: MODEL })
}

function memoryRuntime(runnerOptions: { stream: StreamFn }, bus = new TypedBus(), store = new MemorySessionStore()) {
  return createQuarkRuntime({
    agent: agent("runtime-a"),
    bus,
    store,
    loadPlugins: async () => ({ fns: [] }),
    runnerOptions,
  })
}

const text = [{ type: "text" as const, text: "hello" }]

describe("createQuarkRuntime — legacy adaptation and persistence", () => {
  test("prompt runs on its shared bus, reads ambient AGENTS.md, and persists to the explicit store", async () => {
    const cap = captureStream()
    const bus = new TypedBus()
    const store = new MemorySessionStore()
    const events: string[] = []
    bus.on("user-message", () => events.push("user-message"))
    bus.on("loop-start", () => events.push("loop-start"))
    bus.on("loop-end", () => events.push("loop-end"))

    const runtime = await memoryRuntime({ stream: cap.stream }, bus, store)
    const session = createSession(undefined, store)
    setSessionTitle(session.id, "titled", store)

    const { sessionId } = await runtime.prompt({ sessionId: session.id, parts: text, catalog: catalog() })

    expect(sessionId).toBe(session.id)
    expect(events).toContain("user-message")
    expect(events).toContain("loop-start")
    expect(events).toContain("loop-end")

    // Ambient adaptation: portable runners default to none, the app's builder
    // restores the legacy global + project AGENTS.md reads.
    expect(cap.systems[0]).toContain(PROJECT_POISON)
    expect(cap.systems[0]).toContain(GLOBAL_POISON)
    expect(cap.systems[0]).toContain("runtime-a instructions")

    // Explicit store, not the process-global JSONL store.
    expect(store.get(sessionId)?.id).toBe(sessionId)
    expect(defaultSessionStore.get(sessionId)).toBeNull()
    expect(() => getSession(sessionId)).toThrow(/not found/)
  })

  test("config-derived max_steps stops a tool-calling loop after one step", async () => {
    const cap = captureStream("tool-calls")
    const store = new MemorySessionStore()
    const runtime = await memoryRuntime({ stream: cap.stream }, new TypedBus(), store)
    const session = createSession(undefined, store)
    setSessionTitle(session.id, "titled", store)

    await runtime.prompt({ sessionId: session.id, parts: text, catalog: catalog() })

    // Portable policies default to maxSteps: 100; the config adaptation caps it at 1.
    expect(cap.calls).toBe(1)
  })

  test("rebind swaps the bound agent on the same bus and never reuses the old runner", async () => {
    const cap = captureStream()
    const bus = new TypedBus()
    const store = new MemorySessionStore()
    const runtime = await memoryRuntime({ stream: cap.stream }, bus, store)

    const first = createSession(undefined, store)
    setSessionTitle(first.id, "a", store)
    await runtime.prompt({ sessionId: first.id, parts: text, catalog: catalog() })
    expect(cap.systems.at(-1)).toContain("runtime-a instructions")

    const firstRunner = runtime.runner
    await runtime.rebind(agent("runtime-b"))

    expect(runtime.bus).toBe(bus)
    expect(runtime.runner).not.toBe(firstRunner)
    expect(runtime.agent.id).toBe("runtime-b")

    const second = createSession(undefined, store)
    setSessionTitle(second.id, "b", store)
    await runtime.prompt({ sessionId: second.id, parts: text, catalog: catalog() })
    expect(cap.systems.at(-1)).toContain("runtime-b instructions")
    expect(cap.systems.at(-1)).not.toContain("runtime-a instructions")
  })

  test("seed runs an already-persisted user message through the runner", async () => {
    const cap = captureStream()
    const bus = new TypedBus()
    const store = new MemorySessionStore()
    const runtime = await memoryRuntime({ stream: cap.stream }, bus, store)

    const session = createSession(undefined, store)
    setSessionTitle(session.id, "seeded", store)
    const user = saveUserMessage({ sessionId: session.id, text: "steer this", store })

    const events: string[] = []
    bus.on("loop-start", () => events.push("loop-start"))
    bus.on("loop-end", () => events.push("loop-end"))

    const result = await runtime.seed({
      sessionId: session.id,
      userMessageId: user.id,
      userText: "steer this",
      catalog: catalog(),
    })

    expect(result.sessionId).toBe(session.id)
    expect(events).toEqual(["loop-start", "loop-end"])
    expect(cap.calls).toBe(1)
    // The seeded turn was not duplicated as a new user message.
    const { messages } = runtime.runner.store.replay(session.id)
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1)
  })

  test("rebind keeps one stable bus and never duplicates long-lived subscriptions", async () => {
    const cap = captureStream()
    const bus = new TypedBus()
    const store = new MemorySessionStore()
    const runtime = await memoryRuntime({ stream: cap.stream }, bus, store)
    const loops: string[] = []
    bus.on("loop-start", ({ sessionId }) => loops.push(sessionId))

    const first = createSession(undefined, store)
    setSessionTitle(first.id, "a", store)
    await runtime.prompt({ sessionId: first.id, parts: text, catalog: catalog() })

    await runtime.rebind(agent("runtime-b"))
    expect(runtime.bus).toBe(bus)

    const second = createSession(undefined, store)
    setSessionTitle(second.id, "b", store)
    await runtime.prompt({ sessionId: second.id, parts: text, catalog: catalog() })

    // One subscription, one delivery per run: a per-generation listener would
    // have delivered the second loop twice.
    expect(loops).toEqual([first.id, second.id])
  })

  test("defaults to the persistent JSONL store; an explicit store option overrides it", async () => {
    const runtime = await createQuarkRuntime({
      agent: agent("store-default"),
      bus: new TypedBus(),
      loadPlugins: async () => ({ fns: [] }),
    })

    // Portable runners default to an in-memory store; the app adaptation must
    // keep the legacy persistent JSONL store.
    expect(runtime.runner.store).toBe(defaultSessionStore)
    expect(runtime.runner.store).not.toBeInstanceOf(MemorySessionStore)

    const custom = new MemorySessionStore()
    const overridden = await createQuarkRuntime({
      agent: agent("store-explicit"),
      bus: new TypedBus(),
      store: custom,
      loadPlugins: async () => ({ fns: [] }),
    })
    expect(overridden.runner.store).toBe(custom)
  })

  test("loadPlugins seam adapts plugins into the runner's isolated hooks, not the global registry", async () => {
    const cap = captureStream()
    const store = new MemorySessionStore()
    const steps: number[] = []
    let loads = 0
    const loadPlugins = async () => {
      loads++
      return {
        fns: [async () => ({
          "loop.step.before": async ({ step }: { step: number }) => { steps.push(step) },
        })],
      }
    }

    const runtime = await createQuarkRuntime({
      agent: agent("plug-a"),
      bus: new TypedBus(),
      store,
      loadPlugins,
      runnerOptions: { stream: cap.stream },
    })
    expect(loads).toBe(1)

    // Firing the global registry must not reach the runner's private hooks.
    await globalHooks.fire("loop.step.before", { sessionId: "s", step: 99 })

    const first = createSession(undefined, store)
    setSessionTitle(first.id, "a", store)
    await runtime.prompt({ sessionId: first.id, parts: text, catalog: catalog() })
    expect(steps).toEqual([1])

    // Rebind reloads filesystem plugins for the new runner generation.
    await runtime.rebind(agent("plug-b"))
    expect(loads).toBe(2)

    const second = createSession(undefined, store)
    setSessionTitle(second.id, "b", store)
    await runtime.prompt({ sessionId: second.id, parts: text, catalog: catalog() })
    expect(steps).toEqual([1, 1])
  })

  test("prompt/seed/cancel/isActive delegate to the current runner generation", async () => {
    const seenAgents: string[] = []
    const seenPolicies: Array<{ smallModel?: string | null } | undefined> = []
    const execute: RunnerExecute = async (input, ctx) => {
      seenAgents.push(ctx.agent.id)
      seenPolicies.push(input.policies)
      return { sessionId: input.sessionId ?? "generated" }
    }
    const store = new MemorySessionStore()
    const runtime = await createQuarkRuntime({
      agent: agent("delegate-a"),
      bus: new TypedBus(),
      store,
      loadPlugins: async () => ({ fns: [] }),
      runnerOptions: { execute },
    })

    await runtime.prompt({ sessionId: "s1", parts: text })
    expect(seenAgents).toEqual(["delegate-a"])
    // Config-derived small model is merged into the per-call policies.
    expect(seenPolicies.at(-1)?.smallModel).toBe(MODEL)

    await runtime.rebind(agent("delegate-b"))
    await runtime.prompt({ sessionId: "s2", parts: text, model: "openai/x" })
    expect(seenAgents.at(-1)).toBe("delegate-b")
    // A per-call model wins over the config-derived small model.
    expect(seenPolicies.at(-1)?.smallModel).toBe("openai/x")
  })

  test("rebind refuses while a run is active and leaves it cancellable", async () => {
    let aborted = false
    const execute: RunnerExecute = (_input, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true
          resolve({ sessionId: "s" })
        })
      })
    const runtime = await createQuarkRuntime({
      agent: agent("busy-a"),
      bus: new TypedBus(),
      store: new MemorySessionStore(),
      loadPlugins: async () => ({ fns: [] }),
      runnerOptions: { execute },
    })

    const firstRunner = runtime.runner
    const run = runtime.prompt({ sessionId: "s", parts: text })
    expect(runtime.isBusy()).toBe(true)

    await expect(runtime.rebind(agent("busy-b"))).rejects.toThrow(/active/i)
    expect(() => runtime.retarget(agent("busy-b"))).toThrow(/active/i)
    // The refused swap left the runner and its run untouched.
    expect(runtime.runner).toBe(firstRunner)
    expect(runtime.agent.id).toBe("busy-a")
    expect(runtime.isActive("s")).toBe(true)

    runtime.cancel("s")
    await run
    expect(aborted).toBe(true)
    expect(runtime.isBusy()).toBe(false)

    // Idle again: the swap now goes through.
    await runtime.rebind(agent("busy-b"))
    expect(runtime.agent.id).toBe("busy-b")
  })

  test("cancel/isActive cover a seeded turn's own controller", async () => {
    const hanging: StreamFn = () => ({
      fullStream: (async function* () {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: "finish" }
      })(),
    })
    const store = new MemorySessionStore()
    const runtime = await memoryRuntime({ stream: hanging }, new TypedBus(), store)

    const session = createSession(undefined, store)
    setSessionTitle(session.id, "titled", store)
    const user = saveUserMessage({ sessionId: session.id, text: "steer this", store })

    const run = runtime.seed({ sessionId: session.id, userMessageId: user.id, userText: "steer this", catalog: catalog() })
    expect(runtime.isActive(session.id)).toBe(true)
    runtime.cancel(session.id)
    expect(runtime.isActive(session.id)).toBe(false)
    await run.catch(() => {})
    expect(runtime.isActive(session.id)).toBe(false)
  })
})
