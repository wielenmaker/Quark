/**
 * Integration tests for Copilot provider.
 *
 * These tests hit real GitHub/Copilot endpoints and require a valid token.
 * They are SKIPPED by default. To run them:
 *
 *   COPILOT_TEST=1 COPILOT_TOKEN=<your-token> bun test test/provider/copilot-integration.test.ts
 *
 * How to get a token:
 *   1. Run: bun run scripts/auth/copilot-login.ts
 *   2. Complete the OAuth flow in your browser
 *   3. Copy the printed token
 *
 * Or use an existing GitHub token with Copilot access (e.g. from gh auth):
 *   COPILOT_TEST=1 COPILOT_TOKEN=$(gh auth token) bun test test/provider/copilot-integration.test.ts
 */

import { describe, test, expect } from "bun:test"
import { createCopilotFetch } from "../../src/provider/copilot-fetch"
import { createCopilotProvider, getModel, shouldUseResponsesApi } from "../../src/provider/provider"

const ENABLED = process.env.COPILOT_TEST === "1"
const TOKEN = process.env.COPILOT_TOKEN ?? ""
const BASE_URL = process.env.COPILOT_BASE_URL ?? "https://api.githubcopilot.com"

const skip = !ENABLED

// ---------------------------------------------------------------------------
// Copilot fetch wrapper — real requests
// ---------------------------------------------------------------------------
describe.skipIf(skip)("integration: copilot-fetch", () => {
  test("can list models from Copilot API", async () => {
    const copilotFetch = createCopilotFetch({
      getToken: async () => TOKEN,
    })

    const response = await copilotFetch(`${BASE_URL}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })

    expect(response.ok).toBe(true)
    const data = (await response.json()) as { data?: Array<{ id: string }> }
    expect(data.data).toBeDefined()
    expect(data.data!.length).toBeGreaterThan(0)

    // Verify we got real model IDs
    const ids = data.data!.map((m) => m.id)
    console.log(`  Found ${ids.length} models: ${ids.slice(0, 5).join(", ")}...`)

    // gpt-4o should always be available
    expect(ids.some((id) => id.includes("gpt-4o"))).toBe(true)
  })

  test("can make a chat/completions request", async () => {
    const copilotFetch = createCopilotFetch({
      getToken: async () => TOKEN,
    })

    const response = await copilotFetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Reply with just the word 'pong'." }],
        max_tokens: 10,
      }),
    })

    expect(response.ok).toBe(true)
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    expect(data.choices).toBeDefined()
    expect(data.choices!.length).toBeGreaterThan(0)
    const reply = data.choices![0]!.message?.content ?? ""
    console.log(`  LLM replied: "${reply}"`)
    expect(reply.toLowerCase()).toContain("pong")
  })
})

// ---------------------------------------------------------------------------
// Provider + AI SDK — real requests through @ai-sdk/openai
// ---------------------------------------------------------------------------
describe.skipIf(skip)("integration: provider with AI SDK", () => {
  test("creates a provider that can be used with getModel", () => {
    const provider = createCopilotProvider({
      getToken: async () => TOKEN,
      baseURL: BASE_URL,
    })

    // Chat model
    const chatModel = getModel(provider, "gpt-4o")
    expect(chatModel).toBeDefined()
    expect(chatModel.modelId).toBe("gpt-4o")

    // Responses model (if GPT-5 is available)
    if (shouldUseResponsesApi("gpt-5")) {
      const respModel = getModel(provider, "gpt-5")
      expect(respModel).toBeDefined()
      expect(respModel.modelId).toBe("gpt-5")
    }
  })

  // This test actually calls the LLM through the AI SDK
  test("can call generateText with Copilot provider", async () => {
    // Dynamic import to avoid issues if ai package isn't available
    const { generateText } = await import("ai")

    const provider = createCopilotProvider({
      getToken: async () => TOKEN,
      baseURL: BASE_URL,
    })

    const model = getModel(provider, "gpt-4o")

    const result = await generateText({
      model,
      prompt: "Reply with just the word 'atom'.",
      maxOutputTokens: 10,
    })

    console.log(`  AI SDK response: "${result.text}"`)
    expect(result.text.toLowerCase()).toContain("atom")
  })
})

// ---------------------------------------------------------------------------
// OAuth device flow — real request to get device code only (no polling)
// ---------------------------------------------------------------------------
describe.skipIf(skip)("integration: oauth device flow", () => {
  test("can request a device code from GitHub", async () => {
    const { requestDeviceCode } = await import("../../src/provider/copilot-auth")

    const device = await requestDeviceCode({ domain: "github.com" })

    expect(device.device_code).toBeDefined()
    expect(device.user_code).toBeDefined()
    expect(device.verification_uri).toContain("github.com")
    expect(device.interval).toBeGreaterThan(0)

    console.log(`  Device code received: ${device.user_code}`)
    console.log(`  Verification URI: ${device.verification_uri}`)
    // We don't complete the flow here — that requires browser interaction
  })
})
