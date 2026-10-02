import { expect, test } from "bun:test"
import { createRunner } from "../../packages/runner/src/runner"
import { CatalogRegistry } from "../../packages/runner/src/provider/catalog-registry"
import { createCatalogSnapshot } from "../../packages/runner/src/provider/catalog-snapshot"
import type { StreamFn } from "../../packages/runner/src/session/processor"

const catalog = new CatalogRegistry(createCatalogSnapshot({ openai: {
  id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], doc: "https://openai.com",
  models: Object.fromEntries(["gpt-5.5", "gpt-5.4"].map(id => [id, {
    id, name: id, description: "Offline test model", attachment: false, reasoning: false, tool_call: true,
    release_date: "2026-01-01", last_updated: "2026-01-01", modalities: { input: ["text"], output: ["text"] },
    open_weights: false, limit: { context: 100000, output: 4000 },
  }])),
} }, { fetchedAt: 1 }))

for (const fastMode of [true, false, undefined]) {
  test(`runner forwards fastMode ${fastMode} only for the profile model`, async () => {
    const captured: unknown[] = []
    const stream: StreamFn = options => {
      captured.push(options.providerOptions)
      return { fullStream: (async function* () {
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: "finish" }
      })() }
    }
    const runner = createRunner({
      agent: { id: "speed", model: "openai/gpt-5.5", fastMode, instructions: "Test", tools: [] },
      stream,
      resolve: { credentialStore: {
        get: async () => ({ type: "api-key", value: "test" }),
        set: async () => {}, delete: async () => {}, status: async () => "present",
      } },
    })
    await runner.prompt({ sessionId: `fast-${fastMode}`, parts: [{ type: "text", text: "hello" }], catalog })
    expect(captured[0]).toEqual(fastMode === undefined ? undefined : { openai: { serviceTier: fastMode ? "priority" : "default" } })
    await runner.prompt({ sessionId: `override-${fastMode}`, parts: [{ type: "text", text: "hello" }], model: "openai/gpt-5.4", catalog })
    expect(captured[1]).toBeUndefined()
  })
}
