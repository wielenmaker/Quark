import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { BUNDLED_PROVIDER_DEFINITIONS as definitions } from "../../packages/runner/src/provider/definitions"
import { encodeFastMode, withFastMode } from "../../packages/runner/src/provider/fast-mode"
import { createCodexConsumer } from "../../packages/runner/src/provider/codex-consumer"

describe("fast processing options", () => {
  test("maps true, false and omitted without replacing reasoning", () => {
    for (const definition of [definitions.openai, definitions["openai-codex"]]) {
      const key = definition.providerOptionsKey
      expect(encodeFastMode(definition)).toBeUndefined()
      expect(encodeFastMode(definition, true)).toEqual({ [key]: { serviceTier: "priority" } })
      expect(encodeFastMode(definition, false)).toEqual({ [key]: { serviceTier: "default" } })
      expect(withFastMode(definition, { [key]: { reasoningEffort: "high" } }, true))
        .toEqual({ [key]: { reasoningEffort: "high", serviceTier: "priority" } })
    }
  })
  test("rejects unsupported providers rather than silently ignoring", () => {
    expect(() => encodeFastMode(definitions.anthropic, true)).toThrow("not supported")
    expect(encodeFastMode(definitions.anthropic)).toBeUndefined()
  })
  test("Codex rejects an invalid service tier before making a request", async () => {
    let requested = false
    const model = createCodexConsumer({ modelId: "gpt-5.5", jwt: "test", accountId: "test", fetch: async () => {
      requested = true
      throw new Error("unexpected request")
    } })
    await expect(model.doStream({ prompt: [], providerOptions: { codex: { serviceTier: "invalid" } } })).rejects.toThrow("serviceTier")
    expect(requested).toBe(false)
  })
  for (const modelId of ["gpt-5.5", "gpt-5.6-luna"]) {
    for (const enabled of [true, false, undefined]) {
      test(`Codex ${modelId} forwards ${enabled} in legacy and Lite bodies`, async () => {
        let body: Record<string, unknown> = {}
        const model = createCodexConsumer({ modelId, jwt: "test", accountId: "test", fetch: async (_url, init) => {
          body = JSON.parse(init!.body as string)
          return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n')
        } })
        const result = await model.doStream({ prompt: [], providerOptions: encodeFastMode(definitions["openai-codex"], enabled) })
        await result.stream.pipeTo(new WritableStream())
        expect(body.service_tier).toBe(enabled === undefined ? undefined : enabled ? "priority" : "default")
      })
    }
  }
  for (const enabled of [true, false, undefined]) {
    test(`OpenAI SDK serializes tier ${enabled}`, async () => {
      let body: Record<string, unknown> = {}
      const model = createOpenAI({ apiKey: "test", fetch: async (_url, init) => {
        body = JSON.parse(init!.body as string)
        return new Response('data: {"type":"response.completed","response":{"id":"r","created_at":0,"model":"gpt-5.5","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n', { headers: { "content-type": "text/event-stream" } })
      } }).responses("gpt-5.5")
      const result = await model.doStream({ prompt: [], providerOptions: encodeFastMode(definitions.openai, enabled) })
      await result.stream.pipeTo(new WritableStream())
      expect(body.service_tier).toBe(enabled === undefined ? undefined : enabled ? "priority" : "default")
    })
  }
})
