// Portable AgentDefinition runs must not consult implicit Quark config.
//
// QUARK_CONFIG_DIR points at a poisoned config whose legacy `version: 1` makes
// loadConfig() throw. Any reintroduced config.yaml read on the portable path
// turns these runs into an observable failure.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineAgent } from "../../packages/runner/src/agent"
import { createRunner } from "../../packages/runner/src/runner"
import { resetConfigCache } from "../../packages/quark/src/config/config"
import { createSession, getSession } from "../../packages/runner/src/session/session"
import { ensureStorageRoot } from "../../packages/runner/src/storage/session-jsonl"
import { setSessionStorageRoot } from "../../packages/runner/src/storage/session-path"
import type { StreamFn } from "../../packages/runner/src/session/processor"
import { CatalogRegistry } from "../../packages/runner/src/provider/catalog-registry"
import { createCatalogSnapshot } from "../../packages/runner/src/provider/catalog-snapshot"

const MODEL = "ollama/test-model"

let configDir: string
let storageRoot: string
const originalConfigDir = process.env.QUARK_CONFIG_DIR

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "quark-poison-config-"))
  // Version 1 always fails parseConfigV3, so reading this file cannot be silent.
  writeFileSync(join(configDir, "config.yaml"), [
    "version: 1",
    "models:",
    "  small: poisoned/does-not-exist",
    "max_steps: 0",
    "branching:",
    "  auto: true",
    "  threshold: 0.0001",
    "providers: {}",
    "",
  ].join("\n"))
  process.env.QUARK_CONFIG_DIR = configDir
  resetConfigCache()

  storageRoot = mkdtempSync(join(tmpdir(), "quark-portable-storage-"))
  setSessionStorageRoot(storageRoot)
  ensureStorageRoot()
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.QUARK_CONFIG_DIR
  else process.env.QUARK_CONFIG_DIR = originalConfigDir
  resetConfigCache()
  setSessionStorageRoot(undefined)
  rmSync(storageRoot, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
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

function portableAgent() {
  return defineAgent({ id: "portable", instructions: "Portable instructions", tools: [], model: MODEL })
}

function stopStream(): { fullStream: AsyncIterable<any> } {
  return {
    fullStream: (async function* () {
      yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: "finish" }
    })(),
  }
}

const text = [{ type: "text" as const, text: "hello portable" }]

describe("createRunner + AgentDefinition with a poisoned config", () => {
  test("runs offline without reading config.yaml (max_steps, branching, title)", async () => {
    const calls: any[] = []
    const stream: StreamFn = (options) => {
      calls.push(options)
      return stopStream()
    }
    const runner = createRunner({ agent: portableAgent(), stream })
    const session = createSession()

    await runner.prompt({ sessionId: session.id, parts: text, catalog: catalog() })

    expect(calls).toHaveLength(1)
    const system = calls[0]!.messages
      .filter((m: any) => m.role === "system")
      .map((m: any) => m.content)
      .join("\n")
    expect(system).toContain("Portable instructions")
    // Poisoned small model was never resolved; the fallback title stands.
    // Portable runners persist to their own in-memory store, not the global one.
    expect(runner.store.get(session.id)!.title).toBe("hello portable")
    expect(getSession(session.id).title).toBeNull()
  })

  test("honors explicit RunnerOptions.policies.maxSteps", async () => {
    let calls = 0
    // Every step reports tool-calls, so only maxSteps can stop the loop.
    const stream: StreamFn = () => {
      calls++
      return {
        fullStream: (async function* () {
          yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
        })(),
      }
    }
    const runner = createRunner({ agent: portableAgent(), stream, policies: { maxSteps: 1 } })
    const session = createSession()

    await runner.prompt({ sessionId: session.id, parts: text, catalog: catalog() })

    expect(calls).toBe(1)
  })
})
